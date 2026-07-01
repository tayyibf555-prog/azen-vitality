import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getFormBySlug, updateForm, type UpdateFormPatch } from "@/lib/onboarding/form-repository";
import { normaliseFormConfig, type OnboardingFormStatus } from "@/lib/onboarding/form";
import { ONBOARDING_LIBRARY } from "@/lib/onboarding/library";

export const dynamic = "force-dynamic";

// Read + update a single onboarding form by (client, slug). Both requireUser +
// requireClientAccess. GET returns the full form incl its question config and the
// library, so the builder can edit it. PATCH updates name/headline/intro/config/status.

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

async function resolveClient(request: Request, bodyClient?: string) {
  const clientSlug = bodyClient ?? new URL(request.url).searchParams.get("client") ?? "";
  return { clientSlug, client: getClient(clientSlug) };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const { slug } = await params;
  const { client } = await resolveClient(request);
  if (!client) return bad("Unknown client", 404);
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  const form = await getFormBySlug(client.id, slug);
  if (!form) return bad("Form not found", 404);

  return Response.json({ ok: true, form, library: ONBOARDING_LIBRARY });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const { slug } = await params;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const { client } = await resolveClient(request, str(body.clientSlug, 60));
  if (!client) return bad("Unknown client", 404);
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  const form = await getFormBySlug(client.id, slug);
  if (!form) return bad("Form not found", 404);

  const patch: UpdateFormPatch = {};
  if (body.name !== undefined) {
    const name = str(body.name, 80);
    if (!name) return bad("name cannot be empty");
    patch.name = name;
  }
  if (body.headline !== undefined) patch.headline = str(body.headline, 120) ?? null;
  if (body.intro !== undefined) patch.intro = str(body.intro, 240) ?? null;
  if (body.status !== undefined) {
    const status = str(body.status, 20);
    if (status !== "active" && status !== "paused") return bad("status must be active or paused");
    patch.status = status as OnboardingFormStatus;
  }
  if (body.config !== undefined) patch.config = normaliseFormConfig(body.config);

  if (Object.keys(patch).length === 0) return bad("nothing to update");

  const ok = await updateForm(form.id, client.id, patch);
  if (!ok) return bad("Form not found", 404);
  return Response.json({ ok: true });
}
