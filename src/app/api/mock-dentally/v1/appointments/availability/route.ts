import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import {
  ROTA,
  londonDayKeysBetween,
  londonMinuteInstantMs,
  londonOffsetIso,
  sessionFor,
} from "@/app/api/mock-dentally/_rota";
import { generatedAppointments } from "@/app/api/mock-dentally/_dashboard-fixtures";
import { MOCK_APPOINTMENTS, type MockAppointment } from "@/app/api/mock-dentally/_fixtures";
import { londonDayKey } from "@/lib/time/london";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/appointments/availability
//   ?start_time=ISO&finish_time=ISO&duration=&practitioner_ids[]=...
//
// Mirrors the LIVE Dentally contract (calibrated 2026-07-11): availability is per
// practitioner, start/finish are ISO DATETIMES (the older site_id/start_date shape
// 400s on the real API with "start_time is missing"), and every returned row
// carries its practitioner_id.
//
// WHAT CHANGED AND WHY. The previous version returned a handful of fixed slots at
// the requested start plus one, two and four days. A SINGLE-DAY request therefore
// returned nothing at all, which the diary reads as "nobody is working today":
// the safest-looking wrong answer, and one no test would have caught. It also
// fabricated rows for ANY practitioner id, including ids that do not exist, so
// "this clinician is not working" could never be proven false.
//
// It now derives windows the way the real thing must:
//   rota entry INTERSECT site opening hours, MINUS that practitioner's own
//   bookings, clipped to the requested range.
// A practitioner with no rota contributes NOTHING. Sunday returns nothing
// anywhere. Every emitted time carries a London offset ("+01:00" / "+00:00")
// rather than a Z, so a caller that string-slices a time is caught here instead
// of being an hour wrong in the practice through British Summer Time.
//
// `available_duration` is NOT emitted: it was a mock invention with no live
// provenance and no reader anywhere in src/.

/** Bookings that consume a clinician's time. Cancelled and DNA rows do not. */
function occupiesTime(state: string | undefined): boolean {
  const s = (state ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  return s !== "cancelled" && s !== "did_not_attend";
}

interface Span {
  startMin: number;
  endMin: number;
}

/** That practitioner's booked spans on that London day, in minutes past midnight. */
function bookedSpans(practitionerId: string, dayKey: string, book: MockAppointment[]): Span[] {
  const dayStartMs = londonMinuteInstantMs(dayKey, 0);
  const spans: Span[] = [];
  for (const a of book) {
    if (a.practitioner_id !== practitionerId) continue;
    if (!occupiesTime(a.state)) continue;
    const startMs = Date.parse(a.start_time);
    if (Number.isNaN(startMs)) continue;
    if (londonDayKey(new Date(startMs)) !== dayKey) continue;
    const startMin = Math.round((startMs - dayStartMs) / 60_000);
    spans.push({ startMin, endMin: startMin + (a.duration ?? 30) });
  }
  return spans.sort((x, y) => x.startMin - y.startMin);
}

/** The parts of `session` not covered by `busy`. */
function freeSpans(session: Span, busy: Span[]): Span[] {
  const out: Span[] = [];
  let cursor = session.startMin;
  for (const b of busy) {
    if (b.endMin <= cursor) continue;
    if (b.startMin >= session.endMin) break;
    if (b.startMin > cursor) out.push({ startMin: cursor, endMin: Math.min(b.startMin, session.endMin) });
    cursor = Math.max(cursor, b.endMin);
    if (cursor >= session.endMin) break;
  }
  if (cursor < session.endMin) out.push({ startMin: cursor, endMin: session.endMin });
  return out;
}

export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const startRaw = url.searchParams.get("start_time");
  const finishRaw = url.searchParams.get("finish_time");
  if (!startRaw || !finishRaw) {
    // Fail exactly like live Dentally so a miscalibrated caller is caught in dev.
    return Response.json(
      {
        error: {
          type: "invalid_request_error",
          message: "The appointment could not be processed",
          params: { start_time: ["is missing"], finish_time: ["is missing"] },
        },
      },
      { status: 400 },
    );
  }

  const startMs = Date.parse(startRaw);
  const finishMs = Date.parse(finishRaw);
  if (Number.isNaN(startMs) || Number.isNaN(finishMs)) {
    return Response.json(
      {
        error: {
          type: "invalid_request_error",
          message: "The appointment could not be processed",
          params: { start_time: ["is invalid"], finish_time: ["is invalid"] },
        },
      },
      { status: 400 },
    );
  }

  // No practitioner_ids[] means no scoping at all, which is exactly how a caller
  // would end up reading another practice's windows. Answer for nobody rather
  // than guessing a default pair, which is what this used to do.
  const ids = [...new Set(url.searchParams.getAll("practitioner_ids[]").filter((id) => id !== ""))];
  const durationRaw = Number(url.searchParams.get("duration") ?? "");
  const minWindow = Math.max(5, Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 5);

  const book = [...MOCK_APPOINTMENTS, ...generatedAppointments()];
  const dayKeys = londonDayKeysBetween(startMs, finishMs);

  const availability: Array<{ start_time: string; finish_time: string; practitioner_id: string }> = [];
  for (const id of ids) {
    // An id with NO rota at all contributes nothing. Never fabricate a window for
    // a practitioner the practice does not have.
    if (!ROTA[id]) continue;
    for (const dayKey of dayKeys) {
      const session = sessionFor(id, dayKey);
      if (!session) continue; // not rostered, site shut, or no overlap
      for (const span of freeSpans(session, bookedSpans(id, dayKey, book))) {
        if (span.endMin - span.startMin < minWindow) continue;
        const spanStart = Math.max(londonMinuteInstantMs(dayKey, span.startMin), startMs);
        const spanFinish = Math.min(londonMinuteInstantMs(dayKey, span.endMin), finishMs);
        if (spanFinish - spanStart < minWindow * 60_000) continue;
        availability.push({
          start_time: londonOffsetIso(spanStart),
          finish_time: londonOffsetIso(spanFinish),
          practitioner_id: id,
        });
      }
    }
  }

  availability.sort((a, b) => (a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : 0));
  return Response.json({ availability });
}
