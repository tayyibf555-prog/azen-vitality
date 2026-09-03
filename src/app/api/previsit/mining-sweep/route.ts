import { dentallyScopeRefused, runWithDentallyPriority } from "@/lib/dentally/budget";
import { DentallyClient } from "@/lib/dentally/client";
import { normaliseAppointmentState, isAttendedState } from "@/lib/dentally/appointment-state";
import { dentallyReadKey } from "@/lib/dentally/read";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { isSystemEnabled } from "@/lib/systems/repository";
import { SITES, dentallySiteId } from "@/lib/mock/clients";
import { MINING_MIN_AGE, ageAt, matchExtraction, sanitiseFreeText } from "@/lib/triage/extraction-match";
import {
  MINING_MAX_PAGES_PER_WINDOW,
  MINING_MAX_PATIENT_READS_PER_RUN,
  nextWindow,
} from "@/lib/triage/mining";
import { getCoverage, recordScanRun, upsertCandidate } from "@/lib/triage/mining-repository";
import { TRIAGE_SYSTEM_SLUG } from "@/lib/triage/types";

// ===========================================================================
// THE IMPLANT-INTEREST MINING SWEEP. Read-only, bounded, resumable, honest.
//
// It walks BACKWARDS through the appointment book one window at a time, looks for
// extraction text, resolves each distinct patient once for a date of birth, and
// records both the candidates AND how far back it has read.
//
// ---------------------------------------------------------------------------
// WHY BACKWARDS THROUGH THE DIARY RATHER THAN A PATIENT SCAN.
// ---------------------------------------------------------------------------
// Established by probe, not assumed. There is no Dentally read that answers "every
// patient who has ever had an extraction":
//
//   /v1/appointments          the ONLY endpoint carrying plain-English procedure
//                             text (`reason`). Practice-wide but DATE-WINDOWED:
//                             site_id + on / after / before, no patient filter.
//   /v1/treatment_plan_items  practice-wide, ~999,000 rows, and it carries NO
//                             treatment name at all — only treatment_id and a
//                             staff `nomenclature` code. A full scan is ~9,900
//                             pages against an hourly budget of 3,600 shared with
//                             production; the reports pager abandons on page one
//                             when meta.total already exceeds the budget.
//   /v1/invoices              line items exist ONLY on the per-invoice detail
//                             route and `include=` is ignored on the index. One
//                             GET per invoice across ~34,000 invoices.
//
// So the window is the only bounded read that answers the question at all, and
// this job's honesty comes from RECORDING THE WINDOW rather than from pretending
// it read everything. `previsit_mining_scan` holds the covered range and the
// screen prints it beside the count.
//
// ---------------------------------------------------------------------------
// THE BOUNDS, AND WHY THE WINDOW ONLY ADVANCES ON A CLEAN RUN.
// ---------------------------------------------------------------------------
//   MINING_DAYS_PER_RUN              30 days of book per run
//   MINING_MAX_PAGES_PER_WINDOW      12 pages x 100 rows, per site per window
//   MINING_MAX_PATIENT_READS_PER_RUN 120 distinct getPatient calls
//
// The patient reads are the expensive half. When a run hits that cap, or when the
// shared Dentally budget refuses, the coverage window is NOT advanced: recording
// a window as covered when its patients were never resolved would be exactly the
// false-completeness this job exists to avoid. The next run re-reads the same
// window, the appointment upserts are idempotent, and coverage moves only once a
// window has genuinely been finished.
// ===========================================================================

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CLIENT_ID = "vitality";
const PER_PAGE = 100;

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

interface Hit {
  patientId: string;
  at: string;
  matchedText: string;
}

async function handleWithDentallyPriority(request: Request): Promise<Response> {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  // The kill switch, fail-closed for this default-off slug. Switching the module
  // off stops the list being built as well as the sends: a practice that has
  // turned the feature off should not find its implant list has grown overnight.
  if (!(await isSystemEnabled(CLIENT_ID, TRIAGE_SYSTEM_SLUG))) {
    return Response.json({ ok: true, skipped: "system off" });
  }

  const apiKey = dentallyReadKey();
  if (!apiKey) return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });

  if (!(await acquireCronLock("sweep-previsit-mining", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
    const now = new Date();
    const client = new DentallyClient({
      apiKey,
      baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
      readOnly: true,
    });

    // One distinct-patient budget for the WHOLE run, shared across sites, because
    // the ceiling is about Dentally requests and not about any one site.
    let patientReads = 0;
    const dob = new Map<string, { name: string; dateOfBirth: string | null } | null>();
    const perSite: Array<Record<string, unknown>> = [];

    for (const site of SITES.filter((s) => s.clientId === CLIENT_ID)) {
      if (dentallyScopeRefused() || patientReads >= MINING_MAX_PATIENT_READS_PER_RUN) break;

      const coverage = await getCoverage(site.id);
      const window = nextWindow(coverage, now);
      if (!window) {
        perSite.push({ siteId: site.id, skipped: "horizon reached" });
        continue;
      }

      let examined = 0;
      let pagesRead = 0;
      let ranOutOfBook = false;
      const hits = new Map<string, Hit>();

      for (let page = 1; page <= MINING_MAX_PAGES_PER_WINDOW; page += 1) {
        if (dentallyScopeRefused()) break;
        let rows: unknown[] = [];
        try {
          const res = await client.listAppointments({
            siteId: dentallySiteId(site.id),
            fromDate: window.from,
            toDate: window.to,
            page,
            perPage: PER_PAGE,
          });
          rows = res.appointments ?? [];
        } catch (err) {
          console.warn(`[previsit/mining] appointment read failed ${site.id} ${window.from} p${page}`, err);
          break;
        }
        pagesRead += 1;
        if (rows.length === 0) {
          ranOutOfBook = true;
          break;
        }
        for (const raw of rows) {
          examined += 1;
          const a = asRecord(raw);
          const patientId = pickString(a, "patient_id", "patientId");
          const start = pickString(a, "start_time", "start", "date");
          if (!patientId || !start) continue;
          // The patient must actually have TURNED UP. A booked-but-cancelled or
          // did-not-attend extraction is not an extraction, and the matcher's own
          // veto is only the belt to this braces.
          const state = normaliseAppointmentState(pickString(a, "state", "status"), "");
          if (!isAttendedState(state)) continue;
          const hit = matchExtraction({
            reason: pickString(a, "reason") ?? null,
            treatment: pickString(a, "treatment", "treatment_name") ?? null,
          });
          if (!hit) continue;
          // Keep the MOST RECENT extraction per patient inside this window.
          const prev = hits.get(patientId);
          if (!prev || prev.at < start) {
            hits.set(patientId, { patientId, at: start, matchedText: sanitiseFreeText(hit.source) });
          }
        }
        if (rows.length < PER_PAGE) {
          ranOutOfBook = true;
          break;
        }
      }

      // Resolve each distinct patient ONCE, up to the run's shared budget.
      let candidates = 0;
      let excludedNoDob = 0;
      let excludedUnderAge = 0;
      let resolvedAll = true;

      for (const hit of hits.values()) {
        if (patientReads >= MINING_MAX_PATIENT_READS_PER_RUN || dentallyScopeRefused()) {
          resolvedAll = false;
          break;
        }
        if (!dob.has(hit.patientId)) {
          patientReads += 1;
          dob.set(hit.patientId, await readPatient(client, hit.patientId));
        }
        const p = dob.get(hit.patientId) ?? null;
        if (!p) {
          // A patient we could not READ is not the same as a patient with no date
          // of birth, and it must not be counted as one. The window is left
          // unfinished so the next run tries again.
          resolvedAll = false;
          continue;
        }
        const age = ageAt(p.dateOfBirth, now);
        if (age === null) {
          excludedNoDob += 1;
          continue;
        }
        if (age < MINING_MIN_AGE) {
          excludedUnderAge += 1;
          continue;
        }
        const isNew = await upsertCandidate({
          siteId: site.id,
          dentallyPatientId: hit.patientId,
          patientName: p.name,
          age,
          lastExtractionAt: hit.at,
          matchedText: hit.matchedText,
        });
        if (isNew) candidates += 1;
      }

      // THE WINDOW ADVANCES ONLY ON A CLEAN RUN. If the patient budget ran out, a
      // read failed, or the shared Dentally budget refused, the coverage row is
      // left where it was and this window is re-read next time. Recording a window
      // as covered when its patients were never resolved is the false completeness
      // this whole job is shaped to avoid.
      const clean = resolvedAll && !dentallyScopeRefused();
      if (clean) {
        await recordScanRun({
          siteId: site.id,
          coveredFrom: window.from,
          coveredTo: coverage ? coverage.coveredTo : window.to,
          examined,
          candidates,
          excludedNoDob,
          excludedUnderAge,
          // There is more to read unless this window came back short AND we have
          // walked past the horizon; nextWindow answers the second half next time.
          moreToRead: !ranOutOfBook || nextWindow({ coveredFrom: window.from }, now) !== null,
          now: now.toISOString(),
        });
      }

      perSite.push({
        siteId: site.id,
        window,
        pagesRead,
        examined,
        matched: hits.size,
        candidates,
        excludedNoDob,
        excludedUnderAge,
        coverageAdvanced: clean,
      });
    }

    return Response.json({
      ok: true,
      patientReads,
      budgetRefused: dentallyScopeRefused(),
      sites: perSite,
    });
  } finally {
    await releaseCronLock("sweep-previsit-mining");
  }
}

async function readPatient(
  client: DentallyClient,
  patientId: string,
): Promise<{ name: string; dateOfBirth: string | null } | null> {
  try {
    const res = await client.getPatient(patientId);
    const p = asRecord(res.patient);
    const first = pickString(p, "first_name", "firstName") ?? "";
    const last = pickString(p, "last_name", "lastName") ?? "";
    const name = `${first} ${last}`.trim() || pickString(p, "name") || "";
    if (name === "") return null;
    return { name, dateOfBirth: pickString(p, "date_of_birth", "dateOfBirth") ?? null };
  } catch (err) {
    console.warn(`[previsit/mining] could not read patient ${patientId}`, err);
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  // BACKGROUND priority. This is a nightly job walking historical book, and it
  // shares the practice's 3,600/hour budget with everything a person is looking
  // at right now; it must be the first thing refused when the practice is busy.
  return runWithDentallyPriority("background", () => handleWithDentallyPriority(request));
}

export async function GET(request: Request): Promise<Response> {
  return POST(request);
}
