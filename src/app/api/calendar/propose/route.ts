// ===========================================================================
// POST /api/calendar/propose
//
// When a patient cancels or asks to reschedule, this is what the platform offers
// instead. A candidate is only valid when BOTH hold:
//   (a) that clinician genuinely has availability then, from Dentally's own
//       windows and never from hours we invented, and
//   (b) that clinician is SUITED to the treatment.
//
// THE FILTER RUNS BEFORE THE SORT, in proposeSlots, so no ordering rule can
// relax it. Proposing a hygienist for an extraction because nothing else was
// free is the failure mode that matters here.
//
// The criteria are NEVER widened automatically. `windowDays` is a button a
// person presses, and the panel says a widened result was widened.
// ===========================================================================

import { requireDiaryAdmin } from "@/lib/calendar/access";
import {
  listAppointmentsSafe,
  listDiaryAvailabilitySafe,
  listSitePractitionersSafe,
  type AppointmentRecord,
} from "@/lib/dentally/read";
import { getSite } from "@/lib/mock/clients";
import { londonDayKey } from "@/lib/time/london";
import {
  nextDayKey,
  parseAvailabilityWindows,
  UNTAGGED_FAIL_RATIO,
  windowsFor,
} from "@/lib/calendar/availability";
import { occupyingEntries } from "@/lib/calendar/entries";
import { listEntries } from "@/lib/calendar/repository";
import { loadCapabilities, SEEDED_CAPABILITIES_NOTICE } from "@/lib/calendar/suitability-source";
import { availabilityTrustedHere, readSharedPractitionerIds } from "@/lib/calendar/site-presence";
import {
  proposalBreakdown,
  proposeSlots,
  type ProposalClinician,
  type ProposalDay,
  type ProposalInput,
} from "@/lib/calendar/propose";
import { dayBounds, effectiveMinutes, londonMinutes } from "@/components/client/calendar/diary-grid";
import { openingWindowFor } from "@/components/client/calendar/diary-view";
import { familyOf, typeLabelFor } from "@/components/client/calendar/treatment-type";

export const dynamic = "force-dynamic";

/** Availability is one call per range, so the window is walked a week at a time. */
const CHUNK_DAYS = 7;
const WINDOW_CHOICES = [14, 30] as const;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function spanOf(a: AppointmentRecord): { startMin: number; endMin: number } {
  const startMin = londonMinutes(a.start);
  return { startMin, endMin: startMin + effectiveMinutes(a) };
}

/** cancelled and did_not_attend do NOT consume a clinician's time. */
function occupies(state: string): boolean {
  return state !== "cancelled" && state !== "did_not_attend";
}

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Request body must be valid JSON." }, { status: 400 });
  }
  const body = asRecord(raw);

  const siteId = typeof body.siteId === "string" ? body.siteId.trim() : "";
  const appointmentId = typeof body.appointmentId === "string" ? body.appointmentId.trim() : "";
  const day = typeof body.day === "string" ? body.day.trim() : "";
  const windowDays = WINDOW_CHOICES.includes(Number(body.windowDays) as (typeof WINDOW_CHOICES)[number])
    ? (Number(body.windowDays) as (typeof WINDOW_CHOICES)[number])
    : 14;

  const access = await requireDiaryAdmin(siteId);
  if (access instanceof Response) return access;

  if (appointmentId === "") {
    return Response.json({ ok: false, error: "appointmentId is required" }, { status: 400 });
  }
  if (!DAY_KEY_RE.test(day)) {
    return Response.json({ ok: false, error: "day must be YYYY-MM-DD" }, { status: 400 });
  }

  const site = getSite(siteId);
  if (!site) return Response.json({ ok: false, error: "unknown site" }, { status: 400 });

  // The appointment is read SERVER side and matched by id. Nothing about the
  // treatment, the length or the previous clinician is taken from the client.
  const onDay = await listAppointmentsSafe([siteId], { from: day, to: day });
  if (onDay.failed || onDay.failedSiteIds.includes(siteId)) {
    return Response.json(
      { ok: false, error: "We could not read this appointment, so no times can be proposed." },
      { status: 503 },
    );
  }
  const appointment = onDay.appointments.find((a) => a.id === appointmentId && a.siteId === siteId);
  if (!appointment) return Response.json({ ok: false, error: "not found" }, { status: 404 });

  const familySlug = familyOf(appointment.reason);
  const treatment = typeLabelFor(appointment.reason) ?? appointment.reason ?? "this treatment";

  const practitionersRead = await listSitePractitionersSafe(siteId);
  if (practitionersRead.failed) {
    return Response.json(
      { ok: false, error: "We could not read this site's clinicians, so no times can be proposed." },
      { status: 503 },
    );
  }
  const practitionerIds = practitionersRead.practitioners.map((p) => p.id);

  const today = londonDayKey(new Date());
  const from = today > day ? today : day;
  // Start the search the day AFTER the appointment sits, so the list never opens
  // with the slot the patient has just turned down.
  const dayKeys: string[] = [];
  let cursor = nextDayKey(from);
  for (let i = 0; i < windowDays; i += 1) {
    dayKeys.push(cursor);
    cursor = nextDayKey(cursor);
  }

  const windowFrom = dayKeys[0];
  const windowTo = dayKeys[dayKeys.length - 1];

  const windowAppointments = await listAppointmentsSafe([siteId], { from: windowFrom, to: windowTo });
  if (windowAppointments.failed || windowAppointments.failedSiteIds.includes(siteId)) {
    return Response.json(
      { ok: false, error: "We could not read the diary for that period, so no times can be proposed." },
      { status: 503 },
    );
  }

  const { caps, seeded } = await loadCapabilities(access.clientId);

  // WHICH PRACTICE IS THIS CLINICIAN AT? Availability carries no site and takes
  // no site parameter, so a clinician who sits on more than one of this client's
  // practitioner lists is asked about by all of them and answered for whichever
  // practice they are actually at. Proposing one of those windows here would
  // offer another practice's free time as this one's, which is precisely the
  // wrong-clinician outcome this whole endpoint exists to prevent. See
  // site-presence.ts.
  let sharedRead: Awaited<ReturnType<typeof readSharedPractitionerIds>>;
  try {
    sharedRead = await readSharedPractitionerIds(access.clientId, siteId);
  } catch {
    return Response.json(
      {
        ok: false,
        error:
          "We could not check which practice these clinicians are at, so no times can be proposed.",
      },
      { status: 503 },
    );
  }

  const days: ProposalDay[] = [];
  let chunksRead = 0;
  let chunksSkipped = 0;
  for (let i = 0; i < dayKeys.length; i += CHUNK_DAYS) {
    const chunk = dayKeys.slice(i, i + CHUNK_DAYS);
    const [availability, entries] = await Promise.all([
      listDiaryAvailabilitySafe({
        siteId,
        practitionerIds,
        fromDayKey: chunk[0],
        toDayKey: chunk[chunk.length - 1],
      }),
      listEntries(siteId, chunk),
    ]);

    // A chunk we could not read contributes NOTHING rather than contributing
    // "everybody is free": an unreadable week must never manufacture a proposal.
    // It is COUNTED, though, because an empty list built from unreadable days is
    // a confident empty, and "nobody can do this" is a very different answer from
    // "we could not find out".
    if (availability.failed) {
      chunksSkipped += 1;
      continue;
    }
    const parsed = parseAvailabilityWindows(availability.rows);
    if (parsed.total > 0 && parsed.untagged / parsed.total > UNTAGGED_FAIL_RATIO) {
      chunksSkipped += 1;
      continue;
    }
    // Breaks we could not read are the same problem: proposing a slot over
    // somebody's lunch is the error this whole feature exists to prevent.
    if (entries.failed) {
      chunksSkipped += 1;
      continue;
    }
    chunksRead += 1;

    for (const dayKey of chunk) {
      const onThisDay = windowAppointments.appointments.filter(
        (a) => a.siteId === siteId && londonDayKey(new Date(a.start)) === dayKey,
      );
      const { openMin, closeMin } = openingWindowFor(site.openingHours, dayKey);
      const bounds = dayBounds(onThisDay.map(spanOf), openMin, closeMin);

      const clinicians: ProposalClinician[] = practitionersRead.practitioners.flatMap((p) => {
        const mine = onThisDay.filter((a) => a.practitionerId === p.id);
        const booked = mine.filter((a) => occupies(a.state)).map(spanOf);
        // A clinician we cannot place at THIS practice on THIS day contributes
        // NOTHING. Never a narrowed window, never a warning: a proposal that
        // might be at another practice is not a proposal.
        if (
          !availabilityTrustedHere({
            sharedWithAnotherSite: sharedRead.shared.has(p.id),
            rosterUnknown: sharedRead.rosterUnknown,
            bookedHere: booked.length > 0,
          })
        ) {
          return [];
        }
        return {
          practitionerId: p.id,
          practitionerName: p.name,
          siteId,
          // Availability windows ONLY, never the working-spans union: a proposal
          // must sit inside a genuine window, not inside time we inferred from
          // somebody having been booked there once.
          windows: windowsFor(parsed.windows, p.id, dayKey).map((w) => ({
            startMin: w.startMin,
            endMin: w.endMin,
          })),
          booked,
          breaks: occupyingEntries(entries.entries, p.id)
            .filter((e) => e.day === dayKey)
            .map((e) => ({ startMin: e.startMin, endMin: e.endMin })),
        };
      });

      days.push({ dayKey, bounds, clinicians });
    }
  }

  // NOT A SINGLE READABLE DAY. Returning an empty list here would print "Nobody
  // who can do Hygiene has free time" and "0 clinicians can do this treatment",
  // which is a confident empty built entirely out of a failed read. Say what
  // actually happened instead.
  if (chunksRead === 0) {
    return Response.json(
      {
        ok: false,
        error:
          "The diary could not be read for that period, so no times can be proposed. Nothing has been changed.",
      },
      { status: 503 },
    );
  }

  const input: ProposalInput = {
    familySlug,
    durationMin: effectiveMinutes(appointment),
    previousPractitionerId: appointment.practitionerId,
    days,
    caps,
  };

  const proposals = proposeSlots(input);
  // ALWAYS returned, even when the list is full: a blank result with no
  // explanation is a confident empty, and "nobody can do this" needs a different
  // action from "nobody is free" and from "we never recorded who can do this".
  const breakdown = proposalBreakdown(input);

  return Response.json({
    ok: true,
    proposals,
    // Some of the period could not be read, so the list may be short for a reason
    // that has nothing to do with who is free. The panel says so.
    partial: chunksSkipped > 0,
    daysNotRead: chunksSkipped * CHUNK_DAYS,
    seeded,
    seededNotice: seeded ? SEEDED_CAPABILITIES_NOTICE : null,
    breakdown,
    treatment,
    familySlug,
    windowDays,
    windowFrom,
    windowTo,
    durationMin: input.durationMin,
    siteName: site.name,
  });
}
