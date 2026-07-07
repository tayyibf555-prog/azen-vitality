import { getClient } from "@/lib/mock";
import { getViewSiteIds } from "@/lib/site-view";
import { listPatients, searchPatients, type PatientRecord } from "@/lib/dentally/read";
import { listTargets } from "@/lib/recall/repository";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

// The row shape returned to the command palette and the patients table. A superset
// of the palette's fields (id/name/phone/siteId), so it stays compatible.
interface PatientRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  siteId: string;
  active: boolean;
  lastVisitAt: string | null;
  recallDueAt: string | null;
}

function toRow(p: PatientRecord): PatientRow {
  return {
    id: p.id,
    name: p.name,
    phone: p.phone,
    email: p.email,
    siteId: p.siteId,
    active: p.active,
    lastVisitAt: p.lastVisitAt,
    recallDueAt: p.recallDueAt,
  };
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
    .map((t) => ({
      id: t.dentallyPatientId,
      name: t.patientName,
      phone: null,
      email: null,
      siteId: t.siteId,
      active: true,
      lastVisitAt: t.lastVisitAt,
      recallDueAt: t.dueAt,
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
