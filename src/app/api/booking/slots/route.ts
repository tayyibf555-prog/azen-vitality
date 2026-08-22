import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { getClient, getSites } from "@/lib/mock/clients";
import { dentallyFromEnv } from "@/lib/dentally/read";
import { fetchAvailabilityDays, orderedDayRange, type BookingDay } from "@/lib/booking/slots";
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
    const requestedFrom = url.searchParams.get("from") ?? londonDayKey(now);
    const requestedTo = url.searchParams.get("to") ?? shiftDay(requestedFrom, MAX_RANGE_DAYS);
    if (
      !YMD.test(requestedFrom) ||
      !YMD.test(requestedTo) ||
      Number.isNaN(Date.parse(`${requestedFrom}T00:00:00Z`)) ||
      Number.isNaN(Date.parse(`${requestedTo}T00:00:00Z`))
    ) {
      return bad("Please choose a valid date range.", 400);
    }
    // A BACKWARDS RANGE IS NOT THIS ROUTE'S CALL ANY MORE.
    //
    // It used to clamp `to` down to `from`, which answered a patient who had
    // picked the 10th and then the 5th with ONE day and a cheerful 200: the five
    // open days between them simply vanished from the calendar, with nothing in
    // the response to say they had been dropped. Meanwhile the agent tool swapped
    // the pair and the booking module trimmed nothing — three answers to one
    // question. The booking seam owns it now (orderedDayRange, called by
    // bookingAvailabilityWindow), and a reversed pair is served as the whole range
    // the patient meant.
    //
    // The pair is ordered HERE TOO, from that same shared function, because the
    // clamp below and the cache key are this route's own and both must describe
    // the range that will actually be read. This is one policy with one
    // implementation, not a second opinion.
    const ordered = orderedDayRange(requestedFrom, requestedTo);
    let to = ordered.toDate;
    // ANCHOR AT TODAY, THEN CLAMP — in that order, and the order is the whole fix.
    //
    // `from` defaults to today, so a lone `to` in the past arrives here as the
    // ordered range [pastTo..today]: a range that still TOUCHES today, and whose
    // future part is a perfectly good question. The 14-day clamp, applied to that
    // pair, anchored its fourteen days at `pastTo` and cut the range back to
    // [pastTo..pastTo+13] — still entirely in the past for any `to` more than a
    // fortnight back. The booking seam then rightly refused a window it could never
    // ask Dentally about, and the patient got a cheerful 200 with an EMPTY calendar
    // on a day the practice was open. Before the ordering landed, that same request
    // clamped to `to = from` and served today.
    //
    // So the effective start is moved up to today whenever the ordered range reaches
    // today or beyond, and only then is the fortnight measured. Any range touching
    // today or the future now serves its future part — which is all Dentally can
    // answer for anyway, since availability needs a start strictly in the future —
    // and a range ENTIRELY in the past is the only one left with nothing to serve.
    const today = londonDayKey(now);
    const from = to >= today && ordered.fromDate < today ? today : ordered.fromDate;
    // Clamp: never more than 14 days in one request. Applied to the ORDERED pair,
    // so a reversed range spanning half a year is bounded like any other; before
    // the swap it read as a negative span and slipped past this check entirely.
    if (Date.parse(to) - Date.parse(from) > MAX_RANGE_DAYS * DAY_MS) to = shiftDay(from, MAX_RANGE_DAYS);

    // A RANGE ENTIRELY IN THE PAST, SAID OUT LOUD.
    //
    // After the anchor this is the only shape left that cannot touch today (the
    // clamp only ever pulls `to` DOWN toward `from`, never below it), and it is a
    // real answer rather than an error: nothing is free on days that have ended.
    // But `{days: []}` alone cannot say that — it is the identical response to a
    // fully booked practice, which is why the calendar could show an outage as
    // "no times". `rangeInPast` is the one bit that tells them apart.
    //
    // ADDITIVE, SO NO CONSUMER BREAKS: both readers in this repo (the public
    // booking calendar and the client slot picker) branch on `ok` and read `days`,
    // and ignore any field they were not looking for; a widget that wants to say
    // "those dates have passed" can now do so without guessing. Answered here, ahead
    // of the cache and of Dentally, because the answer depends on today rather than
    // on availability — caching it under a key that outlives the day it was true on
    // is how it would go stale.
    if (to < today) {
      return Response.json({ ok: true, days: [], rangeInPast: true });
    }

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
