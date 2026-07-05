// Canonicalise a Dentally appointment `state` into the app's lowercase vocabulary.
//
// Real Dentally states are Title Case with spaces — "Pending", "Confirmed",
// "Arrived", "In surgery", "Completed", "Cancelled", "Did not attend" — while
// every consumer (the diary gap/done sets, the daily-brief gap count, the
// no-show terminal checks and risk history) compares lowercase underscored
// strings. Normalising once at the ingestion boundary keeps both the real API
// and the mock's legacy vocabulary ("booked", "did_not_attend") working
// everywhere downstream.
export function normaliseAppointmentState(raw: unknown, fallback = "booked"): string {
  if (typeof raw !== "string") return fallback;
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return s === "" ? fallback : s;
}
