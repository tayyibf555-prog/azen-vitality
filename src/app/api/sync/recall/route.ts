import { DentallyClient } from "@/lib/dentally/client";
import {
  classifyRecall,
  rankByDue,
  DEFAULT_CONFIG,
  type RecallConfig,
  type RecallInput,
} from "@/lib/recall/normalise";
import {
  upsertTargets,
  listTargets,
  markGraduated,
  setTargetStatus,
  getCadenceByTarget,
  updateCadence,
  getSyncState,
  setSyncState,
  getBackfillCursor,
  setBackfillCursor,
} from "@/lib/recall/repository";
import { londonOverdueDays } from "@/lib/time/london";
import { SITES, dentallySiteId } from "@/lib/mock/clients";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";

import { dentallyReadKey } from "@/lib/dentally/read";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RESOURCE = "recall";
const PER_PAGE = 100;
const DAY = 86_400_000;
// Hard per-run cap on patients processed, so a large backlog can't blow the 300s
// function limit. The high-water mark only advances past fully-processed records,
// so the next cron tick resumes where this one stopped.
const MAX_PATIENTS_PER_RUN = 300;

// ===========================================================================
// CALIBRATION: confirm these field paths against the live Dentally sandbox.
// Recall needs much less than reactivation: just patient recall dates, consent,
// and whether a future appointment exists. No treatment plans or invoices.
// ===========================================================================

type Raw = Record<string, unknown>;

function asRecord(v: unknown): Raw {
  return v && typeof v === "object" ? (v as Raw) : {};
}
function pickString(o: Raw, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") return v;
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

function patientUpdatedAt(p: Raw): string | undefined {
  return pickString(p, "updated_at", "updatedAt");
}

function mapPatient(p: Raw, fallbackId: string): RecallInput["patient"] {
  return {
    id: pickString(p, "id") ?? fallbackId,
    first_name: pickString(p, "first_name", "firstName") ?? "",
    last_name: pickString(p, "last_name", "lastName") ?? "",
    use_sms: pickBoolean(p, "use_sms", "sms"),
    use_email: pickBoolean(p, "use_email", "email"),
    marketing: pickBoolean(p, "marketing"),
    dentist_recall_date: pickString(p, "dentist_recall_date", "dentistRecallDate") ?? null,
    hygienist_recall_date: pickString(p, "hygienist_recall_date", "hygienistRecallDate") ?? null,
  };
}

/** Whether any future appointment exists (a patient already coming in is not a recall candidate). */
function summariseAppointments(payload: { appointments: unknown[] }, now: Date): {
  lastVisitAt: string | null;
  futureBookingExists: boolean;
} {
  const appts = Array.isArray(payload.appointments) ? payload.appointments : [];
  let lastVisitAt: string | null = null;
  let futureBookingExists = false;
  for (const raw of appts) {
    const a = asRecord(raw);
    const startIso = pickString(a, "start_time", "start", "date", "appointment_date");
    if (!startIso) continue;
    const t = new Date(startIso).getTime();
    if (t > now.getTime()) {
      futureBookingExists = true;
    } else if (!lastVisitAt || new Date(startIso).getTime() > new Date(lastVisitAt).getTime()) {
      lastVisitAt = startIso;
    }
  }
  return { lastVisitAt, futureBookingExists };
}

// ===========================================================================
// END CALIBRATION block.
// ===========================================================================

function config(): RecallConfig {
  return {
    leadWindowDays: Number(process.env.RECALL_LEAD_WINDOW_DAYS ?? DEFAULT_CONFIG.leadWindowDays),
    // Mirror reactivation's grace so the seam stays airtight.
    graceDays: Number(
      process.env.RECALL_GRACE_DAYS ?? process.env.REACTIVATION_RECALL_GRACE_DAYS ?? DEFAULT_CONFIG.graceDays,
    ),
  };
}

function vitalitySiteIds(): string[] {
  return SITES.filter((s) => s.clientId === "vitality").map((s) => s.id);
}

/** Run `fn` over items with a small worker pool (bounds Dentally load + run time). */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

async function syncSite(
  client: DentallyClient,
  siteId: string,
  cfg: RecallConfig,
): Promise<{ siteId: string; pulled: number; upserted: number; processed: number; remaining: number; converted: number; mode: string; backfillPage: number | null }> {
  const now = new Date();

  // Backfill vs incremental (mirrors the reactivation sync, which hit the exact
  // same trap): Dentally's /v1/patients has NO sort control, so an updated_after
  // high-water mark + a per-run cap STRANDS almost the whole base on a
  // from-scratch pass — the first run's mark jumps to the newest updated_at among
  // its 300 patients and every older-updated patient is filtered out forever.
  // Until the one-time full pass finishes we page EVERY patient by page number
  // (cursor in sync_state.backfill_page/backfill_done); after that we switch to
  // the updated_after mark, which then only ever sees the small changed set.
  const cursor = await getBackfillCursor(siteId, RESOURCE);
  const backfilling = !cursor.done;
  const startPage = backfilling && cursor.page ? cursor.page + 1 : 1;
  const mainState = backfilling ? null : await getSyncState(siteId, RESOURCE);
  const updatedAfter = backfilling ? undefined : (mainState?.highWaterMark ?? undefined);

  // 1. Page patients, collecting raw records with NO per-patient I/O yet. BACKFILL
  //    takes WHOLE pages (the resume unit is a page); INCREMENTAL caps mid-page.
  //    Both bound the run (collection ≈ cap + one page), so failures during
  //    enrichment can never turn the run into an unbounded Dentally-quota burn.
  const pending: Array<{ p: Raw; patient: RecallInput["patient"]; page: number; excluded: boolean }> = [];
  let pulled = 0;
  let processed = 0;
  let remaining = 0;
  let lastCompletedPage = startPage - 1;
  let reachedEnd = false;

  for (let page = startPage; ; page += 1) {
    const res = await client.listPatients({ siteId: dentallySiteId(siteId), updatedAfter, page, perPage: PER_PAGE });
    const rawPatients = Array.isArray(res.patients) ? res.patients : [];
    pulled += rawPatients.length;

    for (const rawPatient of rawPatients) {
      const p = asRecord(rawPatient);
      const patient = mapPatient(p, "");
      if (!patient.id) continue;
      if (!backfilling && processed >= MAX_PATIENTS_PER_RUN) {
        remaining += 1;
        continue;
      }
      // Inactive / archived in Dentally (deceased, moved away, left the practice):
      // NEVER a recall candidate — a check-up reminder to a deceased patient's
      // phone is the worst message this system could send. Kept in `pending` (not
      // dropped) so any PREVIOUSLY-classified open rows for them are settled below.
      const excluded = p.active === false || p.archived === true;
      pending.push({ p, patient, page, excluded });
      processed += 1;
    }

    lastCompletedPage = page;
    if (rawPatients.length < PER_PAGE) {
      reachedEnd = true;
      break;
    }
    if (processed >= MAX_PATIENTS_PER_RUN) break; // resume from this boundary next run
  }

  // 2. Fetch each pending patient's appointments with bounded concurrency. A failed
  //    read leaves the patient un-enriched: skipped below and RETRIED next run —
  //    never classified on unread data, never silently dropped.
  const enriched = new Map<string, { lastVisitAt: string | null; futureBookingExists: boolean }>();
  await mapWithConcurrency(pending, 8, async ({ patient, excluded }) => {
    // Excluded patients need no appointment read (they are settled, not classified):
    // record a placeholder so they count as fully processed, never as a failure.
    if (excluded) {
      enriched.set(patient.id, { lastVisitAt: null, futureBookingExists: false });
      return;
    }
    try {
      // Page the patient's appointments: a single unpaged call caps at ~100 rows, so
      // a long-standing patient's FUTURE booking could sit on page 2 and be missed —
      // futureBookingExists would be a false negative and we'd send a recall to
      // someone who already has an appointment. Loop until a short page (bounded).
      const all: unknown[] = [];
      for (let ap = 1; ap <= 20; ap += 1) {
        const r = await client.getPatientAppointments(patient.id, ap, PER_PAGE);
        const rows = Array.isArray(r.appointments) ? r.appointments : [];
        all.push(...rows);
        if (rows.length < PER_PAGE) break;
      }
      enriched.set(patient.id, summariseAppointments({ appointments: all }, now));
    } catch {
      // leave unset -> skipped + retried next run
    }
  });

  // Open recall targets for this site, keyed by patient — used to STOP chasing a
  // patient who has booked directly with the practice (their cadence would
  // otherwise keep texting "book your check-up" at someone who already booked).
  const openTargets = await listTargets({ siteIds: [siteId], statuses: ["due", "in_cadence"] });
  const openByPatient = new Map<string, typeof openTargets>();
  for (const t of openTargets) {
    const list = openByPatient.get(t.dentallyPatientId) ?? [];
    list.push(t);
    openByPatient.set(t.dentallyPatientId, list);
  }
  let converted = 0;

  // 3. Classify enriched patients. The incremental mark advances only over
  //    FULLY-processed records; if anything failed, it is capped just below the
  //    earliest failed patient's updated_at so the next run re-pulls them (the
  //    feed is unordered — advancing past a failed patient loses them forever).
  const targets = [];
  let highWaterMark = updatedAfter ?? null;
  let minFailedUpdated: string | null = null;
  for (const { p, patient, excluded } of pending) {
    const updated = patientUpdatedAt(p);
    const data = enriched.get(patient.id);
    if (!data) {
      if (updated && (!minFailedUpdated || updated < minFailedUpdated)) minFailedUpdated = updated;
      continue;
    }

    // Inactive / archived: settle any open recall rows so an earlier classification
    // stops being chased the moment the flag lands in Dentally, and never classify.
    // 'exhausted' (not 'converted' — they did not book; not 'graduated' — they must
    // not be handed to reactivation, whose own filter also excludes them).
    if (excluded) {
      for (const open of openByPatient.get(patient.id) ?? []) {
        if (open.status === "in_cadence") {
          const cad = await getCadenceByTarget(open.id);
          if (cad && (cad.status === "active" || cad.status === "paused")) {
            await updateCadence(cad.id, { status: "exhausted", endedAt: now.toISOString() });
          }
        }
        await setTargetStatus(open.id, "exhausted");
      }
      if (updated && (!highWaterMark || updated > highWaterMark)) highWaterMark = updated;
      continue;
    }

    // Patient now has a future booking: settle any open recall for them as
    // converted and end a running cadence, so reminders stop immediately.
    if (data.futureBookingExists) {
      for (const open of openByPatient.get(patient.id) ?? []) {
        if (open.status === "in_cadence") {
          const cad = await getCadenceByTarget(open.id);
          if (cad && (cad.status === "active" || cad.status === "paused")) {
            await updateCadence(cad.id, { status: "converted", endedAt: now.toISOString() });
          }
        }
        await setTargetStatus(open.id, "converted");
        converted += 1;
      }
    }

    const input: RecallInput = {
      siteId,
      patient,
      lastVisitAt: data.lastVisitAt,
      futureBookingExists: data.futureBookingExists,
    };
    for (const target of classifyRecall(input, now, cfg)) targets.push(target);
    if (updated && (!highWaterMark || updated > highWaterMark)) highWaterMark = updated;
  }
  if (!backfilling && minFailedUpdated && highWaterMark && highWaterMark >= minFailedUpdated) {
    const capped = new Date(new Date(minFailedUpdated).getTime() - 1000).toISOString();
    highWaterMark = updatedAfter && capped < updatedAfter ? updatedAfter : capped;
  }

  const ranked = rankByDue(targets);
  await upsertTargets(ranked);

  // Reconcile previously-classified, unenrolled `due` targets that have aged past
  // the grace boundary: graduate them so they leave the recall worklist and
  // reactivation can adopt them (closes the seam double-coverage gap).
  const openDue = await listTargets({ siteIds: [siteId], statuses: ["due"] });
  for (const t of openDue) {
    // Whole London days, matching classification + the sweep's settle logic.
    if (londonOverdueDays(t.dueAt, now) > cfg.graceDays) {
      await markGraduated(t.id);
    }
  }

  // 4. Persist the cursor. Backfill only advances PAST pages whose patients were
  //    ALL enriched (rewind to just before the earliest failed page), and only
  //    completes when the final page was reached with nothing skipped — done and
  //    the incremental watermark are set in ONE atomic upsert.
  let firstFailedPage: number | null = null;
  if (backfilling) {
    for (const { patient, page: pg } of pending) {
      if (!enriched.has(patient.id) && (firstFailedPage === null || pg < firstFailedPage)) {
        firstFailedPage = pg;
      }
    }
  }
  const safeCursor = firstFailedPage !== null ? firstFailedPage - 1 : lastCompletedPage;
  const backfillComplete = backfilling && reachedEnd && firstFailedPage === null;

  if (backfilling) {
    if (backfillComplete) {
      await setBackfillCursor(siteId, RESOURCE, { page: lastCompletedPage, done: true, highWaterMark: now.toISOString() });
    } else {
      await setBackfillCursor(siteId, RESOURCE, { page: safeCursor, done: false });
    }
  } else if (highWaterMark && highWaterMark !== (updatedAfter ?? null)) {
    await setSyncState(siteId, RESOURCE, highWaterMark);
  }

  const mode = backfilling ? (backfillComplete ? "backfill-done" : "backfill") : "incremental";
  return {
    siteId,
    pulled,
    upserted: ranked.length,
    processed,
    remaining,
    converted,
    mode,
    backfillPage: backfilling ? safeCursor : null,
  };
}

export async function POST(request: Request) {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  const apiKey = dentallyReadKey();
  if (!apiKey) {
    return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });
  }
  // Never overlap with another recall sync: a slow run can outlive the next
  // hourly tick, and two runs double the Dentally load and race the high-water
  // mark. Lease slightly over maxDuration so a crashed run self-heals.
  if (!(await acquireCronLock("sync-recall", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
    const client = new DentallyClient({
      apiKey,
      baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
    });
    const cfg = config();
    // One site's failure must not abort the rest: record the error and move on so a
    // partial failure is observable and self-heals next tick (no all-or-nothing 500).
    const perSite: Array<Record<string, unknown>> = [];
    for (const siteId of vitalitySiteIds()) {
      try {
        perSite.push(await syncSite(client, siteId, cfg));
      } catch (e) {
        perSite.push({ siteId, error: String(e) });
      }
    }
    return Response.json({ ok: true, perSite });
  } finally {
    await releaseCronLock("sync-recall");
  }
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
