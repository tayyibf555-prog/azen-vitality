import "server-only";
import { listAppointments } from "@/lib/dentally/read";
import { listTargets } from "@/lib/noshow/repository";
import { getSites } from "@/lib/mock/clients";
import { londonDayKey } from "@/lib/time/london";

// The Home page's "Today's diary" rail: today's appointments across the client's
// sites, each classified for the glanceable rail — done, next up, booked, at
// no-show risk, or a gap to fill. Assembled server-side so the rail renders with
// the page (no loading spinner), joined to no-show risk by APPOINTMENT ID (the
// stable key both sides store), never by patient name.

export type DiarySlotState = "completed" | "next" | "booked" | "risk" | "gap";

export interface DiarySlot {
  id: string;
  /** London wall-clock label, e.g. "10:40". */
  time: string;
  /** "Patient name · reason" (reason omitted when unknown). */
  label: string;
  state: DiarySlotState;
  siteName: string | null;
}

export interface TodayDiary {
  slots: DiarySlot[];
  /** The next booked appointment after `now`, for the day header chip. */
  next: { time: string; label: string } | null;
  /** Whole-percent fill: non-gap slots over all slots (null when no slots). */
  fillPercent: number | null;
  gapCount: number;
}

const GAP_STATES = new Set(["cancelled", "did_not_attend", "no_show"]);
const DONE_STATES = new Set(["completed", "attended", "checked_out"]);

function londonTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

export async function getTodayDiary(
  clientId: string,
  now: Date,
  scopeSiteIds?: string[],
): Promise<TodayDiary> {
  const sites = getSites(clientId);
  // Scope the diary to the caller's selected site(s) (default view = N15); keep
  // the full site-name map so labels resolve whatever the scope.
  const siteIds = scopeSiteIds ?? sites.map((s) => s.id);
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const today = londonDayKey(now);

  // Both reads are best-effort (a Dentally or DB hiccup renders an empty rail,
  // never a broken Home page) and independent, so they run concurrently rather
  // than stacking two round trips on the Home page's critical path.
  const [appts, riskApptIds] = await Promise.all([
    listAppointments(siteIds, { from: today, to: today }).catch(
      () => [] as Awaited<ReturnType<typeof listAppointments>>,
    ),
    listTargets({ siteIds, statuses: ["scheduled"], riskBands: ["high"] })
      .then((targets) => new Set(targets.map((t) => t.appointmentId)))
      .catch(() => new Set<string>()),
  ]);

  // Keep only today's rows (defensive against an upstream range quirk), sorted.
  const rows = appts
    .filter((a) => a.start && londonDayKey(new Date(a.start)) === today)
    .sort((a, b) => (a.start < b.start ? -1 : 1));

  const nowMs = now.getTime();
  let nextAssigned = false;
  let gapCount = 0;

  const slots: DiarySlot[] = rows.map((a) => {
    const startMs = new Date(a.start).getTime();
    const state: DiarySlotState = (() => {
      if (GAP_STATES.has(a.state)) {
        gapCount += 1;
        return "gap";
      }
      if (DONE_STATES.has(a.state) || startMs < nowMs) return "completed";
      if (riskApptIds.has(a.id)) return "risk";
      if (!nextAssigned) {
        nextAssigned = true;
        return "next";
      }
      return "booked";
    })();
    return {
      id: a.id,
      time: londonTime(a.start),
      label: a.reason ? `${a.patientName} · ${a.reason}` : a.patientName,
      state,
      siteName: siteName.get(a.siteId) ?? null,
    };
  });

  const next = slots.find((s) => s.state === "next") ?? null;
  const fillPercent =
    slots.length > 0 ? Math.round(((slots.length - gapCount) / slots.length) * 100) : null;

  return {
    slots,
    next: next ? { time: next.time, label: next.label } : null,
    fillPercent,
    gapCount,
  };
}
