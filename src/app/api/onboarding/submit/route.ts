import { getClient, getSites } from "@/lib/mock/clients";
import { parseSubmission } from "@/lib/onboarding/validate";
import { getConfig } from "@/lib/onboarding/config-repository";
import { getActiveFormBySlug } from "@/lib/onboarding/form-repository";
import { resolveSteps } from "@/lib/onboarding/resolve";
import { createSubmission } from "@/lib/onboarding/repository";
import { consumeBudget } from "@/lib/rate-budget";
import { isSystemEnabled, isSystemEnabledForSend } from "@/lib/systems/repository";
import { decideLeadBridge, onboardingLeadSource } from "@/lib/onboarding/lead-bridge";
import {
  findEarlierOpenLead,
  findOpenLeadByAddress,
  insertLead,
  setLeadStage,
} from "@/lib/speed-to-lead/repository";
import { normaliseEmail, toE164 } from "@/lib/messaging/phone";
import type {
  OnboardingConsent,
  OnboardingFile,
  OnboardingSubmission,
} from "@/lib/onboarding/types";

export const dynamic = "force-dynamic";

// Public submit endpoint for the new-patient onboarding form. A new customer fills in
// the branded /onboard/<client> flow and POSTs the answers here. We resolve the
// client, validate everything, store the submission, and return a friendly message.
//
// ABUSE SURFACE: this is unauthenticated and writes a row (and references files the
// upload endpoint already stored). Unlike the smile assessment it sends no outbound
// message, so the blast radius is "junk rows", but we still validate hard, rate-limit
// per IP, cap the files array, and refuse any file path that is not under this
// client's own storage prefix. It never throws to the client.

const IP_RATE_LIMIT = 15; // max submissions from one IP per hour (best-effort, per-instance)
const HOUR_MS = 60 * 60 * 1000;
const MAX_FILES = 8;
const MAX_NAME_LEN = 200;

// Best-effort per-IP cap. In-process and per-instance only (not distributed), so it
// blunts a single-instance flood. Mirrors the smile-assessment submit pattern.
const ipHits = new Map<string, number[]>();
function tooManyForIp(ip: string, now: number): boolean {
  const cutoff = now - HOUR_MS;
  const hits = (ipHits.get(ip) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) {
      if (v.every((t) => t <= cutoff)) ipHits.delete(k);
    }
  }
  return hits.length > IP_RATE_LIMIT;
}

function clientIp(request: Request): string {
  // Prefer the platform-set x-real-ip (not client-spoofable). Fall back to the
  // LAST x-forwarded-for entry (Vercel appends the real connecting IP at the end);
  // the leftmost entry is attacker-controlled, so never trust it.
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }
  return "unknown";
}

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function bool(v: unknown): boolean {
  return v === true || v === "true" || v === "yes" || v === 1 || v === "1";
}

/** A non-empty trimmed string or undefined, for mapping into nullable columns/jsonb. */
function emptyToUndef(v: string | undefined): string | undefined {
  return v && v !== "" ? v : undefined;
}

const ALLOWED_FILE_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/webp",
]);
const MAX_FILE_BYTES = 10 * 1024 * 1024; // mirrors the bucket's 10MB limit

/**
 * Validate the caller-supplied file references. Each must be the shape the upload
 * endpoint returns AND its path must live under onboarding/<clientSlug>/ — a caller
 * cannot attach a file from another client's prefix (no cross-tenant attachment).
 * Returns the cleaned list or null if anything is off.
 */
function parseFiles(raw: unknown, clientSlug: string): OnboardingFile[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_FILES) return null;
  const prefix = `onboarding/${clientSlug}/`;
  const out: OnboardingFile[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    const path = str(e.path);
    const name = str(e.name);
    const type = str(e.type);
    const size = typeof e.size === "number" ? e.size : Number(e.size);
    if (!path || !name || !type) return null;
    if (name.length > MAX_NAME_LEN) return null;
    if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) return null;
    if (!ALLOWED_FILE_TYPES.has(type)) return null;
    // Tenancy + traversal guard: must be exactly under this client's prefix.
    if (!path.startsWith(prefix) || path.includes("..")) return null;
    out.push({ path, name, size, type });
  }
  return out;
}

/**
 * Bridge a completed registration into Speed-to-lead so somebody chases it.
 *
 * WHY THIS EXISTS: a submission used to be recorded and nothing more. The person
 * had just told the practice they wanted to join, and no automation and no worklist
 * entry followed them; the row sat in the onboarding list until a human happened to
 * open it. This creates the lead the existing SLA sweep already knows how to chase.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does NOT send. The intake route first-contacts
 * inside the request because a web enquiry is a race; a registration is not, and
 * adding a second send path to a public unauthenticated endpoint buys nothing. The
 * lead is written at stage 'new' with first_response_at null, which is exactly what
 * listUncontacted selects, so the sweep picks it up on its next tick and every
 * existing choke point (consent, suppression, deliverability, quiet hours, the
 * kill switch, the atomic claim) applies unchanged.
 *
 * BEST EFFORT BY CONTRACT: every failure here is swallowed. The patient has already
 * registered successfully and their submission is already stored; a lead-table blip
 * must never turn that into an error page telling them to fill the form in again.
 */
async function bridgeSubmissionToLead(input: {
  clientId: string;
  siteId: string;
  formSlug: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  consent: OnboardingConsent;
  reason: string | undefined;
}): Promise<void> {
  // Owner kill switch. Speed-to-lead being off means the practice does not want
  // leads created or chased, so record the submission and stop. Checked with the
  // SEND variant (fail-closed once messaging is live) because the lead this would
  // create exists precisely so the sweep can message it.
  if (!(await isSystemEnabledForSend(input.clientId, "speed-to-lead"))) return;

  // Normalise before deciding: an unusable number must read as "no phone" to the
  // consent gate, not as a phone that happens never to deliver.
  const phone = toE164(input.phone);
  const email = normaliseEmail(input.email);

  const decision = decideLeadBridge({
    firstName: input.firstName,
    lastName: input.lastName,
    phone,
    email,
    consent: input.consent,
  });
  if (!decision.bridge) return;

  // Dedup, exactly as the intake route does: someone who did the quiz and then
  // registered (or double-tapped Submit) must not become two leads and two chases.
  const sinceIso = new Date(Date.now() - HOUR_MS).toISOString();
  if (await findOpenLeadByAddress(input.siteId, phone, email, sinceIso)) return;

  const lead = await insertLead({
    siteId: input.siteId,
    name: decision.name,
    email,
    phone,
    channel: decision.channel,
    // Why they said they are joining, so the first-contact draft and the worklist
    // row are about their actual reason rather than a generic new-patient line.
    treatmentInterest: input.reason ?? null,
    source: onboardingLeadSource(input.formSlug),
    consent: decision.consent,
  });

  // Double-submit race guard (the intake route's post-insert re-check). There is no
  // DB unique constraint on (site, contact), so two near-simultaneous submits can
  // both pass the dedup above; retire the later one so only one lead is chased.
  const earlier = await findEarlierOpenLead(
    input.siteId,
    phone,
    email,
    sinceIso,
    lead.id,
    lead.createdAt,
  );
  if (earlier) await setLeadStage(lead.id, "lost");
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  try {
    // Resolve the client (reject unknown). The submit is anchored to a real client so
    // the file-prefix check and the stored client_id cannot be spoofed.
    const clientSlug = str(body.clientSlug);
    const client = clientSlug ? getClient(clientSlug) : undefined;
    if (!client) return bad("Unknown practice");

    // Owner kill-switch: if onboarding is turned off for this client, accept nothing.
    if (!(await isSystemEnabled(client.id, "onboarding"))) {
      return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    }

    // Per-IP cap first (cheap, in-process) so a flood is blunted before any DB hit.
    if (tooManyForIp(clientIp(request), Date.now())) {
      return bad("Too many submissions, please try again later", 429);
    }
    // Shared global budget: the real ceiling across all instances, immune to IP
    // spoofing. Bounds abuse + orphaned-object flooding regardless of warm instances.
    if (!(await consumeBudget("onboarding-submit", 240, 60))) {
      return Response.json(
        { ok: false, error: "the form is busy, please try again shortly" },
        { status: 429 },
      );
    }

    // A named form (from /onboard/<client>/<slug>) uses ITS OWN config; the legacy
    // /onboard/<client> flow uses the practice default config. A formSlug that does not
    // resolve to an active form is rejected so a paused/unknown form cannot be submitted.
    const formSlug = str(body.formSlug);
    let formId: string | null = null;
    let formSiteId: string | null = null;
    let config = await getConfig(client.id);
    if (formSlug) {
      const form = await getActiveFormBySlug(client.id, formSlug);
      if (!form) return bad("This form is no longer available", 404);
      config = form.config;
      formId = form.id;
      formSiteId = form.siteId;
    }

    // Validate + normalise the answers against the resolved form. Loading the config and
    // resolving it here (the same resolveSteps the public page uses) means enabled/custom
    // questions are accepted and disabled ones rejected, so the allow-list always matches
    // what the patient was actually shown. Feed the client's REAL sites so the `site`
    // select is validated against them: an unmatched site value is rejected (400) here
    // rather than silently substituted, closing the mock->real seam.
    const clientSites = getSites(client.id);
    const siteOptions = clientSites.map((s) => ({ value: s.id, label: s.name }));
    const steps = resolveSteps(config, { siteOptions });
    const parsedAnswers = parseSubmission(body.answers, steps);
    if (!parsedAnswers.ok) return bad(parsedAnswers.error);
    const a = parsedAnswers.answers;

    // Resolve the site: `a.site` has already been validated as one of this client's
    // sites (or "any"); "any" means defer, so fall back to the form's own site.
    const chosenSite = a.site;
    const siteId =
      chosenSite && clientSites.some((s) => s.id === chosenSite) ? chosenSite : formSiteId;

    // Validate + scope the uploaded-file references.
    const files = parseFiles(body.files, client.slug);
    if (files === null) return bad("One or more attachments were not valid");

    // Consent: a separate object on the final submit step (not a form field).
    const rawConsent = (body.consent ?? {}) as Record<string, unknown>;
    const consent: OnboardingConsent = {
      sms: bool(rawConsent.sms),
      email: bool(rawConsent.email),
      marketing: bool(rawConsent.marketing),
      data: bool(rawConsent.data),
    };

    // Map the flat, validated answers into the row's columns + jsonb groups.
    const address = {
      line1: emptyToUndef(a.address_line1),
      line2: emptyToUndef(a.address_line2),
      city: emptyToUndef(a.address_city),
      postcode: emptyToUndef(a.address_postcode),
    };
    const medical = {
      conditions: emptyToUndef(a.medical_conditions),
      medications: emptyToUndef(a.medical_medications),
      allergies: emptyToUndef(a.medical_allergies),
      gp: emptyToUndef(a.gp),
    };
    const dental = {
      reason: emptyToUndef(a.reason),
      last_visit: emptyToUndef(a.last_visit),
      concerns: emptyToUndef(a.concerns),
    };

    const hasAny = (o: Record<string, unknown>): boolean =>
      Object.values(o).some((v) => v !== undefined);

    // Custom questions: parseSubmission already validated these against this practice's
    // resolved form (so only keys the patient was actually shown survive). Library
    // answers map into their dedicated columns/jsonb above; everything keyed custom-
    // is collected here into its own jsonb group so it is never lost.
    const custom: Record<string, string> = {};
    for (const [key, value] of Object.entries(a)) {
      if (key.startsWith("custom-")) custom[key] = value;
    }

    const submission: OnboardingSubmission = await createSubmission({
      clientId: client.id,
      formId,
      siteId,
      firstName: a.first_name ?? null,
      lastName: a.last_name ?? null,
      dateOfBirth: a.date_of_birth ?? null,
      phone: a.phone ?? null,
      email: a.email ?? null,
      address: hasAny(address) ? address : null,
      medical: hasAny(medical) ? medical : null,
      dental: hasAny(dental) ? dental : null,
      heardAbout: a.heard_about ?? null,
      files,
      consent,
      custom: hasAny(custom) ? custom : null,
    });

    // LEAD BRIDGE: the submission is safely stored; now make sure a human (or the
    // sweep) actually follows it up. A lead has to belong to a site to be worked, so
    // when the patient chose "any" on a form that itself has no site, attribute it to
    // the practice's first site (the intake route resolves an unstated site the same
    // way). The SUBMISSION's own siteId is untouched by that fallback: it stays null
    // and honest about the patient having expressed no preference.
    const leadSiteId = siteId ?? clientSites[0]?.id ?? null;
    if (leadSiteId) {
      try {
        await bridgeSubmissionToLead({
          clientId: client.id,
          siteId: leadSiteId,
          formSlug: formSlug ?? null,
          firstName: a.first_name ?? null,
          lastName: a.last_name ?? null,
          phone: a.phone ?? null,
          email: a.email ?? null,
          consent,
          reason: emptyToUndef(a.reason),
        });
      } catch (err) {
        // The registration itself succeeded. Loud in the log, invisible to them.
        console.error("[onboarding] could not bridge the submission into speed-to-lead", err);
      }
    }

    // Do not leak the row id or internals to the public caller; a friendly ack only.
    void submission;
    return Response.json({
      ok: true,
      message: "Thanks for registering. Our team will be in touch to welcome you.",
    });
  } catch {
    // Never throw to the client.
    return bad("We could not save your details, please try again", 500);
  }
}
