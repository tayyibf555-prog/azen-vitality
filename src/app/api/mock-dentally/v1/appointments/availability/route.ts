import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/appointments/availability
//   ?start_time=ISO&finish_time=ISO&duration=&practitioner_ids[]=...
// Mirrors the LIVE Dentally contract (calibrated 2026-07-11): availability is per
// practitioner, start/finish are ISO DATETIMES (the older site_id/start_date shape
// 400s on the real API with "start_time is missing"), and every returned row
// carries its practitioner_id. Returns a few fixed open slots across the window.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const startRaw = url.searchParams.get("start_time");
  const finishRaw = url.searchParams.get("finish_time");
  if (!startRaw || !finishRaw) {
    // Fail exactly like live Dentally so a miscalibrated caller is caught in dev.
    return Response.json(
      {
        error: {
          type: "invalid_request_error",
          message: "The appointment could not be processed",
          params: { start_time: ["is missing"], finish_time: ["is missing"] },
        },
      },
      { status: 400 },
    );
  }
  const practitionerIds = url.searchParams.getAll("practitioner_ids[]");
  const ids = practitionerIds.length > 0 ? practitionerIds : ["prac-1", "prac-2"];
  const durationMin = Number(url.searchParams.get("duration") ?? "30") || 30;

  const startMs = Date.parse(startRaw);
  const base = Number.isNaN(startMs) ? Date.now() : startMs;
  const dayStart = (offset: number, hour: number) => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + offset);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const slot = (startIso: string, practitionerId: string) => ({
    start_time: startIso,
    finish_time: new Date(Date.parse(startIso) + durationMin * 60_000).toISOString(),
    available_duration: durationMin,
    practitioner_id: practitionerId,
  });
  const availability = [
    slot(dayStart(1, 9), ids[0]!),
    slot(dayStart(1, 15), ids[Math.min(1, ids.length - 1)]!),
    slot(dayStart(2, 11), ids[0]!),
    slot(dayStart(4, 16), ids[Math.min(1, ids.length - 1)]!),
  ].filter((s) => Date.parse(s.finish_time) <= (Date.parse(finishRaw) || Infinity));
  return Response.json({ availability });
}
