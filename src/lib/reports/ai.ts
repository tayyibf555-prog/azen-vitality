// Prompt builder for the AI business review (Reports section). Pure (no network)
// so the route stays thin and the prompt is testable. It frames the model as a
// practice-growth adviser writing a concise weekly or monthly review for the
// owner from the period snapshot, and never invents numbers beyond it.

import type { ReportPeriod, ReportSnapshot } from "./snapshot";

/** Strip dash characters and tidy whitespace (house style: no em/en-dash). */
export function cleanLine(s: string): string {
  return s.replace(/[—–]/g, ", ").replace(/[ \t]+\n/g, "\n").trim();
}

/** Label for the period used throughout the prompt ("weekly" / "monthly"). */
function periodWord(period: ReportPeriod): string {
  return period === "week" ? "weekly" : "monthly";
}

export function buildReportPrompt(
  snapshot: ReportSnapshot,
  period: ReportPeriod,
  practiceName: string,
): { system: string; user: string } {
  const pw = periodWord(period);
  const system = [
    `You are a sharp practice-growth adviser writing a concise ${pw} business review for the owner of ${practiceName}, a UK dental practice.`,
    "Cover what happened over the period: how acquisition spend turned into leads, then booked patients, then revenue and return on spend; how conversion is performing; how lifecycle and retention (recall and reactivation of existing patients) are contributing; and where the compliance position stands.",
    "Be specific and use the numbers from the data given. Write for a busy owner: clear, practical, and honest about what to improve.",
    "Produce: a short punchy headline; 3 to 5 highlights (one line each); 3 to 4 short sections, each with a title and a body of 2 to 4 sentences; and 3 to 4 concrete recommendations the owner can act on next.",
    "British English. GBP with the £ symbol. No em-dash or en-dash. Never frame anything as NHS or private. Do not use double-quote characters inside any string value. Do not invent numbers beyond the snapshot you are given.",
    'Respond with ONLY a JSON object: {"headline": "...", "highlights": ["..."], "sections": [{"title": "...", "body": "..."}], "recommendations": ["..."]}.',
  ].join("\n");

  const lines: string[] = [
    `Review period: ${pw} (${snapshot.windowLabel}).`,
    `Acquisition spend: £${snapshot.spendGbp}.`,
    `Leads (enquiries): ${snapshot.leads}.`,
    `New patients: ${snapshot.newPatients}.`,
    `Revenue attributed to acquisition: £${snapshot.revenueGbp}.`,
    `Return on spend: ${snapshot.returnX}x.`,
    `Cost per new patient: £${snapshot.costPerNewPatientGbp}.`,
  ];
  if (snapshot.topChannel) {
    lines.push(
      `Best channel by return on spend: ${snapshot.topChannel.name} at ${snapshot.topChannel.roiX}x.`,
    );
  }
  if (snapshot.weakestChannel) {
    lines.push(
      `Weakest paid channel by return on spend: ${snapshot.weakestChannel.name} at ${snapshot.weakestChannel.roiX}x.`,
    );
  }
  lines.push(
    `Conversion: ${Math.round(snapshot.enquiryToPatientRate * 100)} percent of enquiries became new patients; ${Math.round(snapshot.bookedToAttendedRate * 100)} percent of booked consultations were attended.`,
    `Lifecycle and retention revenue (recall and reactivation of existing patients): £${snapshot.lifecycleRevenueGbp}.`,
    `Compliance readiness score: ${snapshot.complianceScore} out of 100, with ${snapshot.auditsOverdue} audit(s) overdue.`,
  );
  if (snapshot.trendDirection) {
    lines.push(`New-patient trend versus the previous month: ${snapshot.trendDirection}.`);
  }

  return { system, user: lines.join("\n") };
}
