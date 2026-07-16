import { DentallyError } from "@/lib/dentally/client";
import { dentallyFromEnv, dentallyReadKey } from "@/lib/dentally/read";
import { dentallySiteId } from "@/lib/mock/clients";
import { requireUser, requireOwnerRole, requireClientAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import {
  getCampaign,
  updateCampaign,
  insertTargets,
  type NewTarget,
} from "@/lib/outreach/repository";
import {
  prefilterPatient,
  matchAppointmentHistory,
  type AppointmentLike,
} from "@/lib/outreach/filters";
import type { OutreachBuildCursor } from "@/lib/outreach/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PER_PAGE = 100;
// Bound EACH invocation so it stays gentle on the shared Dentally rate budget and
// short under maxDuration: at most this many patient-list pages scanned and this
// many per-patient appointment reads (the expensive stage). The cursor persists
// between calls so repeated invocations resume and eventually finish the base.
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

function initCursor(): OutreachBuildCursor {
  return { siteIndex: 0, page: 1, done: false, scanned: 0, candidates: 0, matched: 0 };
}

function authorizedByCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production"; // fail-closed in production
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * POST /api/outreach/build  { campaignId }
 *
 * Resumable, bounded segment builder. Owner-only via requireUser, OR callable with
 * the CRON_SECRET (so a scheduled sweep can keep building a large campaign over
 * several ticks). Each call scans a bounded slice of the campaign site's patient
 * base, cheap-pre-filters, reads appointment history only for survivors, and enrolls
 * matches. Progress persists on the campaign's build_cursor so the next call resumes.
 */
export async function POST(request: Request): Promise<Response> {
  const cron = authorizedByCron(request);
  let authedUser: AuthedUser | null = null;
  if (!cron) {
    // Dashboard caller: must be a signed-in owner with access to the campaign's client.
    const user = await requireUser();
    if (user instanceof Response) return user;
    const ownerOnly = requireOwnerRole(user);
    if (ownerOnly) return ownerOnly;
    // requireUser returns null when auth is not enforced (pilot); the campaign's
    // client access is checked once it is loaded below.
    authedUser = user;
  }

  const apiKey = dentallyReadKey();
  if (!apiKey) return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });

  const body = (await request.json().catch(() => null)) as { campaignId?: unknown } | null;
  const campaignId = typeof body?.campaignId === "string" ? body.campaignId : "";
  if (!campaignId) return Response.json({ error: "campaignId required" }, { status: 400 });

  const campaign = await getCampaign(campaignId);
  if (!campaign) return Response.json({ error: "campaign not found" }, { status: 404 });

  // Enforce client access for a dashboard caller (a cron caller is trusted).
  if (authedUser) {
    const forbidden = requireClientAccess(authedUser, campaign.clientId);
    if (forbidden) return forbidden;
  }

  const cursor = campaign.buildCursor ?? initCursor();
  if (cursor.done) {
    return Response.json({ ok: true, done: true, counts: campaign.counts ?? {}, skipped: "already built" });
  }

  // Mark building on the first tick so the UI/state reflects work in progress.
  if (campaign.status === "draft" || campaign.status === "ready") {
    await updateCampaign(campaignId, { status: "building" });
  }

  const client = dentallyFromEnv();
  const now = new Date();
  const siteId = campaign.siteId;

  let page = cursor.page;
  let scanned = cursor.scanned;
  let candidates = cursor.candidates;
  let matched = cursor.matched;
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

      for (const raw of rawPatients) {
        scanned += 1;
        const patient = mapPatient(raw, siteId);
        if (!patient.id) continue;
        if (!prefilterPatient(patient, campaign.filters)) continue;
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
            // shared key): do not burn the run hammering a closed door.
            if (consecutive403 >= 2) {
              stopped = "403";
              break;
            }
            continue; // skip this patient; retried next run
          }
          if (err instanceof DentallyError && err.status === 429) {
            stopped = "429"; // rate-limited: back off, resume next tick
            break;
          }
          continue; // transient: skip; the page is re-scanned next run
        }

        const m = matchAppointmentHistory(appts, campaign.filters, now);
        if (!m.matched) continue;
        matched += 1;
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

        if (appointmentReads >= MAX_APPOINTMENT_READS_PER_RUN) break;
      }

      if (stopped) break;

      if (rawPatients.length < PER_PAGE) {
        reachedEnd = true;
        break;
      }
      page += 1; // page fully processed; advance the resume point
    }

    // Persist any newly matched targets before the cursor, so a crash after the
    // cursor advanced can never skip an unenrolled matched page (idempotent insert).
    const inserted = await insertTargets(enrol);

    const done = reachedEnd && !stopped;
    const newCursor: OutreachBuildCursor = {
      siteIndex: 0,
      // On a mid-run stop (budget or 403/429) leave `page` as-is so the next tick
      // re-scans the current page; on a clean page boundary `page` already advanced.
      page,
      done,
      scanned,
      candidates,
      matched,
    };
    const counts = { scanned, candidates, matched, enrolled: (campaign.counts?.enrolled ?? 0) + inserted };
    await updateCampaign(campaignId, {
      buildCursor: newCursor,
      counts,
      // A completed build lands 'ready'; an in-progress one stays 'building'.
      ...(done ? { status: "ready" as const } : {}),
    });

    return Response.json({
      ok: true,
      done,
      stopped,
      scannedThisRun: pagesThisRun * PER_PAGE,
      appointmentReads,
      insertedThisRun: inserted,
      counts,
      cursor: newCursor,
    });
  } catch (err) {
    console.error("[outreach] build failed", err);
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
