import { dentallyScopeRefused, runWithDentallyPriority } from "@/lib/dentally/budget";
import { DentallyClient } from "@/lib/dentally/client";
import { normaliseAppointmentState, isAttendedState } from "@/lib/dentally/appointment-state";
import { dentallyReadKey } from "@/lib/dentally/read";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { isSystemEnabled } from "@/lib/systems/repository";
import { SITES, getSite, dentallySiteId } from "@/lib/mock/clients";
import { isSuppressed } from "@/lib/messaging/suppression";
import { loadExcludedTargetKeys, excludedTargetKey } from "@/lib/patient-status/repository";
import { classifyProcedure } from "@/lib/postop/flag";
import { postopCheckInBody, projectPostopFacts, checkPostopMessage } from "@/lib/postop/copy";
import { decideSend, dueAtFor } from "@/lib/postop/schedule";
import {
  upsertTargetIfNew,
  listTargets,
  insertDraft,
  stopTarget,
} from "@/lib/postop/repository";
import { postopConfig } from "@/lib/postop/types";
import type { PostopTarget } from "@/lib/postop/types";

// ===========================================================================
// THE POST-OP SWEEP. It flags, and it drafts. It does not send.
//
// Two passes, deliberately separate:
//
//   PASS 1 (flag)   read the last two days of appointments, keep the ones whose
//                   free text says a procedure happened AND whose state says the
//                   patient actually turned up, and record each one ONCE.
//   PASS 2 (draft)  for every recorded procedure now due, compose the fixed
//                   check-in and store it as a DRAFT for a human to release.
//
// Splitting them means a Dentally outage during pass 1 cannot lose a check-in that
// was already flagged yesterday, and a database problem in pass 2 cannot cause the
// same procedure to be flagged twice tomorrow.
//
// NOTHING THIS ROUTE PRODUCES CAN BE DELIVERED. insertDraft writes postop_touch and
// moves the target to awaiting_approval; it does not write postop_outbox, and no
// other path in this file does either. The shared drain lists postop_outbox rows
// with status 'queued', so a draft is invisible to it.
//
// WHY A HUMAN RELEASES IT. The approval is not about the WORDS — the message is a
// fixed template and cannot be edited — it is about the PATIENT. The person who
// looks at this list is deciding "should we text this one at all", which is the one
// judgement in the whole flow that belongs to the practice: a patient who was in
// difficulty, one who is already booked back in tomorrow, one whose relative has
// already rung. The agent expansion plan's own rule for anything touching a
// patient's clinical state is draft-for-approval first, and this is that.
// ===========================================================================

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CLIENT_ID = "vitality";
const DAY = 86_400_000;
const PER_PAGE = 100;
/** Pages of appointments read per site. 3 x 100 comfortably covers two days at any
 *  of these sites; the cap exists so a mis-filtered query cannot walk the book. */
const MAX_PAGES_PER_SITE = 3;

function vitalitySiteIds(): string[] {
  return SITES.filter((s) => s.clientId === CLIENT_ID).map((s) => s.id);
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
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

interface FlaggedAppointment {
  appointmentId: string;
  patientId: string;
  /** ISO. The finish time where Dentally gives one, else the start. */
  procedureAt: string;
  reason: string;
}

/**
 * Map one raw appointment, keeping it only if a procedure actually happened.
 *
 * TWO conditions, and both are necessary. The STATE must say the patient turned up
 * (`isAttendedState`: completed, arrived, in surgery) — a booked-but-cancelled
 * extraction must never generate a check-in, and neither must a did-not-attend.
 * And the free text must classify as a procedure, which is where flag.ts's
 * consultation/review exclusions do their work.
 */
function flagAppointment(raw: unknown): (FlaggedAppointment & { flag: ReturnType<typeof classifyProcedure> }) | null {
  const a = asRecord(raw);
  const appointmentId = pickString(a, "id");
  const patientId = pickString(a, "patient_id", "patientId");
  const start = pickString(a, "start_time", "start", "date");
  if (!appointmentId || !patientId || !start) return null;

  const state = normaliseAppointmentState(pickString(a, "state", "status"), "");
  if (!isAttendedState(state)) return null;

  const flag = classifyProcedure({
    reason: pickString(a, "reason") ?? null,
    treatment: pickString(a, "treatment", "treatment_name") ?? null,
  });
  if (!flag) return null;

  return {
    appointmentId,
    patientId,
    procedureAt: pickString(a, "finish_time", "finish") ?? start,
    reason: flag.source,
    flag,
  };
}

interface PatientFacts {
  name: string;
  consentSms: boolean;
  consentEmail: boolean;
}

/**
 * The patient's name and consent flags, read from Dentally.
 *
 * CONSENT DEFAULTS TO FALSE HERE, which is the opposite of the no-show sync's
 * `?? true`. That module is sending a transactional appointment confirmation the
 * patient asked for by booking; this one is initiating contact about a clinical
 * matter, and "the field was absent so we assumed yes" is not a consent record
 * anybody would defend. A patient whose flags cannot be read gets no check-in.
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
      consentEmail: pickBoolean(p, "use_email", "email") ?? false,
    };
  } catch (err) {
    console.warn(`[postop] could not read patient ${patientId}; not flagging`, err);
    return null;
  }
}

async function handleWithDentallyPriority(request: Request): Promise<Response> {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  // KILL SWITCH, FIRST AND FAIL-CLOSED FOR THIS SLUG.
  //
  // 'postop-checkin' is declared defaultEnabled:false in the systems catalog, so
  // isSystemEnabled resolves the ABSENCE of a system_toggle row to DISABLED, and a
  // toggle-read ERROR to disabled too. For every other module an absent row means
  // ON; a brand new send surface aimed at post-operative patients must never be
  // armed by a row nobody wrote or by a database blip.
  if (!(await isSystemEnabled(CLIENT_ID, "postop-checkin"))) {
    return Response.json({ ok: true, skipped: "system off" });
  }

  const apiKey = dentallyReadKey();
  if (!apiKey) return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });

  // Never overlap: two runs would flag the same appointments and draft twice for
  // the same patient. The lease outlives maxDuration (300s) so a slow run cannot
  // have the next tick start underneath it; a crashed run self-heals when the lease
  // expires. (The upsert is idempotent as well, so this is belt and braces.)
  if (!(await acquireCronLock("sweep-postop", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
    const now = new Date();
    const config = postopConfig();
    const siteIds = vitalitySiteIds();
    // READ-ONLY. The latch (client.ts assertWritable) means a future caller reaching
    // for the handy client already in scope throws rather than writing to the book.
    const client = new DentallyClient({
      apiKey,
      baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
      readOnly: true,
    });

    // -----------------------------------------------------------------------
    // PASS 1: flag.
    // -----------------------------------------------------------------------
    const from = dayKey(new Date(now.getTime() - 2 * DAY));
    const to = dayKey(now);
    let examined = 0;
    let flagged = 0;
    let skippedNoFacts = 0;
    const flagCounts: Record<string, number> = {};

    for (const siteId of siteIds) {
      if (dentallyScopeRefused()) break;
      for (let page = 1; page <= MAX_PAGES_PER_SITE; page += 1) {
        if (examined >= config.maxExaminedPerRun || dentallyScopeRefused()) break;
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
          console.warn(`[postop] appointment read failed for ${siteId} page ${page}`, err);
          break;
        }
        if (rows.length === 0) break;
        for (const raw of rows) {
          if (examined >= config.maxExaminedPerRun) break;
          examined += 1;
          const hit = flagAppointment(raw);
          if (!hit || !hit.flag) continue;
          const dueAt = dueAtFor(hit.procedureAt, config);
          // An undatable procedure gets no check-in: without a time we cannot say
          // whether the message would be timely or three days late.
          if (!dueAt) continue;
          const facts = await patientFacts(client, hit.patientId);
          if (!facts) {
            skippedNoFacts += 1;
            continue;
          }
          const created = await upsertTargetIfNew({
            siteId,
            dentallyPatientId: hit.patientId,
            appointmentId: hit.appointmentId,
            patientName: facts.name,
            procedureFlag: hit.flag.flag,
            procedureSource: hit.flag.source,
            procedureAt: hit.procedureAt,
            dueAt,
            consentSms: facts.consentSms,
            consentEmail: facts.consentEmail,
          });
          if (created) {
            flagged += 1;
            flagCounts[hit.flag.flag] = (flagCounts[hit.flag.flag] ?? 0) + 1;
          }
        }
        if (rows.length < PER_PAGE) break;
      }
    }

    // -----------------------------------------------------------------------
    // PASS 2: draft. No Dentally read at all — everything needed was mirrored in
    // pass 1, so a budget refusal above still lets yesterday's flags be drafted.
    // -----------------------------------------------------------------------
    const pending = await listTargets({
      siteIds,
      statuses: ["pending"],
      limit: config.maxExaminedPerRun,
    });
    const excludedKeys = await loadExcludedTargetKeys();

    let drafted = 0;
    let waiting = 0;
    let stopped = 0;
    let refused = 0;
    const stopReasons: Record<string, number> = {};
    const refusalReasons: Record<string, number> = {};

    for (const target of pending) {
      if (drafted >= config.maxDraftsPerRun) break;

      const decision = decideSend(target, now, config);
      if (decision.action === "drop") {
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

      // SMS only. A post-op check is a short question that wants a short answer on
      // the handset in the patient's hand; an email would sit unread and its reply
      // would never reach the triage path at all.
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

      const drafting = composeDraft(target);
      if (!drafting.ok) {
        // A message that fails its own scan is NOT stored. Nothing about a message
        // that broke a rule should exist in a place a human could release it from.
        // This is unreachable for the shipped templates (copy.test.ts scans all
        // three), so a hit here means a template was edited into a violation and it
        // is loud on purpose.
        refused += 1;
        refusalReasons[drafting.category] = (refusalReasons[drafting.category] ?? 0) + 1;
        console.error(
          `[postop] refused to draft for ${target.id} (${drafting.category}: ${drafting.detail}); nothing stored`,
        );
        await stopTarget(target.id, "staff_stopped");
        stopped += 1;
        continue;
      }

      await insertDraft({
        targetId: target.id,
        siteId: target.siteId,
        channel: "sms",
        body: drafting.body,
      });
      drafted += 1;
    }

    return Response.json({
      ok: true,
      examined,
      flagged,
      flagCounts,
      skippedNoFacts,
      drafted,
      waiting,
      stopped,
      refused,
      queued: 0, // the sweep never queues: approval is the only route to the outbox
      stopReasons,
      refusalReasons,
    });
  } finally {
    await releaseCronLock("sweep-postop");
  }
}

type ComposeResult =
  | { ok: true; body: string }
  | { ok: false; category: string; detail: string };

/**
 * Compose the check-in and scan it before it can be stored.
 *
 * There is no model here: the body is a template with two substitutions. The scan
 * still runs, because "the template is safe" is a claim about the file as it is
 * today and this is the check that keeps it true tomorrow.
 */
function composeDraft(target: PostopTarget): ComposeResult {
  const projected = projectPostopFacts({
    patientName: target.patientName,
    practiceName: getSite(target.siteId)?.name ?? "",
  });
  if (!projected.ok) {
    return { ok: false, category: "missing_facts", detail: projected.missing.join(",") };
  }
  const body = postopCheckInBody(target.procedureFlag, projected.facts);
  const scan = checkPostopMessage(body, { firstName: projected.facts.firstName });
  if (!scan.ok) return { ok: false, category: scan.category, detail: scan.matched };
  return { ok: true, body };
}

// Scheduled work: nobody is waiting on this run, so it takes the practice's shared
// Dentally quota at BACKGROUND priority and is starved first. Pinned by
// src/lib/dentally/budget-priority-coverage.test.ts.
export async function POST(request: Request): Promise<Response> {
  return runWithDentallyPriority("background", () => handleWithDentallyPriority(request));
}

// pg_cron / Vercel Cron trigger with GET; same handler.
export const GET = POST;
