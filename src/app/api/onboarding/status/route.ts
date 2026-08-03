import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getSubmission, setStatus } from "@/lib/onboarding/repository";
import type { OnboardingStatus } from "@/lib/onboarding/types";

export const dynamic = "force-dynamic";

// Internal: move one onboarding submission through the review workflow
// (new -> reviewed -> registered / archived). Auth-gated (requireUser +
// requireClientAccess). Tenancy is enforced by loading the submission and checking it
// belongs to the requesting client before any write, so staff cannot mutate another
// client's rows by guessing an id.

const ALLOWED: OnboardingStatus[] = ["new", "reviewed", "registered", "archived"];

export async function POST(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return Response.json({ ok: false, error: "Request body must be valid JSON" }, { status: 400 });
  }

  const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug : "";
  const id = typeof body.id === "string" ? body.id : "";
  const status = typeof body.status === "string" ? (body.status as OnboardingStatus) : null;

  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "Unknown client" }, { status: 404 });

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // Onboarding is outside CLINICIAN_SLUGS: reviewing and registering new-patient
  // submissions (contact details, medical intake, uploaded documents, consent) is
  // reception work, and requireClientAccess admits every role attached to the client.
  const moduleDenied = requireModuleApiAccess(auth, "onboarding");
  if (moduleDenied) return moduleDenied;

  if (!id) return Response.json({ ok: false, error: "Missing submission id" }, { status: 400 });
  if (!status || !ALLOWED.includes(status)) {
    return Response.json({ ok: false, error: "Invalid status" }, { status: 400 });
  }

  // Tenancy: the submission must belong to this client before we touch it.
  const submission = await getSubmission(id);
  if (!submission || submission.clientId !== client.id) {
    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  await setStatus(id, status);
  return Response.json({ ok: true, id, status });
}
