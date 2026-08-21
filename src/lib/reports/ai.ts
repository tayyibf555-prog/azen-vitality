// Prompt builder for the AI business review (Reports section). Pure (no network)
// so the route stays thin and the prompt is testable. It frames the model as a
// practice-growth adviser writing a concise weekly or monthly review from the REAL
// activity snapshot, and never invents numbers beyond it. The snapshot carries only
// live figures (enquiries, bookings, response time), so the prompt cannot narrate
// spend, revenue, return on spend or compliance: those have no live source yet.

import { SNAPSHOT_LEAD_LIMIT } from "./snapshot";
import type { ReportPeriod, ReportSnapshot } from "./snapshot";

/** Strip dash characters and tidy whitespace (house style: no em/en-dash). */
export function cleanLine(s: string): string {
  return s.replace(/[—–]/g, ", ").replace(/[ \t]+\n/g, "\n").trim();
}

/** Label for the period used throughout the prompt ("weekly" / "monthly"). */
function periodWord(period: ReportPeriod): string {
  return period === "week" ? "weekly" : "monthly";
}

/** A first-response time in plain English ("42 seconds" / "3 minutes"). */
function responseLabel(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function buildReportPrompt(
  snapshot: ReportSnapshot,
  period: ReportPeriod,
  practiceName: string,
): { system: string; user: string } {
  const pw = periodWord(period);
  const system = [
    `You are a sharp practice-growth adviser writing a concise ${pw} business review for the owner of ${practiceName}, a UK dental practice.`,
    "You are given only the practice's live enquiry and booking activity for the period. Cover what came in, how quickly enquiries were responded to, and how many converted to booked consultations. Be specific and use only the numbers given.",
    "Write for a busy owner: clear, practical, and honest about what to improve.",
    "Produce: a short punchy headline; 3 to 5 highlights (one line each); 2 to 4 short sections, each with a title and a body of 2 to 4 sentences; and 3 to 4 concrete recommendations the owner can act on next.",
    "British English. GBP with the £ symbol. No em-dash or en-dash. Never frame anything as NHS or private. Do not use double-quote characters inside any string value. Do NOT invent numbers or metrics beyond the ones you are given: you have no ad-spend, revenue, return-on-spend or compliance figures, so do not mention, estimate or imply them.",
    'Respond with ONLY a JSON object: {"headline": "...", "highlights": ["..."], "sections": [{"title": "...", "body": "..."}], "recommendations": ["..."]}.',
  ].join("\n");

  const lines: string[] = [
    `Review period: ${pw} (${snapshot.windowLabel}).`,
    `Enquiries received: ${snapshot.enquiries}.`,
    `Consultations booked: ${snapshot.booked}.`,
    `Enquiry to booked conversion: ${Math.round(snapshot.enquiryToBookedRate * 100)} percent.`,
  ];
  if (snapshot.avgFirstResponseSeconds !== null) {
    lines.push(
      `Average first response time to a new enquiry: ${responseLabel(snapshot.avgFirstResponseSeconds)}.`,
    );
  }
  if (snapshot.topSource) {
    lines.push(
      `Most common enquiry source: ${snapshot.topSource.source} (${snapshot.topSource.count} enquiries).`,
    );
  }
  // A BUSY PERIOD IS REVIEWED, BUT NOT ALL OF ITS FIGURES ARE TOTALS.
  //
  // The enquiry and booking counts are counted in the database and exact however
  // busy the period was. The response time and the source mix need the rows, and the
  // rows are bounded, so on a period past that bound they describe its most recent
  // enquiries only. The model is told which is which in the same breath it is given
  // them, because a sampled average narrated as the period's average is precisely
  // the kind of confident wrong number this snapshot exists to prevent.
  if (snapshot.truncated) {
    lines.push(
      `Note on these figures: the enquiry and booking counts are exact totals for the whole period.`,
      `The average first response time and the most common source are measured over the ${SNAPSHOT_LEAD_LIMIT} most recent enquiries in the period, not all of them. If you use either, say plainly that it is measured over the most recent enquiries, and never state it as the figure for every enquiry in the period.`,
    );
  }

  return { system, user: lines.join("\n") };
}
