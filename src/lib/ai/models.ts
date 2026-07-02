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

/** Thinking config for every SONNET (Sonnet 5) call. See the SONNET note. */
export const NO_THINKING = { type: "disabled" } as const;

// NOTE: the whole product runs on Sonnet 5. (Claude Fable 5 is the internal
// build/dev model, not used at runtime.) A HAIKU fast-tier constant used to
// live here for latency-sensitive calls (the smile-funnel next-question picker
// and the internal report/compliance/meta-ads generators); it was removed when
// those moved to Sonnet 5. Re-introduce a fast tier here if a hot path ever
// needs Haiku 4.5 again.
