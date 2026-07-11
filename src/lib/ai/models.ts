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

// NOTE: the product's default is Sonnet 5. (Claude Fable 5 is the internal
// build/dev model, not used at runtime.)

/** HAIKU is the fast tier for latency-critical, tightly-constrained hot paths
 *  ONLY — today that is exactly one call: the smile-funnel next-question picker
 *  (owner decision 2026-07-12: the funnel must feel instant, and that endpoint
 *  can only choose from a fixed question bank + write a one-line transition, so
 *  the small model loses nothing). Everything patient-facing that DRAFTS free
 *  text stays on SONNET. */
export const HAIKU = "claude-haiku-4-5-20251001";
