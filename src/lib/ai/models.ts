/** Anthropic model ids used across the platform.
 *
 * SONNET is the "quality tier": the owner co-pilot, the practice-brain Q&A and
 * classifier, and every patient-facing draft/agent. Sonnet 5 is near-Opus on
 * agentic and reasoning work at the same sticker price as 4.6. Every call site
 * that uses this model passes `thinking: { type: "disabled" }` on purpose:
 * Sonnet 5 turns adaptive thinking ON by default, which would spend part of a
 * small max_tokens budget on reasoning tokens (risking a truncated or empty
 * reply) and add latency. We want the smarter base model, not slower turns. */
export const SONNET = "claude-sonnet-5";
/** Fast, cheap model for low-latency, high-frequency calls (e.g. the adaptive
 * funnel's next-question selection on each step, and the internal report /
 * compliance / meta-ads-overview generators). Kept on Haiku 4.5 for speed. */
export const HAIKU = "claude-haiku-4-5-20251001";

/** Thinking config for every SONNET (Sonnet 5) call. See the SONNET note. */
export const NO_THINKING = { type: "disabled" } as const;
