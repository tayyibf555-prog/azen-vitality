// Turns a stored smile-assessment responses map ({ questionId: optionValue })
// into human-readable "question => answer" lines for AI prompt context — the
// instant first-contact draft and the two-way booking agent both use these so
// outreach is grounded in what the enquirer actually told us. Pure, no I/O.
//
// Two questions are skipped on purpose:
// - treatment: denormalised onto the lead as `treatmentInterest` and already in
//   every prompt separately; repeating it would double-weight it.
// - budget/funding: both consumers FORBID referencing money or how the person
//   would pay, so the answer has zero sanctioned use in a prompt, and its labels
//   deliberately avoid the deterministic guardrail's funding tokens, meaning a
//   parroted "covered by a plan" could reach a patient unchecked. The score
//   already captures funding intent; the raw answer never enters a prompt.
// Labels come from OUR question bank (never patient-typed text), so they are
// safe to inject without sanitisation. Unknown question ids or option values
// (an old submission after the bank changed) are skipped rather than guessed.

import { QUIZ_QUESTIONS, Q_TREATMENT, Q_BUDGET } from "./quiz";

export function answerLines(responses: Record<string, string> | null | undefined): string[] {
  if (!responses) return [];
  const lines: string[] = [];
  // Iterate the bank (not the map) so the order is stable and meaningful.
  for (const q of QUIZ_QUESTIONS) {
    if (q.id === Q_TREATMENT || q.id === Q_BUDGET) continue;
    const value = responses[q.id];
    if (!value) continue;
    const label = q.options.find((o) => o.value === value)?.label;
    if (!label) continue;
    lines.push(`${q.prompt} => ${label}`);
  }
  return lines;
}
