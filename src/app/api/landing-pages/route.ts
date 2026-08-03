import Anthropic from "@anthropic-ai/sdk";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import { getClient, getSites } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireModuleApiAccess, requireOwnerRole } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { TREATMENTS, findTreatment, type Treatment } from "@/lib/treatments/catalog";
import type { CtaTarget } from "@/lib/landing/content";
import { generateBothVariants, type CallModel } from "@/lib/landing/generate-run";
import { deriveSlug } from "@/lib/landing/slug";
import { insertPageWithVariants, listPages, SlugTakenError } from "@/lib/landing/repository";
import type { LandingPage } from "@/lib/landing/types";

export const dynamic = "force-dynamic";
// Two variants, each up to two model calls, run in parallel: allow headroom.
export const maxDuration = 60;

// Landing-page generation + list. POST generates variants A and B for a treatment,
// vets and lints them, and stores a draft page (owner-only, it spends model calls).
// GET lists a client's landing pages for the management UI.

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

/** Resolve a body treatment (catalogue key or free-text label) to a Treatment. */
function resolveTreatment(input: string): Treatment | null {
  return TREATMENTS.find((t) => t.key === input) ?? findTreatment(input);
}

function toAdminView(origin: string, clientSlug: string, page: LandingPage) {
  return {
    ...page,
    url: `${origin}/go/${clientSlug}/${page.slug}`,
    path: `/go/${clientSlug}/${page.slug}`,
  };
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
  // The READ is owner + coordinator (see the nav item's roles); only the POST below
  // is owner-only. Neither is a clinician's, so the module check carries the GET.
  const moduleDenied = requireModuleApiAccess(auth, "landing-pages");
  if (moduleDenied) return moduleDenied;

  const pages = await listPages(client.id);
  const origin = new URL(request.url).origin;
  return Response.json({ ok: true, pages: pages.map((p) => toAdminView(origin, clientSlug, p)) });
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  const clientSlug = str(body.clientSlug, 60) ?? new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);
  const accessDenied = requireClientAccess(auth, client.id);
  if (accessDenied) return accessDenied;
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  const treatmentInput = str(body.treatment, 60);
  if (!treatmentInput) return bad("treatment is required");
  const treatment = resolveTreatment(treatmentInput);
  if (!treatment) return bad("unknown treatment");

  const ctaTargetRaw = str(body.ctaTarget, 20) ?? "assessment";
  if (ctaTargetRaw !== "assessment" && ctaTargetRaw !== "booking") {
    return bad("ctaTarget must be 'assessment' or 'booking'");
  }
  const ctaTarget: CtaTarget = ctaTargetRaw;
  const ctaTargetSlug = str(body.ctaTargetSlug, 60) ?? null;
  const angle = str(body.angle, 280);
  const campaignRef = str(body.campaignRef, 120) ?? null;

  // Site: an explicit, in-client site wins, else the client's first site.
  const sites = getSites(client.id);
  const explicitSite = str(body.siteId, 60);
  const siteId = explicitSite && sites.some((s) => s.id === explicitSite) ? explicitSite : (sites[0]?.id ?? null);
  const autoPromote = body.autoPromote === false ? false : true;

  // The injected model call: one Sonnet round trip (thinking disabled per house rule).
  const anthropic = new Anthropic({ maxRetries: 1 });
  const callModel: CallModel = async (system, user) => {
    const msg = await anthropic.messages.create(
      { model: SONNET, thinking: NO_THINKING, max_tokens: 1500, system, messages: [{ role: "user", content: user }] },
      { timeout: 25000 },
    );
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  };

  let variants;
  try {
    variants = await generateBothVariants({ treatment, practiceName: client.name, ctaTarget, ctaTargetSlug, angle, callModel });
  } catch {
    // generateVariant already falls back to defaults on model errors; a throw here
    // means something unexpected (e.g. a treatment with no default). Fail cleanly.
    return bad("could not generate the landing page", 500);
  }

  // Persist, retrying with a fresh slug suffix on the rare collision.
  const createdBy = auth?.email ?? auth?.id ?? null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = deriveSlug(treatment.name);
    try {
      const stored = await insertPageWithVariants({
        clientId: client.id,
        siteId,
        slug,
        treatment: treatment.key,
        campaignRef,
        autoPromote,
        createdBy,
        variantA: variants.a.content,
        variantB: variants.b.content,
      });
      const origin = new URL(request.url).origin;
      return Response.json(
        {
          ok: true,
          page: toAdminView(origin, clientSlug, stored.page),
          variants: stored.variants,
          sources: { a: variants.a.source, b: variants.b.source },
        },
        { status: 201 },
      );
    } catch (e) {
      if (e instanceof SlugTakenError) continue; // collision, try a new suffix
      return bad("could not save the landing page", 500);
    }
  }
  return bad("could not allocate a unique URL, please try again", 500);
}
