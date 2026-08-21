import "server-only";
import type { ApifyAdItem } from "./ingest";

// APIFY CLIENT for the winning-ads pipeline. Two ways to get raw Meta Ad Library
// items, both authenticated by APIFY_TOKEN carried in the Authorization HEADER
// (never a query string: the token is a secret and secrets do not go in URLs):
//
//   * fetchApifyDatasetItems - READ an existing dataset by id. Free-ish (no scrape).
//       This is the "re-ingest a completed scrape" path.
//   * runApifyAdLibraryScrape - RUN the Ad Library scraper actor synchronously and
//       get its dataset back. This is the FRESH scrape the weekly refresh uses, and
//       it is the ~$1.50-per-run cost the cron file documents.
//
// The token is read by the CALLER (the route) and passed in, so this module never
// touches process.env and stays trivially testable. Network failures throw with a
// short message; the route turns them into an honest JSON error.

/** Apify caps a single dataset-items page at 1000; we page to this hard ceiling. */
export const APIFY_PAGE_LIMIT = 1000;
/** A safety ceiling so a huge dataset can never spin the server forever. */
export const APIFY_MAX_ITEMS = 6000;

/**
 * The dataset-items URL for one page. Pure and token-free (the token rides in the
 * request header), so it is safe to log and simple to test. `clean=true` drops
 * empty items and hidden fields.
 */
export function datasetItemsUrl(datasetId: string, opts: { limit: number; offset: number }): string {
  const params = new URLSearchParams({
    clean: "true",
    format: "json",
    limit: String(opts.limit),
    offset: String(opts.offset),
  });
  return `https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?${params.toString()}`;
}

/** The run-sync-get-dataset-items URL for an actor. Pure and token-free. */
export function runSyncDatasetUrl(actorId: string): string {
  // Apify accepts either "user/actor" or the actor id; both must be path-encoded.
  const encoded = actorId.includes("/")
    ? actorId.split("/").map(encodeURIComponent).join("~")
    : encodeURIComponent(actorId);
  return `https://api.apify.com/v2/acts/${encoded}/run-sync-get-dataset-items?clean=true&format=json`;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, accept: "application/json" };
}

function asItems(payload: unknown): ApifyAdItem[] {
  return Array.isArray(payload) ? (payload as ApifyAdItem[]) : [];
}

/**
 * Read every item of an existing Apify dataset, paging to APIFY_MAX_ITEMS. Throws
 * on a non-2xx response or a network error.
 */
export async function fetchApifyDatasetItems(
  datasetId: string,
  token: string,
  opts: { fetchImpl?: typeof fetch; maxItems?: number } = {},
): Promise<ApifyAdItem[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxItems = opts.maxItems ?? APIFY_MAX_ITEMS;
  const all: ApifyAdItem[] = [];
  for (let offset = 0; offset < maxItems; offset += APIFY_PAGE_LIMIT) {
    const url = datasetItemsUrl(datasetId, { limit: APIFY_PAGE_LIMIT, offset });
    const res = await doFetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      throw new Error(`Apify dataset read failed (HTTP ${res.status})`);
    }
    const page = asItems(await res.json());
    all.push(...page);
    if (page.length < APIFY_PAGE_LIMIT) break; // last page
  }
  return all.slice(0, maxItems);
}

/**
 * Run the Ad Library scraper actor synchronously and return its dataset items. This
 * is the paid scrape. `input` is the actor's input JSON (search terms, country,
 * count) and is passed straight through so the actor's own schema stays the source
 * of truth. Throws on a non-2xx response.
 */
export async function runApifyAdLibraryScrape(
  token: string,
  args: { actorId: string; input: unknown; fetchImpl?: typeof fetch },
): Promise<ApifyAdItem[]> {
  const doFetch = args.fetchImpl ?? fetch;
  const res = await doFetch(runSyncDatasetUrl(args.actorId), {
    method: "POST",
    headers: { ...authHeaders(token), "content-type": "application/json" },
    body: JSON.stringify(args.input ?? {}),
  });
  if (!res.ok) {
    throw new Error(`Apify actor run failed (HTTP ${res.status})`);
  }
  return asItems(await res.json());
}
