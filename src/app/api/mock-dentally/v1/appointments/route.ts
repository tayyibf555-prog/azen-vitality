import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import {
  appointmentsForPatient,
  appointmentsForSite,
  addAppointment,
  findPatient,
  type MockAppointment,
} from "@/app/api/mock-dentally/_fixtures";

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
  };
}

// GET /api/mock-dentally/v1/appointments?patient_id= | ?site_id=&start_date=&finish_date=
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const patientId = url.searchParams.get("patient_id");
  const siteId = url.searchParams.get("site_id");
  const startDate = url.searchParams.get("start_date"); // inclusive YYYY-MM-DD
  const finishDate = url.searchParams.get("finish_date"); // inclusive YYYY-MM-DD

  let rows: MockAppointment[];
  if (patientId) {
    rows = appointmentsForPatient(patientId);
  } else if (siteId) {
    rows = appointmentsForSite(siteId);
  } else {
    rows = [];
  }

  if (startDate) rows = rows.filter((a) => a.start_time.slice(0, 10) >= startDate);
  if (finishDate) rows = rows.filter((a) => a.start_time.slice(0, 10) <= finishDate);

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
