import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getConfig, saveConfig } from "@/lib/onboarding/config-repository";
import { ONBOARDING_LIBRARY, ONBOARDING_LIBRARY_BY_KEY } from "@/lib/onboarding/library";
import type {
  CustomQuestion,
  OnboardingCategory,
  OnboardingConfig,
  OnboardingFieldOption,
  OnboardingFieldType,
} from "@/lib/onboarding/types";

export const dynamic = "force-dynamic";

// Manage the per-practice onboarding form config. Both methods are requireUser +
// requireClientAccess (owner OR coordinator may manage it; no owner-only gate). The
// PUBLIC form does NOT read through here — it loads the config server-side via
// getConfig and resolves the steps. This route is the builder's read/write surface.
//
//   GET  ?client=<slug>            -> { ok, config, library }  (config may be null)
//   PUT  { clientSlug, config }    -> validate + saveConfig    -> { ok }

const MAX_CUSTOM = 15;
const MAX_LABEL_LEN = 120;
const MAX_OPTIONS = 12;
const MAX_OPTION_LEN = 80;

const VALID_TYPES: ReadonlySet<OnboardingFieldType> = new Set([
  "text",
  "email",
  "tel",
  "date",
  "textarea",
  "select",
  "yesno",
  "consent",
]);
// Custom questions never carry a consent control — consent is handled by the form's
// own dedicated screen, so we don't let a practice mint one as a question.
const VALID_CUSTOM_TYPES: ReadonlySet<OnboardingFieldType> = new Set([
  "text",
  "email",
  "tel",
  "date",
  "textarea",
  "select",
  "yesno",
]);
const VALID_CATEGORIES: ReadonlySet<OnboardingCategory> = new Set([
  "personal",
  "contact",
  "address",
  "medical",
  "dental",
  "preferences",
  "marketing",
]);

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

/** Validate the options array for a select/yesno custom question. */
function parseOptions(raw: unknown): OnboardingFieldOption[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_OPTIONS) return null;
  const out: OnboardingFieldOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    const value = str(e.value, MAX_OPTION_LEN);
    const label = str(e.label, MAX_OPTION_LEN);
    if (!value || !label) return null;
    if (seen.has(value)) return null; // option values must be unique
    seen.add(value);
    out.push({ value, label });
  }
  return out;
}

/**
 * Validate the whole posted config shape. Returns a cleaned OnboardingConfig or an
 * error string. Untrusted input: keep ONLY known library keys, well-formed custom
 * questions, and required overrides for known requirable library keys.
 */
function parseConfig(raw: unknown): { ok: true; config: OnboardingConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config must be an object" };
  }
  const c = raw as Record<string, unknown>;

  // enabledKeys: must be known library keys. Dedupe, drop the rest.
  const rawEnabled = Array.isArray(c.enabledKeys) ? c.enabledKeys : [];
  const enabledKeys: string[] = [];
  const seenEnabled = new Set<string>();
  for (const k of rawEnabled) {
    if (typeof k !== "string") return { ok: false, error: "enabledKeys must be strings" };
    if (!(k in ONBOARDING_LIBRARY_BY_KEY)) {
      return { ok: false, error: `Unknown library question: ${k.slice(0, 60)}` };
    }
    if (!seenEnabled.has(k)) {
      seenEnabled.add(k);
      enabledKeys.push(k);
    }
  }

  // required: overrides for requirable library keys only.
  const required: Record<string, boolean> = {};
  const rawRequired = c.required;
  if (rawRequired !== undefined && rawRequired !== null) {
    if (typeof rawRequired !== "object" || Array.isArray(rawRequired)) {
      return { ok: false, error: "required must be an object" };
    }
    for (const [key, val] of Object.entries(rawRequired as Record<string, unknown>)) {
      const lib = ONBOARDING_LIBRARY_BY_KEY[key];
      if (!lib) return { ok: false, error: `Unknown required key: ${key.slice(0, 60)}` };
      if (typeof val !== "boolean") return { ok: false, error: "required values must be booleans" };
      // Only keep overrides for questions that can actually be required.
      if (lib.requirable) required[key] = val;
    }
  }

  // custom: well-formed, capped, keys prefixed custom- and unique.
  const rawCustom = c.custom;
  const custom: CustomQuestion[] = [];
  if (rawCustom !== undefined && rawCustom !== null) {
    if (!Array.isArray(rawCustom)) return { ok: false, error: "custom must be an array" };
    if (rawCustom.length > MAX_CUSTOM) {
      return { ok: false, error: `You can add up to ${MAX_CUSTOM} custom questions` };
    }
    const seenKeys = new Set<string>();
    for (const entry of rawCustom) {
      if (!entry || typeof entry !== "object") return { ok: false, error: "custom questions must be objects" };
      const e = entry as Record<string, unknown>;

      const key = str(e.key, 80);
      if (!key || !/^custom-[a-z0-9-]+$/.test(key)) {
        return { ok: false, error: "each custom question needs a valid custom- key" };
      }
      if (key in ONBOARDING_LIBRARY_BY_KEY) {
        return { ok: false, error: "a custom key cannot collide with a library key" };
      }
      if (seenKeys.has(key)) return { ok: false, error: "custom question keys must be unique" };
      seenKeys.add(key);

      const label = str(e.label, MAX_LABEL_LEN);
      if (!label) return { ok: false, error: "each custom question needs a label" };

      const type = typeof e.type === "string" ? (e.type as OnboardingFieldType) : undefined;
      if (!type || !VALID_TYPES.has(type) || !VALID_CUSTOM_TYPES.has(type)) {
        return { ok: false, error: "each custom question needs a valid type" };
      }

      const category = typeof e.category === "string" ? (e.category as OnboardingCategory) : undefined;
      if (!category || !VALID_CATEGORIES.has(category)) {
        return { ok: false, error: "each custom question needs a valid category" };
      }

      let options: OnboardingFieldOption[] | undefined;
      if (type === "select") {
        const parsed = parseOptions(e.options);
        if (!parsed) return { ok: false, error: "a select question needs valid options" };
        options = parsed;
      }

      custom.push({
        key,
        label,
        type,
        options,
        required: e.required === true,
        category,
      });
    }
  }

  return { ok: true, config: { enabledKeys, required, custom } };
}

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // Onboarding is outside CLINICIAN_SLUGS: reviewing and registering new-patient
  // submissions (contact details, medical intake, uploaded documents, consent) is
  // reception work, and requireClientAccess admits every role attached to the client.
  const moduleDenied = requireModuleApiAccess(auth, "onboarding");
  if (moduleDenied) return moduleDenied;

  const config = await getConfig(client.id);
  return Response.json({ ok: true, config, library: ONBOARDING_LIBRARY });
}

export async function PUT(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const clientSlug = str(body.clientSlug, 60) ?? new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // Onboarding is outside CLINICIAN_SLUGS: reviewing and registering new-patient
  // submissions (contact details, medical intake, uploaded documents, consent) is
  // reception work, and requireClientAccess admits every role attached to the client.
  const moduleDenied = requireModuleApiAccess(auth, "onboarding");
  if (moduleDenied) return moduleDenied;

  const parsed = parseConfig(body.config);
  if (!parsed.ok) return bad(parsed.error);

  try {
    await saveConfig(client.id, parsed.config);
    return Response.json({ ok: true });
  } catch {
    return bad("could not save the form configuration", 500);
  }
}
