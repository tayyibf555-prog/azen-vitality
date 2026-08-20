import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { getClient, getSites } from "@/lib/mock/clients";
import { dentallyFromEnv } from "@/lib/dentally/read";
import { fetchAvailabilityDays, type BookingDay } from "@/lib/booking/slots";
import { londonDayKey } from "@/lib/time/london";

export const dynamic = "force-dynamic";

// PUBLIC: real-time Dentally availability for the online-booking page's
// calendar. Read-only, and it reads through the READ client (dentallyFromEnv,
// which carries the readOnly latch) so a patient can always SEE times.
//
// IT USED TO CALL dentallyAgentClient(), AND THAT MADE THE PUBLIC CALENDAR A
// HOSTAGE OF THE WRITE GATE. dentallyAgentClient() answers with DENTALLY_WRITE_*
// only while isDentallyWriteEnabled(); with the gate off it silently falls back
// to DENTALLY_API_KEY, which is NOT the credential the rest of the app reads
// with (dentallyReadKey() prefers DENTALLY_PROD_READONLY_API_KEY). So turning
// writes off — the correct, deliberate thing to do before a demo — swapped the
// credential underneath a pure READ and every /api/booking/slots call started
// answering 502 "We could not load available times right now" on all three
// sites, while the very same availability read succeeded through the read key.
// A read must never depend on whether writes are permitted.
//
// The write gate still governs the CREATE step, where it belongs:
// /api/booking/create refuses with an honest, patient-facing 503 before it
// touches Dentally at all (guard (c) there). Seeing times you cannot yet book
// is the right failure; a dead calendar is not.
//
// ONE ASYMMETRY, STATED ON PURPOSE: create revalidates the chosen slot through
// dentallyAgentClient() so the guard and the write it guards hit the SAME
// Dentally instance. If DENTALLY_WRITE_BASE_URL is ever pointed at a sandbox
// while DENTALLY_BASE_URL points at production, this calendar will offer live
// times that revalidation cannot find and bookings will honestly 409 rather
// than write anywhere wrong. Point them at the same instance.
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

async function handleWithDentallyPriority(request: Request): Promise<Response> {
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

    const days = await fetchAvailabilityDays(dentallyFromEnv(), siteId, from, to, now);

    // Opportunistic prune so the map cannot grow unbounded across many ranges.
    if (cache.size > 200) {
      for (const [k, v] of cache) {
        if (now.getTime() - v.at >= CACHE_TTL_MS) cache.delete(k);
      }
    }
    cache.set(key, { at: now.getTime(), days });

    return Response.json({ ok: true, days });
  } catch (err) {
    // Dentally hiccup or anything unexpected: friendly, never a crash.
    //
    // LOG IT, server side only. This branch swallowed the cause completely, so a
    // calendar that returned no times in production was invisible: the patient
    // saw "please try again shortly" and nothing anywhere said whether Dentally
    // was down, the credential was wrong, or the practice genuinely had no
    // availability. That silence is how the write-gate coupling above survived
    // unnoticed. Mirrors the create route's own failure log.
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const status = (err as { status?: number })?.status;
    console.error(
      `[booking/slots] availability read failed` + (status ? ` (HTTP ${status})` : "") + `: ${detail}`,
    );
    return bad("We could not load available times right now. Please try again shortly.", 502);
  }
}

// Every Dentally read inside this handler is CRITICAL work against the practice's
// shared 3,600/hour budget (src/lib/dentally/budget.ts): a patient mid-booking, or the
// 24/7 agent answering one, outranks every dashboard and every sweep and is served to
// 95% consumption. Pinned by src/lib/dentally/budget-priority-coverage.test.ts.
export function GET(request: Request): Promise<Response> {
  return runWithDentallyPriority("critical", () => handleWithDentallyPriority(request));
}
