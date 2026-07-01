import { getClient, getSites } from "@/lib/mock/clients";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import {
  insertForm,
  listForms,
  countSubmissionsByForm,
  FormSlugTakenError,
} from "@/lib/onboarding/form-repository";
import { getConfig } from "@/lib/onboarding/config-repository";
import { slugify, isValidSlug, EMPTY_FORM_CONFIG, type OnboardingForm } from "@/lib/onboarding/form";

export const dynamic = "force-dynamic";

// Internal CRUD for owner-created onboarding FORMS. Both methods are requireUser +
// requireClientAccess (onboarding is not owner-only in nav, matching campaigns). The
// public landing reads the form server-side via getActiveFormBySlug, so there is no
// public API here.

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

function publicPath(clientSlug: string, slug: string): string {
  return `/onboard/${clientSlug}/${slug}`;
}

/** Shape returned to the internal UI: the form + its public URL + submission count. */
function toAdminView(origin: string, clientSlug: string, f: OnboardingForm, submissionCount: number) {
  return {
    id: f.id,
    slug: f.slug,
    name: f.name,
    headline: f.headline,
    intro: f.intro,
    status: f.status,
    createdBy: f.createdBy,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    url: `${origin}${publicPath(clientSlug, f.slug)}`,
    path: publicPath(clientSlug, f.slug),
    submissionCount,
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

  const forms = await listForms(client.id);
  const counts = await countSubmissionsByForm(forms.map((f) => f.id));
  const origin = new URL(request.url).origin;

  return Response.json({
    ok: true,
    forms: forms.map((f) => toAdminView(origin, clientSlug, f, counts[f.id] ?? 0)),
  });
}

export async function POST(request: Request): Promise<Response> {
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

  const name = str(body.name, 80);
  if (!name) return bad("name is required");

  // Slug: an explicit one (slugified) wins, else derive from the name.
  const slug = slugify(str(body.slug, 60) ?? name);
  if (!isValidSlug(slug)) return bad("could not derive a valid URL from the name or slug");

  // Site: an explicit, in-client siteId wins, else the client's first site.
  const sites = getSites(client.id);
  const explicitSite = str(body.siteId, 60);
  const siteId = explicitSite && sites.some((s) => s.id === explicitSite) ? explicitSite : sites[0]?.id;
  if (!siteId) return bad("client has no sites");

  // Seed the new form's question config from the practice's existing default config so
  // it works immediately; fall back to the empty-but-valid config when there is none.
  const config = (await getConfig(client.id)) ?? EMPTY_FORM_CONFIG;

  try {
    const form = await insertForm({
      clientId: client.id,
      siteId,
      slug,
      name,
      headline: str(body.headline, 120) ?? null,
      intro: str(body.intro, 240) ?? null,
      config,
      createdBy: auth?.email ?? auth?.id ?? null,
    });
    const origin = new URL(request.url).origin;
    return Response.json(
      { ok: true, form: toAdminView(origin, clientSlug, form, 0) },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof FormSlugTakenError) return bad(e.message, 409);
    return bad("could not create the form", 500);
  }
}
