import { getClient } from "@/lib/mock";
import {
  requireUser,
  requireClientAccess,
  requireModuleApiAccess,
  requireOwnerRole,
} from "@/lib/auth/guard";
import { ingestAds } from "@/lib/meta-ads/ingest";
import { fetchApifyDatasetItems, runApifyAdLibraryScrape } from "@/lib/meta-ads/apify";
import { upsertWinningAds } from "@/lib/meta-ads/winning-repository";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// REFRESH THE WINNING-ADS LIBRARY from Apify. This is what the weekly cron calls,
// and what an owner can trigger by hand. It is OWNER-only (Meta Ads is an owner
// module) OR cron-authenticated; a signed-in non-owner is refused, exactly like
// every other meta-ads write.
//
// Two sources, chosen by the request:
//   * a datasetId (body or WINNING_ADS_DATASET_ID) -> RE-INGEST an existing scrape.
//     Free-ish: no new scrape runs.
//   * otherwise the Ad Library scraper actor (body.actorId or WINNING_ADS_APIFY_ACTOR)
//     -> a FRESH scrape. This is the ~$1.50-per-run cost the cron file documents.
//
// GRACEFUL WHEN NOT CONFIGURED. With no APIFY_TOKEN the route does not crash and does
// not touch the library: it returns 200 {skipped:"apify_token_not_set"}, so the cron
// can be registered before the token is provisioned and simply idles until it is.
//
// The MODULE is a niche-level library shared by every practice, so ingest is not
// client-scoped; the single-client access check below is only the owner-role gate
// the platform's auth model is expressed through.

const CLIENT_ID = "vitality";
const DEFAULT_NICHE = "uk-dental";
const DEFAULT_TOP_N = 120;
const MAX_TOP_N = 300;

/** The weekly refresh may run without a browser session; CRON_SECRET stands in. */
function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production"; // fail-closed in production
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function clampTopN(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_TOP_N;
  return Math.min(MAX_TOP_N, Math.max(1, Math.round(n)));
}

function parseDefaultInput(): unknown {
  const raw = process.env.WINNING_ADS_APIFY_INPUT;
  if (!raw) return { count: 1000, "search-country": "GB" };
  try {
    return JSON.parse(raw);
  } catch {
    return { count: 1000, "search-country": "GB" };
  }
}

async function handle(request: Request): Promise<Response> {
  // --- auth: cron OR owner --------------------------------------------------
  const cron = cronAuthorized(request);
  if (!cron) {
    const auth = await requireUser();
    if (auth instanceof Response) return auth;
    const client = getClient(CLIENT_ID);
    if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 400 });
    const clientDenied = requireClientAccess(auth, client.id);
    if (clientDenied) return clientDenied;
    const moduleDenied = requireModuleApiAccess(auth, "meta-ads");
    if (moduleDenied) return moduleDenied;
    const ownerDenied = requireOwnerRole(auth);
    if (ownerDenied) return ownerDenied;
  }

  // --- graceful when unconfigured ------------------------------------------
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    return Response.json({ ok: true, skipped: "apify_token_not_set", upserted: 0 });
  }

  // --- request options ------------------------------------------------------
  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // no/invalid body is fine — the cron posts nothing; fall back to env/defaults.
  }
  const niche = typeof body.niche === "string" && body.niche.trim() ? body.niche.trim() : DEFAULT_NICHE;
  const topN = clampTopN(body.topN);
  const datasetId =
    (typeof body.datasetId === "string" && body.datasetId.trim()) ||
    (process.env.WINNING_ADS_DATASET_ID ?? "").trim();
  const actorId =
    (typeof body.actorId === "string" && body.actorId.trim()) ||
    (process.env.WINNING_ADS_APIFY_ACTOR ?? "").trim();

  // --- fetch ---------------------------------------------------------------
  let items;
  let source: "dataset" | "scrape";
  try {
    if (datasetId) {
      source = "dataset";
      items = await fetchApifyDatasetItems(datasetId, token);
    } else if (actorId) {
      source = "scrape";
      const input = body.input ?? parseDefaultInput();
      items = await runApifyAdLibraryScrape(token, { actorId, input });
    } else {
      return Response.json(
        { ok: false, error: "no datasetId and no actor configured (set WINNING_ADS_DATASET_ID or WINNING_ADS_APIFY_ACTOR)" },
        { status: 400 },
      );
    }
  } catch (err) {
    console.error("[winning-ads/ingest] Apify fetch failed", err);
    return Response.json({ ok: false, error: "apify fetch failed" }, { status: 502 });
  }

  // --- rank + upsert (idempotent) ------------------------------------------
  const ranked = ingestAds(items, { niche });
  const top = ranked.slice(0, topN);
  let upserted = 0;
  try {
    upserted = await upsertWinningAds(top);
  } catch (err) {
    console.error("[winning-ads/ingest] upsert failed", err);
    return Response.json({ ok: false, error: "library write failed" }, { status: 500 });
  }

  return Response.json({
    ok: true,
    source,
    niche,
    fetched: items.length,
    deduped: ranked.length,
    seeded: top.length,
    upserted,
  });
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

// pg_cron / the scheduler trigger with GET; reuse the same handler.
export const GET = POST;
