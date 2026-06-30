// Prompt builder for the AI compliance readiness check. Pure (no network) so the
// route stays thin and the prompt is testable. It is framed as decision-support,
// not legal advice or a substitute for the practice's compliance lead.

export interface ReadinessInput {
  practiceName: string;
  overallScore: number;
  kloes: { label: string; score: number; status: string; openItems: number }[];
  overdueAudits: string[];
  dueAudits: string[];
  policiesNeedingAttention: string[];
  trainingExpiring: string[];
}

/** Strip dash characters and tidy whitespace (house style: no em/en-dash). */
export function cleanLine(s: string): string {
  return s.replace(/[—–]/g, ", ").replace(/[ \t]+\n/g, "\n").trim();
}

export function buildReadinessPrompt(input: ReadinessInput): { system: string; user: string } {
  const system = [
    `You are an experienced UK dental practice compliance adviser briefing the owner of ${input.practiceName}. You know CQC (the five key lines of enquiry: Safe, Effective, Caring, Responsive, Well-led), GDC standards, HTM 01-05, IR(ME)R, and the usual practice obligations.`,
    "Given the practice's current compliance position, brief the owner clearly and practically.",
    "Produce: a prioritised action list (most urgent first), each action tied to the relevant area or regulation and a one-line reason it matters for an inspection; a short inspection-readiness view (2 to 3 sentences) covering where the practice is strong and where the gaps sit across the five key lines of enquiry; and a few quick wins.",
    "This is decision-support and an organiser only. It is not legal advice and does not replace the practice's compliance lead, a specialist consultant, or CQC sign-off. Do not invent obligations that are not implied by the data given.",
    "British English. No em-dash or en-dash. Do not use double-quote characters inside any string value.",
    'Respond with ONLY a JSON object: {"priorities": [{"action": "...", "area": "...", "urgency": "high|medium|low"}], "inspectionView": "...", "quickWins": ["..."]}. Give 3 to 6 priorities and 2 to 4 quick wins.',
  ].join("\n");

  const kloeLines = input.kloes
    .map((k) => `- ${k.label}: score ${k.score}, status ${k.status}, ${k.openItems} open item(s)`)
    .join("\n");
  const user = [
    `Overall readiness score: ${input.overallScore}/100.`,
    `Five key lines of enquiry:\n${kloeLines}`,
    `Overdue audits/checks: ${input.overdueAudits.length ? input.overdueAudits.join("; ") : "none"}.`,
    `Audits/checks due soon: ${input.dueAudits.length ? input.dueAudits.join("; ") : "none"}.`,
    `Policies needing attention: ${input.policiesNeedingAttention.length ? input.policiesNeedingAttention.join("; ") : "none"}.`,
    `Training expiring or overdue: ${input.trainingExpiring.length ? input.trainingExpiring.join("; ") : "none"}.`,
  ].join("\n");

  return { system, user };
}
