import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { sendMessage } from "@/lib/messaging/send";
import { CLIENTS, getSites, getSite } from "@/lib/mock/clients";
import { generateShifts, upcomingWeekStarts } from "@/lib/rota/generate";
import { londonDayKey } from "@/lib/time/london";
import { practiceName } from "@/lib/rota/config";
import { draftShiftMessage, type ShiftLine } from "@/lib/rota/draft";
import {
  listStaff,
  getConfig,
  insertShifts,
  listUnnotifiedUpcoming,
  markNotified,
} from "@/lib/rota/repository";
import type { OpeningHours } from "@/lib/types";
import type { RotaShift, RotaStaff, RotaSite } from "@/lib/rota/types";
import { isSystemEnabled } from "@/lib/systems/repository";

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

export async function POST(request: Request): Promise<Response> {
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
      if (!(await isSystemEnabled(client.id, "rota"))) continue;

      const config = await getConfig(client.id);

      // 1) Ensure the configured weeks of shifts exist.
      const staff = await listStaff(client.id, { activeOnly: true });
      const sites = rotaSites(client.id);
      const weekStartDates = upcomingWeekStarts(now, config.generateWeeksAhead);
      const shifts = generateShifts({ staff, sites, config, weekStartDates, today: londonDayKey(now) });
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
export const GET = POST;
export const maxDuration = 300;
