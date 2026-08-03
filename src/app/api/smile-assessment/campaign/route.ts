import { getClient, getSites } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import {
  insertCampaign,
  listCampaigns,
  countResponsesByCampaign,
  SlugTakenError,
} from "@/lib/smile-assessment/campaign-repository";
import {
  slugify,
  isValidSlug,
  goalLabel,
  budgetLabel,
  GOAL_KEYS,
  BUDGET_KEYS,
  type Campaign,
} from "@/lib/smile-assessment/campaign";

export const dynamic = "force-dynamic";

// Internal CRUD for owner-created Smile Assessment campaigns. Both methods are
// requireUser + requireClientAccess. The public landing reads via the separate,
// auth-free GET /api/smile-assessment/campaign/[slug] which returns ONLY safe fields.

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

function publicUrl(origin: string, clientSlug: string, slug: string): string {
  return `${origin}/assess/${clientSlug}/${slug}`;
}

/** Shape returned to the internal UI: the campaign + its public URL + labels + count. */
function toAdminView(origin: string, clientSlug: string, c: Campaign, responseCount: number) {
  return {
    ...c,
    goalLabel: goalLabel(c.goal),
    budgetLabel: budgetLabel(c.targetBudget),
    url: publicUrl(origin, clientSlug, c.slug),
    path: `/assess/${clientSlug}/${c.slug}`,
    responseCount,
  };
}

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "Unknown client" }, { status: 404 });

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // Smile Assessment is outside CLINICIAN_SLUGS: these are marketing campaigns and the
  // enquiry scores behind them. (The patient-facing next/submit/token routes are
  // separate and deliberately unauthenticated.)
  const moduleDenied = requireModuleApiAccess(auth, "smile-assessment");
  if (moduleDenied) return moduleDenied;

  const campaigns = await listCampaigns(client.id);
  const counts = await countResponsesByCampaign(campaigns.map((c) => c.id));
  const origin = new URL(request.url).origin;

  return Response.json({
    ok: true,
    campaigns: campaigns.map((c) => toAdminView(origin, clientSlug, c, counts[c.id] ?? 0)),
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
  // Smile Assessment is outside CLINICIAN_SLUGS: these are marketing campaigns and the
  // enquiry scores behind them. (The patient-facing next/submit/token routes are
  // separate and deliberately unauthenticated.)
  const moduleDenied = requireModuleApiAccess(auth, "smile-assessment");
  if (moduleDenied) return moduleDenied;

  const name = str(body.name, 80);
  if (!name) return bad("name is required");

  const goal = str(body.goal, 40);
  if (!goal || !GOAL_KEYS.includes(goal)) return bad(`goal must be one of: ${GOAL_KEYS.join(", ")}`);

  const targetBudget = str(body.targetBudget, 40) ?? "any";
  if (!BUDGET_KEYS.includes(targetBudget)) return bad(`targetBudget must be one of: ${BUDGET_KEYS.join(", ")}`);

  // Slug: an explicit one (slugified) wins, else derive from the name.
  const slug = slugify(str(body.slug, 60) ?? name);
  if (!isValidSlug(slug)) return bad("could not derive a valid URL from the name or slug");

  // Site: an explicit, in-client siteId wins, else the client's first site.
  const sites = getSites(client.id);
  const explicitSite = str(body.siteId, 60);
  const siteId = explicitSite && sites.some((s) => s.id === explicitSite) ? explicitSite : sites[0]?.id;
  if (!siteId) return bad("client has no sites");

  try {
    const campaign = await insertCampaign({
      clientId: client.id,
      siteId,
      slug,
      name,
      goal,
      goalNote: str(body.goalNote, 200) ?? null,
      idealCustomer: str(body.idealCustomer, 280) ?? null,
      targetBudget,
      headline: str(body.headline, 120) ?? null,
      intro: str(body.intro, 240) ?? null,
      createdBy: auth?.email ?? auth?.id ?? null,
    });
    const origin = new URL(request.url).origin;
    return Response.json(
      { ok: true, campaign: toAdminView(origin, clientSlug, campaign, 0) },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof SlugTakenError) return bad(e.message, 409);
    return bad("could not create the campaign", 500);
  }
}
