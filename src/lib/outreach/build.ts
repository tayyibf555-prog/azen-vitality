import { DentallyError } from "@/lib/dentally/client";
import { dentallyFromEnv } from "@/lib/dentally/read";
import { dentallySiteId } from "@/lib/mock/clients";
import { getCampaign, updateCampaign, insertTargets, type NewTarget } from "./repository";
import { prefilterOutcome, matchAppointmentHistory, type AppointmentLike } from "./filters";
import type { OutreachBuildCursor, OutreachCampaign } from "./types";
import { normaliseGender, type Gender } from "@/lib/patient/demographics";

// The resumable segment builder, extracted from the /api/outreach/build route so the
// SAME bounded machinery is the single source of truth for every caller: the cron/UI
// build route, the campaigns PATCH `start-build` action, and the co-pilot
// create_outreach_campaign tool. Each invocation scans a bounded slice of the
// campaign site's patient base, cheap-pre-filters, reads appointment history only for
// survivors, enrols matches, and persists the cursor so the next call resumes.

const PER_PAGE = 100;
// Bound EACH invocation so it stays gentle on the shared Dentally rate budget and
// short under maxDuration: at most this many patient-list pages scanned and this many
// per-patient appointment reads (the expensive stage). The cursor persists between
// calls so repeated invocations resume and eventually finish the base.
const MAX_PAGES_PER_RUN = 15;
const MAX_APPOINTMENT_READS_PER_RUN = 60;

type Raw = Record<string, unknown>;
function asRecord(v: unknown): Raw {
  return v && typeof v === "object" ? (v as Raw) : {};
}
function pickString(o: Raw, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}
function pickBool(o: Raw, ...keys: string[]): boolean {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "boolean") return v;
    if (v === 1) return true;
  }
  return false;
}

interface BuildPatient {
  id: string;
  name: string;
  phone: string | null;
  siteId: string;
  active: boolean;
  lastVisitAt: string | null;
  dateOfBirth: string | null;
  gender: Gender | null;
  smsConsent: boolean;
  emailConsent: boolean;
}

function mapPatient(raw: unknown, fallbackSiteId: string): BuildPatient {
  const p = asRecord(raw);
  const first = pickString(p, "first_name", "firstName") ?? "";
  const last = pickString(p, "last_name", "lastName") ?? "";
  return {
    id: pickString(p, "id") ?? "",
    name: `${first} ${last}`.trim() || "Patient",
    phone: pickString(p, "mobile_phone", "mobilePhone", "phone"),
    siteId: fallbackSiteId,
    active: p.active !== false && p.archived !== true,
    lastVisitAt: pickString(p, "last_visit_at", "lastVisitAt"),
    dateOfBirth: pickString(p, "date_of_birth", "dateOfBirth"),
    gender: normaliseGender(p.gender),
    smsConsent: pickBool(p, "use_sms", "sms"),
    emailConsent: pickBool(p, "use_email", "email"),
  };
}

function mapAppointments(payload: { appointments: unknown[] }): AppointmentLike[] {
  const rows = Array.isArray(payload.appointments) ? payload.appointments : [];
  return rows.map((raw) => {
    const a = asRecord(raw);
    return {
      start: pickString(a, "start_time", "start", "date") ?? "",
      reason: pickString(a, "reason"),
      state: pickString(a, "state") ?? undefined,
    };
  });
}

export function initBuildCursor(): OutreachBuildCursor {
  return { siteIndex: 0, page: 1, pageOffset: 0, done: false, scanned: 0, candidates: 0, matched: 0, contactable: 0, excludedMissingData: 0 };
}

export interface BuildTickResult {
  ok: boolean;
  done: boolean;
  stopped: "403" | "429" | null;
  scannedThisRun: number;
  appointmentReads: number;
  insertedThisRun: number;
  counts: Record<string, number>;
  cursor: OutreachBuildCursor | null;
  /** Present when the tick did nothing because the build was already complete. */
  skipped?: string;
  /** Present on failure (ok === false). */
  error?: string;
}

/**
 * Run ONE bounded, resumable build tick for an already-loaded campaign. Callers own
 * their auth + campaign load; this owns the Dentally scan, matching, enrolment and
 * cursor/counts persistence. Assumes the Dentally read key is configured (callers
 * check `dentallyReadKey()` first). Never throws: a failure returns ok:false so the
 * caller can map it to a status without unwinding the request.
 */
export async function runOutreachBuildTick(campaign: OutreachCampaign): Promise<BuildTickResult> {
  const campaignId = campaign.id;
  const cursor = campaign.buildCursor ?? initBuildCursor();
  if (cursor.done) {
    return {
      ok: true,
      done: true,
      stopped: null,
      scannedThisRun: 0,
      appointmentReads: 0,
      insertedThisRun: 0,
      counts: campaign.counts ?? {},
      cursor,
      skipped: "already built",
    };
  }

  // Mark building on the first tick so the UI/state reflects work in progress.
  if (campaign.status === "draft" || campaign.status === "ready") {
    await updateCampaign(campaignId, { status: "building" });
  }

  const client = dentallyFromEnv();
  const now = new Date();
  const siteId = campaign.siteId;

  let page = cursor.page;
  let pageOffset = cursor.pageOffset ?? 0;
  let scanned = cursor.scanned;
  let candidates = cursor.candidates;
  let matched = cursor.matched;
  let contactable = cursor.contactable ?? 0;
  let excludedMissingData = cursor.excludedMissingData ?? 0;
  let appointmentReads = 0;
  let pagesThisRun = 0;
  let consecutive403 = 0;
  let reachedEnd = false;
  let stopped: "403" | "429" | null = null;

  const enrol: NewTarget[] = [];
  // Enrol targets due immediately; the sweep's daily cap paces the first burst.
  const nextDueAt = now.toISOString();

  try {
    while (pagesThisRun < MAX_PAGES_PER_RUN && appointmentReads < MAX_APPOINTMENT_READS_PER_RUN) {
      let listRes: { patients?: unknown[] };
      try {
        listRes = await client.listPatients({ siteId: dentallySiteId(siteId), page, perPage: PER_PAGE });
      } catch (err) {
        // A 403/429 on the LIST read is a hard signal to stop and resume next tick.
        if (err instanceof DentallyError && (err.status === 403 || err.status === 429)) {
          stopped = err.status === 403 ? "403" : "429";
          break;
        }
        throw err;
      }
      const rawPatients = Array.isArray(listRes.patients) ? listRes.patients : [];
      pagesThisRun += 1;

      // Resume WITHIN the page: rows [0, pageOffset) were fully processed (counted and
      // enrolled) on a prior tick, so skip them cheaply. This is what makes a mid-page
      // budget/rate-limit stop genuinely resumable: the appointment-read budget is spent
      // on the UNSCANNED tail, never re-reading the head, and no row is counted twice.
      let idx = pageOffset;
      let budgetStop = false;
      for (; idx < rawPatients.length; idx++) {
        scanned += 1;
        const patient = mapPatient(rawPatients[idx], siteId);
        if (!patient.id) continue;
        // Cheap pre-filter, now including the age/gender demographic gates. A patient
        // dropped ONLY for a missing age/gender the filter needs is counted, so the
        // read-back can state how many records had no such data on file.
        const outcome = prefilterOutcome(patient, campaign.filters, now);
        if (outcome.excludedForMissingData) excludedMissingData += 1;
        if (!outcome.pass) continue;
        candidates += 1;

        // Expensive stage: read this candidate's appointment history (default excludes
        // cancelled / did-not-attend rows, so a matched visit is a real one).
        let appts: AppointmentLike[];
        try {
          const res = await client.getPatientAppointments(patient.id);
          appts = mapAppointments(res);
          appointmentReads += 1;
          consecutive403 = 0;
        } catch (err) {
          if (err instanceof DentallyError && err.status === 403) {
            consecutive403 += 1;
            // Stop-and-persist on two consecutive 403s (a permission/auth block on the
            // shared key): do not burn the run hammering a closed door. This row was
            // not evaluated, so roll back its eager counts and resume ON it next tick.
            if (consecutive403 >= 2) {
              scanned -= 1;
              candidates -= 1;
              stopped = "403";
              break;
            }
            continue; // single 403: skip this patient; move on
          }
          if (err instanceof DentallyError && err.status === 429) {
            // Rate-limited: roll back this row's eager counts and resume ON it next tick.
            scanned -= 1;
            candidates -= 1;
            stopped = "429";
            break;
          }
          continue; // transient: skip this patient; move on
        }

        const m = matchAppointmentHistory(appts, campaign.filters, now);
        if (m.matched) {
          matched += 1;
          // Consent is captured now (Dentally use_sms) but only ACTED on at send time,
          // so track how many matches are actually contactable for an honest read-back.
          if (patient.smsConsent) contactable += 1;
          enrol.push({
            campaignId,
            patientId: patient.id,
            name: patient.name,
            phone: patient.phone,
            siteId,
            matchedReason: m.matchedReason,
            consent: { sms: patient.smsConsent, email: patient.emailConsent, marketing: false },
            nextDueAt,
          });
        }

        // Budget spent: this row is fully processed (committed), so resume AFTER it.
        if (appointmentReads >= MAX_APPOINTMENT_READS_PER_RUN) {
          budgetStop = true;
          break;
        }
      }

      // Decide the resume point. A read-stop (403/429) leaves `idx` on the uncommitted
      // row, so retry it. A budget stop leaves `idx` on the last committed row, so
      // resume AFTER it. Otherwise every row was processed and the page is complete.
      const nextIdx = stopped ? idx : budgetStop ? idx + 1 : rawPatients.length;
      if (!stopped && nextIdx >= rawPatients.length) {
        // Page fully processed: clear the intra-page offset and advance the cursor.
        pageOffset = 0;
        if (rawPatients.length < PER_PAGE) {
          reachedEnd = true;
          break;
        }
        page += 1; // page fully processed; advance the resume point
        continue;
      }
      // Mid-run stop (budget or 403/429): leave `page` as-is and persist the intra-page
      // offset so the next tick resumes exactly where this one left off.
      pageOffset = nextIdx;
      break;
    }

    // Persist any newly matched targets before the cursor, so a crash after the cursor
    // advanced can never skip an unenrolled matched page (idempotent insert).
    const inserted = await insertTargets(enrol);

    const done = reachedEnd && !stopped;
    const newCursor: OutreachBuildCursor = {
      siteIndex: 0,
      // On a mid-run stop (budget or 403/429) `page` is left as-is and `pageOffset`
      // marks how far into it we got, so the next tick resumes at the unscanned tail;
      // on a clean page boundary `page` already advanced and `pageOffset` reset to 0.
      page,
      pageOffset,
      done,
      scanned,
      candidates,
      matched,
      contactable,
      excludedMissingData,
    };
    const counts = {
      scanned,
      candidates,
      matched,
      contactable,
      excludedMissingData,
      enrolled: (campaign.counts?.enrolled ?? 0) + inserted,
    };
    await updateCampaign(campaignId, {
      buildCursor: newCursor,
      counts,
      // A completed build lands 'ready'; an in-progress one stays 'building'.
      ...(done ? { status: "ready" as const } : {}),
    });

    return {
      ok: true,
      done,
      stopped,
      scannedThisRun: pagesThisRun * PER_PAGE,
      appointmentReads,
      insertedThisRun: inserted,
      counts,
      cursor: newCursor,
    };
  } catch (err) {
    console.error("[outreach] build failed", err);
    return {
      ok: false,
      done: false,
      stopped: null,
      scannedThisRun: pagesThisRun * PER_PAGE,
      appointmentReads,
      insertedThisRun: 0,
      counts: campaign.counts ?? {},
      cursor: campaign.buildCursor ?? null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Convenience wrapper for callers that only hold a campaign id (the co-pilot tool).
 * Loads the campaign, then runs one tick. Returns ok:false with an error when the
 * campaign is missing, so the caller does not need its own load+guard.
 */
export async function runOutreachBuildTickById(campaignId: string): Promise<BuildTickResult> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) {
    return {
      ok: false,
      done: false,
      stopped: null,
      scannedThisRun: 0,
      appointmentReads: 0,
      insertedThisRun: 0,
      counts: {},
      cursor: null,
      error: "campaign not found",
    };
  }
  return runOutreachBuildTick(campaign);
}
