import { getClient, getSites } from "@/lib/mock/clients";
import { dentallyAgentClient } from "@/lib/dentally/write";
import { fetchAvailabilityDays, type BookingDay } from "@/lib/booking/slots";
import { londonDayKey } from "@/lib/time/london";

export const dynamic = "force-dynamic";

// PUBLIC: real-time Dentally availability for the online-booking page's
// calendar. Read-only: it uses dentallyAgentClient() (the validated read+write
// key) but never writes, so availability stays viewable even while booking
// creation is switched off (kill switch / write gate live on the create route).
//
// Anti-cross-tenant posture mirrors the other public routes: the site must be
// one of the resolved client's own sites, else a plain 404 (never confirm what
// exists). Range is clamped to 14 days per request; a short in-module cache
// stops one browsing patient from hammering Dentally as they flick through.

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 13; // inclusive from..to spans at most 14 calendar days
const CACHE_TTL_MS = 30_000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// Best-effort per-instance cache keyed site+range. Small and self-pruning.
const cache = new Map<string, { at: number; days: BookingDay[] }>();

function shiftDay(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function bad(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const clientSlug = url.searchParams.get("client") ?? "";
    const siteId = url.searchParams.get("site") ?? "";

    // The site must belong to the client, else 404 (mirrors the submit route's
    // cross-tenant guard: a free-floating siteId is never honoured).
    const client = getClient(clientSlug);
    if (!client || !getSites(client.id).some((s) => s.id === siteId)) {
      return bad("Not found", 404);
    }

    const now = new Date();
    const from = url.searchParams.get("from") ?? londonDayKey(now);
    let to = url.searchParams.get("to") ?? shiftDay(from, MAX_RANGE_DAYS);
    if (!YMD.test(from) || !YMD.test(to) || Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`))) {
      return bad("Please choose a valid date range.", 400);
    }
    // Clamp: never before `from`, never more than 14 days in one request.
    if (Date.parse(to) < Date.parse(from)) to = from;
    if (Date.parse(to) - Date.parse(from) > MAX_RANGE_DAYS * DAY_MS) to = shiftDay(from, MAX_RANGE_DAYS);

    const key = `${siteId}:${from}:${to}`;
    const hit = cache.get(key);
    if (hit && now.getTime() - hit.at < CACHE_TTL_MS) {
      return Response.json({ ok: true, days: hit.days });
    }

    const days = await fetchAvailabilityDays(dentallyAgentClient(), siteId, from, to, now);

    // Opportunistic prune so the map cannot grow unbounded across many ranges.
    if (cache.size > 200) {
      for (const [k, v] of cache) {
        if (now.getTime() - v.at >= CACHE_TTL_MS) cache.delete(k);
      }
    }
    cache.set(key, { at: now.getTime(), days });

    return Response.json({ ok: true, days });
  } catch {
    // Dentally hiccup or anything unexpected: friendly, never a crash.
    return bad("We could not load available times right now. Please try again shortly.", 502);
  }
}
