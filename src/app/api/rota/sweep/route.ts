import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { sendMessage } from "@/lib/messaging/send";
import { isSuppressed } from "@/lib/messaging/suppression";
import { CLIENTS, getSites, getSite } from "@/lib/mock/clients";
import { generateShifts, upcomingWeekStarts } from "@/lib/rota/generate";
import { londonDayKey } from "@/lib/time/london";
import { practiceName } from "@/lib/rota/config";
import { draftShiftMessage, type ShiftLine } from "@/lib/rota/draft";
import {
  listStaff,
  getConfig,
  insertShifts,
  listShifts,
  listUnnotifiedUpcoming,
  markNotified,
} from "@/lib/rota/repository";
import type { OpeningHours } from "@/lib/types";
import type { RotaShift, RotaStaff, RotaSite } from "@/lib/rota/types";
import { isSystemEnabledForSend } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";

// GET/POST /api/rota/sweep
// The 24/7 automation. CRON_SECRET-gated + cron-locked + fail-closed. On each run,
// for every client:
//   1. Ensure shifts exist for the configured weeks ahead (generate + insert idempotently).
//   2. For each staff member with unnotified upcoming shifts (within notifyLeadDays),
//      draft their shift list and send it via sendMessage (channel sms to their phone,
//      MESSAGING_DRY_RUN honoured), then markNotified so nobody is texted twice.
// Staff are employees, so there is NO patient consent/suppression gate; we only skip
// staff with no phone on file.

function addDaysKey(dayKey: string, days: number): string {
  const base = Date.parse(`${dayKey}T00:00:00Z`);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

function londonDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function rotaSites(clientId: string): RotaSite[] {
  return getSites(clientId)
    .filter((s) => s.openingHours)
    .map((s) => ({ id: s.id, name: s.name, openingHours: s.openingHours as OpeningHours }));
}

function siteName(siteId: string): string {
  return getSite(siteId)?.name ?? siteId;
}

/** Group a staff member's shifts into the message's line shape, date order. */
function toLines(shifts: RotaShift[]): ShiftLine[] {
  return shifts.map((s) => ({
    date: s.shiftDate,
    start: s.startTime,
    end: s.endTime,
    siteName: siteName(s.siteId),
  }));
}

async function handleWithDentallyPriority(request: Request): Promise<Response> {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  // Never overlap with another rota sweep: two runs would both see the same unnotified
  // shifts and double-text. The lease must OUTLIVE maxDuration (300s): a shorter lease
  // would expire while a slow run was still working, letting the next tick double-send.
  // A crashed run still self-heals: the lease expires ~10s after the platform kills
  // the function.
  if (!(await acquireCronLock("sweep-rota", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
    const now = new Date();
    const today = londonDay(now);

    let generated = 0;
    let notifiedStaff = 0;
    let notifiedShifts = 0;
    let simulatedStaff = 0;
    let skippedNoPhone = 0;
    let sendFailures = 0;
    const providers = new Set<string>();

    for (const client of CLIENTS) {
      // Owner kill switch: skip this client's rota entirely when disabled.
      if (!(await isSystemEnabledForSend(client.id, "rota"))) continue;

      const config = await getConfig(client.id);

      // 1) Ensure the configured weeks of shifts exist.
      const staff = await listStaff(client.id, { activeOnly: true });
      const sites = rotaSites(client.id);
      const weekStartDates = upcomingWeekStarts(now, config.generateWeeksAhead);
      // What is already stored over this window. THE SWEEP IS THE WORST OFFENDER for
      // the generate-fights-editing bug: it runs 24/7, so without this a shift the
      // practice manager deleted at 5pm is back on the rota by the next tick, with
      // nobody told and nothing logged. Passing the stored rows in makes the
      // tombstones and the manual shifts visible to the generator.
      let existingShifts: RotaShift[] = [];
      if (weekStartDates.length > 0) {
        try {
          existingShifts = await listShifts(
            client.id,
            weekStartDates[0],
            addDaysKey(weekStartDates[weekStartDates.length - 1], 6),
          );
        } catch {
          existingShifts = [];
        }
      }
      const shifts = generateShifts({
        staff,
        sites,
        config,
        weekStartDates,
        today: londonDayKey(now),
        existing: existingShifts,
      });
      generated += await insertShifts(shifts);

      // 2) Text staff their unnotified shifts within the notify lead window.
      const windowEnd = addDaysKey(today, Math.max(0, config.notifyLeadDays));
      const upcoming = await listUnnotifiedUpcoming(client.id, today, windowEnd);
      if (upcoming.length === 0) continue;

      // Group unnotified shifts per staff member.
      const byStaff = new Map<string, RotaShift[]>();
      for (const s of upcoming) {
        const list = byStaff.get(s.staffId) ?? [];
        list.push(s);
        byStaff.set(s.staffId, list);
      }

      const staffById = new Map<string, RotaStaff>(staff.map((s) => [s.id, s]));
      const name = practiceName(client.id);

      for (const [staffId, staffShifts] of byStaff) {
        const person = staffById.get(staffId);
        // No phone on file -> cannot text; leave the shifts unnotified so a later run
        // picks them up once a number is added. (No consent gate: staff are employees.)
        if (!person || !person.phone) {
          skippedNoPhone += 1;
          continue;
        }

        // Honour an opt-out even for staff: a number that texted STOP must not
        // keep receiving rota texts. Shifts stay unnotified (visible on the rota
        // page); remove the number from the rota to silence permanently. A failed
        // read counts as suppressed (fail closed): the skip self-heals next run,
        // a wrong send does not.
        let staffSuppressed = true;
        try {
          staffSuppressed = await isSuppressed(staffShifts[0]?.siteId ?? "", "sms", person.phone);
        } catch {
          staffSuppressed = true;
        }
        if (staffSuppressed) {
          skippedNoPhone += 1;
          continue;
        }

        const body = draftShiftMessage(person.name, name, toLines(staffShifts));
        // One staff member's send failing (bad number, provider error) must never
        // abort the whole sweep or block the rest of the team. On failure we leave
        // the shifts unnotified so a later run retries, and carry on.
        let result;
        try {
          result = await sendMessage({ channel: "sms", to: person.phone, body });
          providers.add(result.provider);
        } catch {
          sendFailures += 1;
          continue;
        }

        // In dry-run, sendMessage simulates the text without actually sending it, so
        // we must NOT consume the shifts' unnotified state: marking them notified here
        // would permanently skip them once real sends are switched on, and no staff
        // member would ever get their first real text. Count the simulation and move on.
        if (result.provider === "dry-run") {
          simulatedStaff += 1;
          continue;
        }

        // Only mark the shifts we actually texted, so a person added mid-window is
        // not silently skipped next run.
        await markNotified(staffShifts.map((s) => s.id!).filter(Boolean));
        notifiedStaff += 1;
        notifiedShifts += staffShifts.length;
      }
    }

    return Response.json({
      ok: true,
      generated,
      notifiedStaff,
      notifiedShifts,
      simulatedStaff,
      skippedNoPhone,
      sendFailures,
      providers: [...providers],
    });
  } catch (err) {
    // Never let the sweep crash with an opaque 500: surface the reason so a
    // failing run is diagnosable (no secrets are included in these messages).
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    await releaseCronLock("sweep-rota");
  }
}

// Vercel Cron / pg_cron triggers with GET; reuse the same handler.
// EVERY Dentally read inside this handler is BACKGROUND work against the practice's
// shared 3,600/hour budget (src/lib/dentally/budget.ts): it is starved first, at 60%
// consumption, so a bulk sweep can never be the reason a practice manager's screen or
// a patient's booking calendar goes blank. A refusal aborts this run; the next tick
// retries. Pinned by src/lib/dentally/budget-priority-coverage.test.ts.
export async function POST(request: Request): Promise<Response> {
  return runWithDentallyPriority("background", () => handleWithDentallyPriority(request));
}

export const GET = POST;
export const maxDuration = 300;
