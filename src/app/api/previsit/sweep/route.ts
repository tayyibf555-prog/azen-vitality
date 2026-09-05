import { dentallyScopeRefused, runWithDentallyPriority } from "@/lib/dentally/budget";
import { DentallyClient } from "@/lib/dentally/client";
import { normaliseAppointmentState, isCancelledState, isDidNotAttendState } from "@/lib/dentally/appointment-state";
import { dentallyReadKey } from "@/lib/dentally/read";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { isSystemEnabled } from "@/lib/systems/repository";
import { liveSwitch } from "@/lib/systems/live-switch";
import { SITES, getSite, dentallySiteId } from "@/lib/mock/clients";
import { isSuppressed } from "@/lib/messaging/suppression";
import {
  loadExcludedTargetKeys,
  excludedTargetKey,
  isExclusionsUnavailable,
} from "@/lib/patient-status/repository";
import { forkForPaymentPlan } from "@/lib/triage/fork";
import { readPlanId } from "@/lib/calendar/funding";
import { buildTriageLink } from "@/lib/triage/link";
import { checkTriageMessage, previsitBody, projectTriageFacts } from "@/lib/triage/copy";
import { dayKey, decideSend, dueAtFor, scanWindow } from "@/lib/triage/schedule";
import { enqueueSend, listTargets, stopTarget, upsertTargetIfNew } from "@/lib/triage/repository";
import { TRIAGE_SYSTEM_SLUG, triageConfig } from "@/lib/triage/types";
import type { TriageTarget } from "@/lib/triage/types";

// ===========================================================================
// THE PRE-VISIT SWEEP. It flags upcoming appointments, queues links, and retires
// the ones the appointment has overtaken.
//
// Three passes, deliberately separate, exactly as post-op splits its own:
//
//   PASS 1 (flag)   read the appointment window ahead of us, keep the live ones,
//                   resolve each distinct patient ONCE, decide their bank from
//                   their payment plan, and record each appointment once.
//   PASS 2 (queue)  for every recorded appointment now due, compose the fixed
//                   message and put it in this module's own outbox.
//   PASS 3 (retire) stop every `queued` or `sent` target whose appointment has
//                   already started, or whose instant cannot be read at all.
//
// Splitting them means a Dentally outage during pass 1 cannot lose an appointment
// that was already flagged yesterday, and a database problem in pass 2 cannot
// cause the same appointment to be flagged twice tomorrow. Passes 2 and 3 make NO
// Dentally read at all, so a budget refusal above still lets yesterday's flags be
// sent and yesterday's links be retired.
//
// ---------------------------------------------------------------------------
// WHY PASS 3 EXISTS: `sent` HAD NO TERMINAL TRANSITION (ruling W3/5).
// ---------------------------------------------------------------------------
// Ruling W3/5 — "a queued pre-visit link is NEVER dispatched after its
// appointment start ... fail closed" — was implemented at the three DOORS: the
// drain drops a queued row past its appointment (dropRowsPastTheirAppointment),
// and /pv/[token] and /api/previsit/submit both refuse one. All three stop the
// harm; none of them retires the ROW. Pass 2 lists only `pending`, `stopTarget`
// was reachable only from that loop and from `recordNonDelivery`, and migration
// 0097 adds no trigger — so a delivered link stayed at `sent` for ever and the
// module's own counters climbed for ever with it. A worklist that never falls is
// a worklist nobody reads.
//
// So a `sent` or `queued` target whose appointment is behind us is stopped with
// the reason the module already has for exactly this — `expired`, until now
// reachable only from expireOutbox/recordNonDelivery. It sends nothing, it reads
// no Dentally endpoint, and it never touches a target whose appointment is still
// ahead: `now < start`, byte-for-byte the comparison the drain, the page and the
// submit route make, so all four agree about which side of the appointment we
// are on. An instant that cannot be parsed is retired too, the same fail-CLOSED
// direction decideSend takes for an undatable appointment.
//
// NOTE THE CRON TRUTH (ruling W3/7): /api/previsit/sweep is NOT REGISTERED in
// cron.job as at 5 Sep 2026, so this pass cannot run until the runbook's
// registration SQL is applied. That is exactly why the two public-door checks
// exist on their own and were not deferred to it.
//
// ---------------------------------------------------------------------------
// WHY THIS QUEUES DIRECTLY RATHER THAN DRAFTING FOR APPROVAL.
// ---------------------------------------------------------------------------
// The closer, the balance reminder and the post-op check-in all draft, because a
// human is deciding WHETHER to say something to a particular patient about their
// clinical or financial situation. This message says nothing about the patient at
// all: a fixed template with a first name and a link, sent to everybody who has
// an appointment. Asking a receptionist to approve four hundred identical texts a
// week is not a safety control, it is a guarantee the feature is never used. The
// no-show confirmation — the other appointment-relative, fixed-template,
// everybody-gets-one message — queues directly for exactly this reason.
//
// What replaces the approval is `checkTriageMessage`, which refuses to STORE a
// body that breaks a rule. Nothing that fails the scan reaches the outbox, so
// there is never a queued row a human would have had to catch.
//
// ---------------------------------------------------------------------------
// THE OWNER'S SWITCH IS RE-READ INSIDE BOTH LOOPS (ruling W3/4, 4 Sep 2026).
// ---------------------------------------------------------------------------
// This is a `maxDuration = 300` route holding a 310-second lease. Pass 1 walks up
// to `maxExaminedPerRun` appointment rows with one Dentally read per DISTINCT
// patient, so the verdict pass 2 acts on can be MINUTES old — the widest stale-
// verdict window of any sweep in the tree. An owner who switched the module off
// from System controls mid-tick would have had up to `maxQueuedPerRun` further
// links written into previsit_outbox behind them. Nothing would have been
// delivered while the switch stayed off (the drain re-reads it and skips this
// source), but the rows persist, and the drain's own comment says what happens
// next: they "drain the moment it is switched back on".
//
// So the shared gate (src/lib/systems/live-switch.ts) re-reads the switch every
// ten rows and never resumes inside the same tick. It is consulted FIRST in each
// loop, before `decideSend`/`stopTarget`/`enqueueSend`, so a stopping run retires
// nothing it did not intend to and leaves every un-queued target exactly as it
// was, at `pending`, for the next tick. `switchedOffMidRun` is reported in the
// response body so an operator can tell a stopped run from a quiet one.
//
// ---------------------------------------------------------------------------
// THE FORK IS RESOLVED HERE AND ONLY HERE.
// ---------------------------------------------------------------------------
// An appointment payload carries no payment plan, so pass 1 resolves each DISTINCT
// patient once (a map, not a read per appointment) and reads the plan off the
// patient object. `forkForPaymentPlan` fails to the SHORT list for everything it
// cannot prove is a private plan — NHS, UDC, an unknown id, no plan at all — and
// the value is written onto the target. Nothing downstream ever recomputes it.
// ===========================================================================

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CLIENT_ID = "vitality";
const PER_PAGE = 100;
/** Pages of appointments read per site. The window is ~26 hours wide at the
 *  shipped lead, which no single site fills three times over; the cap exists so a
 *  mis-filtered query cannot walk the whole book. */
const MAX_PAGES_PER_SITE = 4;

function vitalitySiteIds(): string[] {
  return SITES.filter((s) => s.clientId === CLIENT_ID).map((s) => s.id);
}

type Raw = Record<string, unknown>;

function asRecord(v: unknown): Raw {
  return v && typeof v === "object" ? (v as Raw) : {};
}

function pickString(o: Raw, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

function pickBoolean(o: Raw, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v === 1;
  }
  return undefined;
}

interface UpcomingAppointment {
  appointmentId: string;
  patientId: string;
  startsAt: string;
}

/**
 * Map one raw appointment, keeping it only if it is still a live booking.
 *
 * Cancelled and did-not-attend rows are dropped explicitly rather than by an
 * allow-list of live states, because the live vocabulary is open (booked,
 * pending, confirmed, arrived, in surgery) and a state nobody has seen yet should
 * still get its pre-visit form. Getting that wrong in this direction costs a
 * patient a form they could have filled in; getting it wrong the other way texts
 * somebody about an appointment they cancelled.
 */
function upcoming(raw: unknown): UpcomingAppointment | null {
  const a = asRecord(raw);
  const appointmentId = pickString(a, "id");
  const patientId = pickString(a, "patient_id", "patientId");
  const start = pickString(a, "start_time", "start", "date");
  if (!appointmentId || !patientId || !start) return null;
  const state = normaliseAppointmentState(pickString(a, "state", "status"), "");
  if (isCancelledState(state) || isDidNotAttendState(state)) return null;
  return { appointmentId, patientId, startsAt: start };
}

interface PatientFacts {
  name: string;
  consentSms: boolean;
  paymentPlanId: number | null;
}

/**
 * The patient's name, SMS consent and payment plan.
 *
 * CONSENT DEFAULTS TO FALSE, which is the opposite of the no-show sync's `?? true`.
 * That module sends a transactional confirmation the patient asked for by booking;
 * this one initiates contact to ask them questions, and "the field was absent so
 * we assumed yes" is not a consent record anybody would defend. A patient whose
 * flags cannot be read gets no link.
 *
 * A read that FAILS returns null and the appointment is not flagged at all. It is
 * not flagged with a guessed fork either: the whole point of the fork is that it
 * is proved, and a patient we could not read is a patient whose plan we do not
 * know.
 */
async function patientFacts(client: DentallyClient, patientId: string): Promise<PatientFacts | null> {
  try {
    const res = await client.getPatient(patientId);
    const p = asRecord(res.patient);
    const first = pickString(p, "first_name", "firstName") ?? "";
    const last = pickString(p, "last_name", "lastName") ?? "";
    const name = `${first} ${last}`.trim() || pickString(p, "name") || "";
    if (name === "") return null;
    return {
      name,
      consentSms: pickBoolean(p, "use_sms", "sms") ?? false,
      // Through the SHARED reader, which handles the flat `payment_plan_id` and
      // the nested `payment_plan.id`. A second hand-written pick is how two
      // screens drift about which patient is on which plan.
      paymentPlanId: readPlanId(p),
    };
  } catch (err) {
    console.warn(`[previsit] could not read patient ${patientId}; not flagging`, err);
    return null;
  }
}

async function handleWithDentallyPriority(request: Request): Promise<Response> {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  // KILL SWITCH, FIRST AND FAIL-CLOSED FOR THIS SLUG.
  //
  // 'pre-visit-triage' is declared defaultEnabled:false in the systems catalog, so
  // isSystemEnabled resolves the ABSENCE of a system_toggle row to DISABLED, and a
  // toggle-read ERROR to disabled too. For every other module an absent row means
  // ON; a brand new surface that texts patients a questionnaire must never be armed
  // by a row nobody wrote or by a database blip.
  if (!(await isSystemEnabled(CLIENT_ID, TRIAGE_SYSTEM_SLUG))) {
    return Response.json({ ok: true, skipped: "system off" });
  }

  const apiKey = dentallyReadKey();
  if (!apiKey) return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });

  // Never overlap: two runs would flag the same appointments and could queue two
  // links for one patient. The lease outlives maxDuration (300s) so a slow run
  // cannot have the next tick start underneath it; a crashed run self-heals when
  // the lease expires. The upsert is idempotent as well, so this is belt and braces.
  if (!(await acquireCronLock("sweep-previsit", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
    const now = new Date();
    const config = triageConfig();
    const siteIds = vitalitySiteIds();
    // THE OWNER'S SWITCH, RE-READ INSIDE BOTH BATCH LOOPS (ruling W1-B/5 as
    // applied to this sweep by W3/4). One gate for the whole run: once it has
    // read OFF it stays off, so a flicker cannot resume flagging or queueing
    // inside the same tick, and pass 2 is skipped entirely. It reads through
    // isSystemEnabledForSend, which for a default-OFF slug fails CLOSED whatever
    // MESSAGING_DRY_RUN says.
    const gate = liveSwitch(CLIENT_ID, TRIAGE_SYSTEM_SLUG);
    // READ-ONLY. The latch (client.ts assertWritable) means a future caller
    // reaching for the handy client already in scope throws rather than writing.
    const client = new DentallyClient({
      apiKey,
      baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
      readOnly: true,
    });

    // -----------------------------------------------------------------------
    // PASS 1: flag.
    // -----------------------------------------------------------------------
    const window = scanWindow(now, config);
    const from = dayKey(new Date(window.fromIso));
    const to = dayKey(new Date(window.toIso));
    let examined = 0;
    let flagged = 0;
    let skippedNoFacts = 0;
    const forkCounts: Record<string, number> = {};

    // One read per DISTINCT patient per run, not one per appointment. A patient
    // with a check-up and a hygiene visit in the same window is read once.
    const facts = new Map<string, PatientFacts | null>();

    for (const siteId of siteIds) {
      if (dentallyScopeRefused() || gate.switchedOffMidRun) break;
      for (let page = 1; page <= MAX_PAGES_PER_SITE; page += 1) {
        if (examined >= config.maxExaminedPerRun || dentallyScopeRefused() || gate.switchedOffMidRun) break;
        let rows: unknown[] = [];
        try {
          const res = await client.listAppointments({
            siteId: dentallySiteId(siteId),
            fromDate: from,
            toDate: to,
            page,
            perPage: PER_PAGE,
          });
          rows = res.appointments ?? [];
        } catch (err) {
          console.warn(`[previsit] appointment read failed for ${siteId} page ${page}`, err);
          break;
        }
        if (rows.length === 0) break;
        for (const raw of rows) {
          if (examined >= config.maxExaminedPerRun) break;
          // Consulted BEFORE the row is examined: the Dentally patient read below
          // is the expensive part of this pass and an owner who has just switched
          // the module off should not pay for another ten of them.
          if (!(await gate.stillOn())) break;
          examined += 1;
          const hit = upcoming(raw);
          if (!hit) continue;
          const dueAt = dueAtFor(hit.startsAt, config);
          // An undatable appointment gets no link: without a time we cannot say
          // whether the message would be timely or arrive after the visit.
          if (!dueAt) continue;
          // Already past, or already too late. Checked BEFORE the patient read so
          // a window edge does not cost a Dentally request per stale row.
          if (decideSend({ appointmentAt: hit.startsAt, dueAt }, now, config).action === "drop") {
            continue;
          }

          if (!facts.has(hit.patientId)) {
            facts.set(hit.patientId, await patientFacts(client, hit.patientId));
          }
          const f = facts.get(hit.patientId) ?? null;
          if (!f) {
            skippedNoFacts += 1;
            continue;
          }

          const fork = forkForPaymentPlan(f.paymentPlanId);
          const created = await upsertTargetIfNew({
            siteId,
            dentallyPatientId: hit.patientId,
            appointmentId: hit.appointmentId,
            patientName: f.name,
            fork,
            appointmentAt: hit.startsAt,
            dueAt,
            consentSms: f.consentSms,
          });
          if (created) {
            flagged += 1;
            forkCounts[fork] = (forkCounts[fork] ?? 0) + 1;
          }
        }
        if (gate.switchedOffMidRun) break;
        if (rows.length < PER_PAGE) break;
      }
    }

    // -----------------------------------------------------------------------
    // PASS 2: queue. No Dentally read at all.
    // -----------------------------------------------------------------------
    let queued = 0;
    let waiting = 0;
    let stopped = 0;
    let refused = 0;
    const stopReasons: Record<string, number> = {};
    const refusalReasons: Record<string, number> = {};

    // PASS 2 DOES NOT START once the switch has been read as off in pass 1. The
    // loop below would stop on its first row anyway (the gate never resumes
    // inside a tick), but not listing the targets at all means an owner who
    // switched the module off mid-run pays for no further reads, and cannot have
    // this tick answer "exclusions unavailable" about work it was never going to
    // do. Every target stays exactly as it was, at `pending`, for the next tick.
    const pending = gate.switchedOffMidRun
      ? []
      : await listTargets({
          siteIds,
          statuses: ["pending"],
          limit: config.maxExaminedPerRun,
        });
    // EXCLUSIONS UNKNOWN MEANS NOBODY MAY BE DRAFTED (ruling W1-B/2, 3 Sep 2026).
    // loadExcludedTargetKeys now REFUSES rather than returning an empty set when it
    // cannot read the override table and messaging is live, so a patient a human
    // marked inactive can never be drafted because of a database blip.
    let excludedKeys = new Set<string>();
    if (!gate.switchedOffMidRun) {
      try {
        excludedKeys = await loadExcludedTargetKeys();
      } catch (err) {
        if (!isExclusionsUnavailable(err)) throw err;
        console.error("[previsit] exclusion list unreadable while messaging is live; skipping this tick", err);
        // The WHOLE tick, pass 3 included. Retiring an overtaken link needs no
        // exclusion list and would be safe on its own, but a tick that cannot
        // read one of its inputs reports one outcome rather than a partial run
        // nobody can interpret — and nothing is lost: the next tick retires them.
        return Response.json({ ok: true, skipped: "exclusions unavailable" });
      }
    }

    for (const target of pending) {
      if (queued >= config.maxQueuedPerRun) break;
      // THE SWITCH, FIRST IN THE LOOP AND BEFORE ANY ROW MUTATION. Consulted
      // ahead of decideSend/stopTarget so a run stopped mid-batch retires
      // nothing: a target it never reached is untouched at `pending` for the
      // next tick rather than stopped as `stale` by a run the owner halted.
      if (!(await gate.stillOn())) break;

      const decision = decideSend(target, now, config);
      if (decision.action === "drop") {
        // ONE stop reason on the row for all three drops — stale, past and
        // undatable all mean "this link is no longer timely and was never sent",
        // which is the only distinction the patient's record needs. The finer
        // reason is counted in the run report below, where an operator reading a
        // spike of "undatable" learns something a stop reason column would not
        // have told them anyway.
        await stopTarget(target.id, "stale");
        stopped += 1;
        stopReasons[decision.reason] = (stopReasons[decision.reason] ?? 0) + 1;
        continue;
      }
      if (decision.action === "wait") {
        waiting += 1;
        continue;
      }

      // The patient is excluded from all targeting (inactive / do not contact).
      if (excludedKeys.has(excludedTargetKey(target.siteId, target.dentallyPatientId))) {
        await stopTarget(target.id, "excluded");
        stopped += 1;
        stopReasons.excluded = (stopReasons.excluded ?? 0) + 1;
        continue;
      }

      // SMS only at the point of QUEUING. The drain re-routes to WhatsApp when the
      // patient has chosen it and WhatsApp is both switched on and configured
      // (getChannelPref + resolvePreferredChannel), so the patient's preference is
      // honoured exactly as it is for every other module — it is simply resolved
      // at dispatch rather than here, which is where the platform keeps it.
      if (!target.consentSms) {
        await stopTarget(target.id, "no_consent");
        stopped += 1;
        stopReasons.no_consent = (stopReasons.no_consent ?? 0) + 1;
        continue;
      }

      const toRef = `patient:${target.dentallyPatientId}`;
      let suppressed: boolean;
      try {
        suppressed = await isSuppressed(target.siteId, "sms", toRef);
      } catch {
        // A suppression read that throws must never be read as "not opted out".
        // Leave the target pending; the next tick retries, and the staleness guard
        // retires it if the outage outlasts the window.
        waiting += 1;
        continue;
      }
      if (suppressed) {
        await stopTarget(target.id, "opted_out");
        stopped += 1;
        stopReasons.opted_out = (stopReasons.opted_out ?? 0) + 1;
        continue;
      }

      const composed = compose(target);
      if (!composed.ok) {
        // A message that fails its own scan is NOT stored. Nothing about a message
        // that broke a rule should exist anywhere the drain could reach. This is
        // unreachable for the shipped template (copy.test.ts scans it), so a hit
        // here means the template was edited into a violation, and it is loud.
        refused += 1;
        refusalReasons[composed.category] = (refusalReasons[composed.category] ?? 0) + 1;
        console.error(
          `[previsit] refused to queue for ${target.id} (${composed.category}: ${composed.detail}); nothing stored`,
        );
        await stopTarget(target.id, composed.category === "no_link" ? "no_link" : "staff_stopped");
        stopped += 1;
        continue;
      }

      await enqueueSend({
        targetId: target.id,
        siteId: target.siteId,
        channel: "sms",
        toRef,
        body: composed.body,
        // The due instant is already quiet-hours clamped (schedule.ts), so it is
        // the right not_before_at: the drain has no time-of-day gate of its own.
        notBeforeAt: target.dueAt,
      });
      queued += 1;
    }

    // -----------------------------------------------------------------------
    // PASS 3: retire. No Dentally read at all, and it sends nothing.
    // -----------------------------------------------------------------------
    let expired = 0;
    let expiredMore = false;

    // NOT STARTED once the switch has been read as off, for the same reason pass
    // 2 is not: a run the owner halted mutates no further rows, and a target it
    // never reached is left exactly as it was for the next tick.
    //
    // ORDERED BY appointment_at ASCENDING (listTargets), so the oldest — the ones
    // this pass exists for — are at the head of the page rather than behind a
    // year of live appointments. ONE ROW MORE than the bound is asked for so the
    // response can say honestly that there is more behind it (charter §0/5,
    // ruling W3/11) instead of printing a bare figure off a capped read.
    const liveRows = gate.switchedOffMidRun
      ? []
      : await listTargets({
          siteIds,
          statuses: ["queued", "sent"],
          limit: config.maxExaminedPerRun + 1,
        });
    const overdue = liveRows.slice(0, config.maxExaminedPerRun);

    for (const target of overdue) {
      // THE SWITCH, FIRST IN THE LOOP AND BEFORE ANY ROW MUTATION (W1-B/5 as
      // applied here by W3/4), exactly as pass 2 does it.
      if (!(await gate.stillOn())) break;
      const startMs = Date.parse(target.appointmentAt);
      // Still ahead of us: leave it alone. Every row after this one is later
      // still (the read is ordered by appointment_at), so there is nothing left
      // to retire in this page.
      if (Number.isFinite(startMs) && now.getTime() < startMs) break;
      await stopTarget(target.id, "expired");
      expired += 1;
    }
    // "At least this many": the page came back full AND every row on it was
    // retired, so the bound bit rather than the list ending.
    expiredMore = liveRows.length > config.maxExaminedPerRun && expired === overdue.length;

    return Response.json({
      ok: true,
      window: { from, to },
      // True when the owner switched the module off while this run was in flight.
      // An operator reading a short run needs to be able to tell that from a
      // quiet one, and from a crash.
      switchedOffMidRun: gate.switchedOffMidRun,
      examined,
      flagged,
      forkCounts,
      skippedNoFacts,
      patientReads: facts.size,
      queued,
      waiting,
      stopped,
      refused,
      stopReasons,
      refusalReasons,
      // Pass 3. `expiredMore` true means the bound bit: read this as "at least
      // `expired`", and the next tick will retire the rest.
      expired,
      expiredMore,
    });
  } finally {
    await releaseCronLock("sweep-previsit");
  }
}

type ComposeResult =
  | { ok: true; body: string }
  | { ok: false; category: string; detail: string };

/**
 * Compose the message and scan it before it can be stored.
 *
 * There is no model here: the body is a template with three substitutions. The
 * scan still runs, because "the template is safe" is a claim about the file as it
 * is today and this is the check that keeps it true tomorrow.
 */
function compose(target: TriageTarget): ComposeResult {
  const link = buildTriageLink(target.linkToken);
  const projected = projectTriageFacts({
    patientName: target.patientName,
    practiceName: getSite(target.siteId)?.name ?? "",
    link,
  });
  if (!projected.ok) {
    // A missing LINK is its own category, because it means PUBLIC_BASE_URL is
    // unset rather than that anything is wrong with this patient — and the
    // resulting stop reason should say so to whoever reads the worklist.
    const category = projected.missing.includes("link") ? "no_link" : "missing_facts";
    return { ok: false, category, detail: projected.missing.join(",") };
  }
  const body = previsitBody(projected.facts);
  const scan = checkTriageMessage(body, { firstName: projected.facts.firstName });
  if (!scan.ok) return { ok: false, category: scan.category, detail: scan.matched };
  return { ok: true, body };
}

export async function POST(request: Request): Promise<Response> {
  // BACKGROUND priority: this is a scheduled job and it shares the practice's
  // 3,600/hour Dentally budget with everything a person is looking at right now.
  return runWithDentallyPriority("background", () => handleWithDentallyPriority(request));
}

export async function GET(request: Request): Promise<Response> {
  return POST(request);
}
