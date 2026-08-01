import { getClient } from "@/lib/mock";
import { getViewSiteIds } from "@/lib/site-view";
import { listPatients, searchPatients, type PatientRecord } from "@/lib/dentally/read";
import type { PatientListRow } from "@/lib/patient/list-row";
import { listTargets } from "@/lib/recall/repository";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

/**
 * The row shape returned to the command palette and the patients table.
 *
 * It is now the FULL PatientRecord, not a reduced eight-field subset.
 *
 * Why that mattered: the subset dropped dateOfBirth, gender, title, the consent
 * flags, archivedReason and paymentPlanId, so a record opened from SEARCH (which
 * comes through this endpoint) showed a confident "Not on file" date of birth and a
 * confident "No marketing consent" for a patient who had both. A false negative on a
 * clinical record is worse than a slower payload, and the payload difference is a few
 * scalars per row.
 *
 * `partial` marks a row that is NOT a full Dentally read (see recallRows below).
 */
type PatientRow = PatientListRow;

function toRow(p: PatientRecord): PatientRow {
  return p;
}

type PatientFilter = "active" | "recall" | "lapsed" | "all";

function parseFilter(raw: string): PatientFilter {
  return raw === "recall" || raw === "lapsed" || raw === "all" ? raw : "active";
}

// The Recall-due rows are sourced from the recall engine, not the bounded patient
// list, so the segment is COMPLETE rather than capped at the first ~300. A patient
// may carry both a dentist and a hygienist recall; dedupe by Dentally patient id,
// keeping the most overdue, then sort most-overdue first.
async function recallRows(siteIds: string[]): Promise<PatientRow[]> {
  const targets = await listTargets({ siteIds, statuses: ["due", "in_cadence"] });
  const byPatient = new Map<string, (typeof targets)[number]>();
  for (const t of targets) {
    const prev = byPatient.get(t.dentallyPatientId);
    if (!prev || t.overdueDays > prev.overdueDays) byPatient.set(t.dentallyPatientId, t);
  }
  return [...byPatient.values()]
    .sort((a, b) => b.overdueDays - a.overdueDays)
    .map<PatientRow>((t) => ({
      id: t.dentallyPatientId,
      name: t.patientName,
      title: null,
      phone: null,
      email: null,
      siteId: t.siteId,
      active: true,
      archivedReason: null,
      lastVisitAt: t.lastVisitAt,
      recallDueAt: t.dueAt,
      dentistRecallAt: t.recallType === "dentist" ? t.dueAt : null,
      hygienistRecallAt: t.recallType === "hygienist" ? t.dueAt : null,
      dateOfBirth: null,
      gender: null,
      smsConsent: t.consent.sms,
      emailConsent: t.consent.email,
      paymentPlanId: null,
      // recall_target genuinely does not hold contact details, a date of birth or a
      // payment plan, so those nulls are NOT facts about the patient. Marked partial
      // so the table renders a dash with "Not loaded in this view" rather than the
      // claim "No contact", which is what it printed before and which was wrong for
      // every recall row. A dash is not a claim; "No contact" is.
      partial: true,
    }));
}

// GET /api/dentally/patients?client=<slug>&search=<q>&filter=<active|recall|lapsed|all>
// Serves BOTH the command palette and the patients-table filter/search. With ?search
// (>=1 char) it runs a server-side Dentally query across the whole base (filter is
// ignored). Without ?search it returns a segment of the BOUNDED fast list (first ~300)
// per ?filter, except `recall` which is sourced complete from the recall engine.
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const slug = params.get("client") ?? "";
  const search = params.get("search") ?? "";
  const filter = parseFilter(params.get("filter") ?? "active");
  const client = getClient(slug);
  if (!client) return Response.json({ ok: false, patients: [] }, { status: 404 });
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const siteIds = await getViewSiteIds(client.id);
  try {
    // Search spans the whole base and overrides the filter.
    if (search) {
      const patients = await searchPatients(siteIds, search);
      return Response.json({ ok: true, patients: patients.map(toRow) });
    }
    if (filter === "recall") {
      return Response.json({ ok: true, patients: await recallRows(siteIds) });
    }
    const patients = await listPatients(siteIds, { maxPages: 3 });
    const rows =
      filter === "active"
        ? patients.filter((p) => p.active)
        : filter === "lapsed"
          ? patients.filter((p) => !p.active)
          : patients; // "all"
    return Response.json({ ok: true, patients: rows.map(toRow) });
  } catch {
    return Response.json({ ok: false, patients: [] }, { status: 500 });
  }
}
