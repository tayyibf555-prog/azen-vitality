import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";

export const dynamic = "force-dynamic";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function randomId(): string {
  // appt-<random-ish> — good enough for a mock.
  return `appt-${Math.random().toString(36).slice(2, 10)}`;
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

  return Response.json(
    {
      appointment: {
        id: randomId(),
        ...appointment,
        booked_via_api: true,
        state: "pending",
      },
    },
    { status: 201 },
  );
}
