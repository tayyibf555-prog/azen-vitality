import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import {
  addAppointment,
  findPatient,
  MOCK_APPOINTMENTS as MOCK_APPOINTMENTS_BASE,
  resolveMockSiteId,
  type MockAppointment,
} from "@/app/api/mock-dentally/_fixtures";
import { generatedAppointments } from "@/app/api/mock-dentally/_dashboard-fixtures";

export const dynamic = "force-dynamic";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function randomId(): string {
  // appt-<random-ish> — good enough for a mock.
  return `appt-${Math.random().toString(36).slice(2, 10)}`;
}

function serialise(a: MockAppointment) {
  const p = findPatient(a.patient_id);
  const name = a.patient_name ?? (p ? `${p.first_name} ${p.last_name}` : "Patient");
  const duration = a.duration ?? 30;
  const finish = new Date(new Date(a.start_time).getTime() + duration * 60_000).toISOString();
  return {
    id: a.id,
    patient_id: a.patient_id,
    patient_name: name,
    site_id: a.site_id,
    start_time: a.start_time,
    finish_time: finish,
    duration,
    state: a.state,
    reason: a.reason ?? null,
    practitioner: a.practitioner ?? null,
    practitioner_id: a.practitioner_id ?? null,
    notes: a.notes ?? null,
  };
}

// GET /api/mock-dentally/v1/appointments?patient_id= | ?site_id=&on= / &after=&before=
//
// Mirrors the REAL Dentally list filters (calibrated 2026-07-05): date filtering
// is `on` (exact day) or `after`/`before` (treated as EXCLUSIVE here — callers pad
// each edge by a day, and the strict comparison verifies that padding). The old
// start_date/finish_date params are gone because real Dentally silently ignores
// them — the mock accepting invented params is exactly how the no-show
// miscalibration slipped through. Cancelled / did-not-attend rows are EXCLUDED
// unless cancelled=true, matching the real API's default.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const patientId = url.searchParams.get("patient_id");
  // Accept the real Dentally site UUID as well as our internal id.
  const siteId = resolveMockSiteId(url.searchParams.get("site_id"));
  const on = url.searchParams.get("on"); // exact YYYY-MM-DD
  const after = url.searchParams.get("after"); // YYYY-MM-DD, exclusive
  const before = url.searchParams.get("before"); // YYYY-MM-DD, exclusive
  const includeCancelled = url.searchParams.get("cancelled") === "true";

  // The hand-written fixtures are pinned to fixed dates in June 2026; the generated
  // book rolls with today. Both are served from the one list, exactly as one
  // practice's diary would be.
  const book = [...MOCK_APPOINTMENTS_BASE, ...generatedAppointments()];

  let rows: MockAppointment[];
  if (patientId) {
    rows = book.filter((a) => a.patient_id === patientId);
  } else if (siteId) {
    rows = book.filter((a) => a.site_id === siteId);
  } else {
    rows = [];
  }

  if (on) rows = rows.filter((a) => a.start_time.slice(0, 10) === on);
  if (after) rows = rows.filter((a) => a.start_time.slice(0, 10) > after);
  if (before) rows = rows.filter((a) => a.start_time.slice(0, 10) < before);
  if (!includeCancelled) {
    rows = rows.filter((a) => {
      const s = (a.state ?? "").toLowerCase().replace(/[\s-]+/g, "_");
      return s !== "cancelled" && s !== "did_not_attend";
    });
  }

  rows = [...rows].sort((a, b) => (a.start_time < b.start_time ? -1 : 1));

  // Paginate the site-appointment listing the way the real Dentally API does, so
  // callers that page a large window are exercised honestly against the mock and
  // never receive an unbounded array. Patient-scoped lookups stay unpaged (small).
  if (siteId && !patientId) {
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const perPage = Math.max(1, Number(url.searchParams.get("per_page") ?? "100") || 100);
    const start = (page - 1) * perPage;
    rows = rows.slice(start, start + perPage);
  }

  return Response.json({ appointments: rows.map(serialise) });
}

// POST /api/mock-dentally/v1/appointments
// Reads the real Dentally create shape { "appointment": {...} } and echoes the
// fields back wrapped in { appointment: {...} } with a generated id,
// booked_via_api: true and state: "pending". Responds 201.
export async function POST(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;

  let payload: Record<string, unknown>;
  try {
    payload = asRecord(await request.json());
  } catch {
    return Response.json(
      {
        error: {
          type: "invalid_request_error",
          message: "Request body must be valid JSON.",
        },
      },
      { status: 400 },
    );
  }

  const appointment = asRecord(payload["appointment"]);
  const id = randomId();
  const str = (k: string): string | undefined =>
    typeof appointment[k] === "string" ? (appointment[k] as string) : undefined;

  // Persist it so it can be found, rescheduled or cancelled later in this session.
  addAppointment({
    id,
    patient_id: str("patient_id") ?? "unknown",
    site_id: str("site_id") ?? "site-cc",
    start_time: str("start_time") ?? str("start") ?? new Date().toISOString(),
    state: "pending",
    patient_name: str("patient_name"),
    reason: str("treatment") ?? str("reason"),
    duration: 30,
  });

  return Response.json(
    {
      appointment: {
        id,
        ...appointment,
        booked_via_api: true,
        state: "pending",
      },
    },
    { status: 201 },
  );
}
