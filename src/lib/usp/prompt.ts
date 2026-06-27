// Pure helpers for USPs: sanitising owner input, and the single guarded prompt
// line that injects the practice's selling points into every AI agent / draft.
// No I/O, fully unit-tested. Centralising the injection line here means the
// patient-facing guardrails (no em-dash, no over-promise, no clinical guarantee)
// are enforced in exactly one place for all six prompt builders.

const USP_MAX = 140;

/**
 * Normalise an owner-supplied USP: replace em/en dashes (forbidden in all
 * patient-facing copy) with commas, collapse whitespace, trim, cap length.
 * Returns null when nothing usable remains, so callers can reject it.
 */
export function sanitiseUspText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw
    .replace(/[—–]/g, ", ") // em-dash / en-dash -> comma
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*,+/g, ", ") // collapse any doubled commas the replace created
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ") // collapse doubled spaces the comma inserts can create
    .trim()
    .replace(/^[,;.\s]+|[,;\s]+$/g, "") // strip leading/trailing punctuation noise
    .trim();
  if (s.length === 0) return null;
  // Cap length, then re-strip trailing punctuation in case the cut landed after a comma.
  return s.slice(0, USP_MAX).replace(/[,;.\s]+$/g, "").trim() || null;
}

/**
 * The single guarded line injected into an agent/draft system prompt. Returns
 * null when there are no USPs (so the caller filters it out and the prompt is
 * unchanged). The line itself contains no em-dash and instructs the model to use
 * the points naturally, never as a clinical guarantee and never over-promising.
 */
export function uspPromptLine(usps: string[] | null | undefined): string | null {
  const clean = (usps ?? [])
    .map((u) => sanitiseUspText(u))
    .filter((u): u is string => u !== null);
  if (clean.length === 0) return null;
  return (
    "- The practice's selling points, which you may mention naturally only where they genuinely fit the conversation: " +
    clean.join("; ") +
    ". Never present these as a clinical guarantee and never over-promise."
  );
}
