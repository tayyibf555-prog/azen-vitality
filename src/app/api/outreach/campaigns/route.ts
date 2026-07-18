import { getClient, getSites } from "@/lib/mock/clients";
import { requireUser, requireOwnerRole, requireClientAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import {
  createCampaign,
  listCampaigns,
  campaignStatusCounts,
  campaignVariantCounts,
  type CampaignVariantBreakdown,
} from "@/lib/outreach/repository";
import type { OutreachCampaign } from "@/lib/outreach/types";
import { parseFilters, parseDailyCap } from "@/lib/outreach/validate";

export const dynamic = "force-dynamic";

// Thin CRUD over the wave-1 outreach repository. Every method is
// requireUser + requireOwnerRole + requireClientAccess: campaigns text real patients,
// so they are an owner-only surface even though the page also renders for a
// coordinator's shell (the module itself is owner-gated in the nav + page guard).

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

/** The owner-gate chain shared by both methods; returns the resolved auth or a Response. */
async function authorise(): Promise<AuthedUser | null | Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const ownerOnly = requireOwnerRole(user);
  if (ownerOnly) return ownerOnly;
  return user;
}

function toListView(
  c: OutreachCampaign,
  counts: Awaited<ReturnType<typeof campaignStatusCounts>>,
  variants: CampaignVariantBreakdown | null,
) {
  return {
    id: c.id,
    name: c.name,
    siteId: c.siteId,
    status: c.status,
    filters: c.filters,
    practitionerId: c.practitionerId,
    practitionerName: c.practitionerName,
    messageAngle: c.messageAngle,
    // Only present for a two-message campaign; the UI shows the per-variant line only then.
    messageAngleB: c.messageAngleB,
    dailyCap: c.dailyCap,
    counts: {
      built: counts.built,
      contacted: counts.contacted,
      replied: counts.replied,
      booked: counts.booked,
      blocked: counts.blocked,
    },
    // Per-message A/B read-back (assigned/sent/replied/booked), null for single-angle.
    variants,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export async function GET(request: Request): Promise<Response> {
  const auth = await authorise();
  if (auth instanceof Response) return auth;

  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  const campaigns = await listCampaigns({ clientId: client.id });
  const withCounts = await Promise.all(
    campaigns.map(async (c) => {
      // Only compute the per-variant breakdown for a two-message campaign; a single-angle
      // campaign never shows the line, so skip the extra reads.
      const hasVariantB = !!(c.messageAngleB && c.messageAngleB.trim());
      const [counts, variants] = await Promise.all([
        campaignStatusCounts(c.id),
        hasVariantB ? campaignVariantCounts(c.id) : Promise.resolve(null),
      ]);
      return toListView(c, counts, variants);
    }),
  );
  return Response.json({ ok: true, campaigns: withCounts });
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authorise();
  if (auth instanceof Response) return auth;

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

  // messageAngle is OPTIONAL at draft (a segment can be built as a list preview with
  // no send intent). It is REQUIRED before launch, validated in the PATCH launch
  // action, not here.
  const messageAngle = str(body.messageAngle, 120) ?? null;
  // Optional SECOND angle turns the campaign into a two-message A/B test. Additive: null
  // keeps it single-message. The angle only chooses which text a patient is drafted.
  const messageAngleB = str(body.messageAngleB, 120) ?? null;

  // Site must be one the client actually owns (never a foreign Dentally site).
  const sites = getSites(client.id);
  const siteId = str(body.siteId, 60);
  if (!siteId || !sites.some((s) => s.id === siteId)) return bad("siteId must be one of this client's sites");

  const filtersParse = parseFilters(body.filters);
  if (!filtersParse.ok) return bad(filtersParse.error);

  const capParse = parseDailyCap(body.dailyCap);
  if (!capParse.ok) return bad(capParse.error);

  const campaign = await createCampaign({
    clientId: client.id,
    siteId,
    name,
    filters: filtersParse.filters,
    practitionerId: str(body.practitionerId, 60) ?? null,
    practitionerName: str(body.practitionerName, 120) ?? null,
    messageAngle,
    messageAngleB,
    dailyCap: capParse.dailyCap,
    createdBy: auth?.email ?? auth?.id ?? null,
  });

  return Response.json(
    {
      ok: true,
      // A just-created campaign has no targets yet, so per-variant counts are all zero;
      // pass null rather than compute empty reads.
      campaign: toListView(campaign, { built: 0, contacted: 0, replied: 0, booked: 0, blocked: 0 }, null),
    },
    { status: 201 },
  );
}
