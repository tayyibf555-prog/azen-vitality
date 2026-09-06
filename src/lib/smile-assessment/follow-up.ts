// PER-ASSESSMENT FOLLOW-UP: when a submission is followed up, and in whose words.
//
// ============================================================================
// WHAT THIS MODULE IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT.
//
// It is THREE SETTINGS on a campaign (migration 0082) and the rules that read
// them. It is NOT a sender, a scheduler, a queue or a template engine with a
// runtime. Every message this feature can cause still leaves through the one path
// it left through before: submit route -> Speed-to-lead lead -> contactLead ->
// sendMessage, with the same consent record, the same suppression list, the same
// deliverability checks, the same output guardrail, the same budgets and the same
// two kill switches. Nothing here can send anything. It can only answer two
// questions the existing path already asks:
//
//   1. IS THIS SUBMISSION FOLLOWED UP?   shouldFollowUp(config, band)
//   2. WHAT DOES THE FIRST MESSAGE SAY?  firstTouchOverride(config)
//
// THE OFF CONFIG IS TODAY, EXACTLY. followUpConfig() collapses an un-enabled
// campaign — and an un-migrated database, and a row an owner never touched — to
// FOLLOW_UP_OFF, and FOLLOW_UP_OFF is defined so that shouldFollowUp reduces to
// `band === "high"` and firstTouchOverride reduces to null, which is the code the
// submit route and contactLead ran before this file existed. That equivalence is
// the feature's safety property and it is pinned, not asserted, in
// follow-up.test.ts.
//
// WHY THE TRIGGER IS ONLY EVER A WIDENING, NEVER A SEND. 'all' means a medium or
// low scorer with a reachable contact is bridged into Speed-to-lead too. It does
// not mean anyone is messaged who could not have been messaged before: the bridge
// still requires a deliverable address, an un-suppressed contact, consent on the
// chosen channel, a trusted submit, and both the smile-assessment and
// speed-to-lead switches on. It moves ONE boolean.
//
// PURE. No I/O, no React, no server imports — so the API route, the public submit
// route, the server-only contact path, the client panel and the suite all read the
// same rules. The two things it imports are the compliance scanners, which are
// pure for exactly this reason.
// ============================================================================

import type { AssessmentBand } from "./types";
import { scanFlowCopyText, type FlowCopyHit } from "./flow-copy";
import { checkAgentReply, type GuardrailCategory } from "@/lib/agent/guardrail";
import { stripControls } from "@/lib/text/prompt-safety";

/* ---------------------------------------------------------------------------
 * 1. The trigger.
 * ------------------------------------------------------------------------- */

/**
 * WHEN a submission becomes a followed-up enquiry.
 *
 *   high — only a high-scoring submission, i.e. exactly what every campaign does
 *          today and what every campaign keeps doing while the feature is off.
 *   all  — every submission that has a contact detail we can reach.
 *
 * Deliberately two values and not a score threshold. A number would look more
 * powerful and would be worse: the band is what the scoring engine actually
 * publishes (scoring.ts), it is what the worklist shows, and a per-campaign
 * threshold would be a second, invisible copy of the qualification model that
 * nobody could reconcile with the one on the card.
 */
export type FollowUpTrigger = "high" | "all";

export const FOLLOW_UP_TRIGGERS: readonly FollowUpTrigger[] = ["high", "all"];

export function isFollowUpTrigger(value: unknown): value is FollowUpTrigger {
  return typeof value === "string" && (FOLLOW_UP_TRIGGERS as readonly string[]).includes(value);
}

/** The trigger in an owner's words, for the control and for an error message. */
export function followUpTriggerLabel(trigger: FollowUpTrigger): string {
  return trigger === "all"
    ? "Every submission with a contact detail"
    : "Only a strong match (high score)";
}

/* ---------------------------------------------------------------------------
 * 2. The config, and the one place the OFF defaults are decided.
 * ------------------------------------------------------------------------- */

export interface FollowUpConfig {
  enabled: boolean;
  trigger: FollowUpTrigger;
  /** The owner's first-touch wording, or null for "the model writes it". */
  template: string | null;
}

/**
 * THE BEHAVIOUR EVERY CAMPAIGN HAS TODAY, named once so it can be tested and
 * pointed at. Frozen because it is handed out by reference below and a caller
 * mutating it would silently re-configure every un-enabled campaign in the process.
 */
export const FOLLOW_UP_OFF: FollowUpConfig = Object.freeze({
  enabled: false,
  trigger: "high",
  template: null,
});

/** The three columns as they arrive from a row (or do not, pre-0082). */
export interface FollowUpFields {
  followUpEnabled?: boolean | null;
  followUpTrigger?: string | null;
  followUpTemplate?: string | null;
}

/**
 * A campaign's follow-up settings, from whatever the row had.
 *
 * THE `enabled !== true` SHORT-CIRCUIT IS THE WHOLE DESIGN. An un-enabled campaign
 * does not get "its trigger, but ignored later" — it gets FOLLOW_UP_OFF, so there
 * is no later. A stored trigger of 'all' and a stored template are inert data on a
 * switched-off campaign, and no downstream reader has to remember that. It also
 * means the OFF path has exactly one shape, whether it came from a false column, a
 * null column, a column that does not exist yet, or no row at all.
 *
 * The trigger is re-checked against the closed list on the way out rather than
 * trusted: a hand-edited row saying 'everyone' resolves to 'high', which is the
 * narrower answer, and the same posture paletteFor takes with a retired theme key.
 */
export function followUpConfig(fields: FollowUpFields | null | undefined): FollowUpConfig {
  if (!fields || fields.followUpEnabled !== true) return FOLLOW_UP_OFF;
  const trigger = isFollowUpTrigger(fields.followUpTrigger) ? fields.followUpTrigger : "high";
  const template = normaliseFollowUpTemplate(fields.followUpTemplate);
  return { enabled: true, trigger, template };
}

/**
 * Does this submission get followed up at all?
 *
 * OFF REDUCES TO `band === "high"`, which is the expression this replaced at the
 * submit route's bridge. That is the byte-unchanged promise, and it is one line
 * rather than a comment.
 */
export function shouldFollowUp(config: FollowUpConfig, band: AssessmentBand): boolean {
  if (!config.enabled) return band === "high";
  return config.trigger === "all" ? true : band === "high";
}

/**
 * The owner's first-touch wording, or null for "draft it".
 *
 * Gated on `enabled` as well as on the text, so switching a campaign off puts its
 * messages back in the model's hands without anyone having to clear the box.
 */
export function firstTouchOverride(config: FollowUpConfig): string | null {
  return config.enabled ? config.template : null;
}

/* ---------------------------------------------------------------------------
 * 3. The template.
 * ------------------------------------------------------------------------- */

/**
 * The longest a first-touch template may be.
 *
 * Two SMS segments of GSM-7 is 306 characters; 320 is that, rounded, and it is a
 * ceiling rather than a target. The drafted messages this replaces are capped at
 * "under 60 words" by prompt (draft.ts), so an owner who fills this is already
 * writing a longer message than the model would. Longer than this is not a
 * first contact, it is a letter.
 */
export const MAX_FOLLOW_UP_TEMPLATE = 320;

/**
 * The CLOSED set of merge tokens. Two, and there is no third by accident: every
 * `{...}` in a template is checked against this list at write time, so a mistyped
 * or invented token is refused rather than delivered to a patient as literal
 * braces.
 *
 * Deliberately NOT extended to anything about the enquiry itself (treatment,
 * score, band, answers). Those are either internal qualification data or the
 * patient's own words read back at them, and the drafted message already handles
 * that ground with rules about how to use it (draft.ts). A token would hand the
 * same material over with no rules at all.
 */
export const FOLLOW_UP_TOKENS = ["name", "practice"] as const;
export type FollowUpToken = (typeof FOLLOW_UP_TOKENS)[number];

/** Every `{token}` occurrence, lowercased, in order. Case-insensitive by design. */
const TOKEN_RE = /\{([^{}]*)\}/g;

/**
 * The stored form of a template, or null if there is not one.
 *
 * Control characters out (a stray \r in an SMS body is invisible and unhelpful),
 * runs of spaces and tabs collapsed, blank lines collapsed to one, trimmed, capped.
 * NEWLINES SURVIVE: a two-line first message ("Hi Sam, ...\n\nReply here and we
 * will find you a time") is a normal SMS shape and flattening it would silently
 * rewrite what the owner typed.
 */
export function normaliseFollowUpTemplate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    // Everything in the C0 range except \n (000a) and \r (000d), plus DEL.
    // Written \\u so this file stays plain ASCII: a literal control byte in a
    // source file is invisible to a reviewer. Same posture as normaliseThemeName.
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned === "" ? null : cleaned.slice(0, MAX_FOLLOW_UP_TEMPLATE).trim();
}

export type FollowUpTemplateFailure =
  /** Nothing usable was typed. */
  | { kind: "empty" }
  /** Longer than a first contact should be. */
  | { kind: "length"; length: number }
  /** A `{token}` that is not in the closed set. */
  | { kind: "token"; token: string }
  /** The funnel-copy scan refused it (banned wording, or funding jargon). */
  | { kind: "copy"; hit: FlowCopyHit }
  /** The SEND path's own backstop would refuse it. See the note on validate. */
  | { kind: "guardrail"; category: GuardrailCategory; matched: string };

export type FollowUpTemplateResult =
  | { ok: true; template: string }
  | { ok: false; failures: FollowUpTemplateFailure[] };

/** Where a copy hit is reported from, in an owner's terms. */
const TEMPLATE_WHERE = "follow-up message";

/**
 * Judge a submitted template. ALL FAILURES AT ONCE, in the flow-validate /
 * validateThemeVars house style.
 *
 * TWO SCANNERS, AND THE SECOND ONE IS THE IMPORTANT ONE.
 *
 *   scanFlowCopyText is THE SAME SCAN THE FUNNEL COPY GOES THROUGH — the house
 *   banned-text list plus the absolute no-NHS/no-private patient-copy ban. A
 *   practice's first-touch SMS is patient-facing copy in exactly the way a welcome
 *   screen's headline is, so it is held to exactly the same bar, by the same
 *   function, rather than by a second list that could drift.
 *
 *   checkAgentReply(…, { includePrice: false }) is the OUTPUT BACKSTOP THE SENDER
 *   ITSELF APPLIES (contact.ts, immediately before sendMessage). It is run here,
 *   at write time, for a reason that is not tidiness: a guardrail hit in
 *   contactLead is TERMINAL — the lead is retired to 'lost' and never contacted
 *   again. A template that trips it would therefore not fail loudly, it would
 *   quietly destroy every enquiry the campaign produced, one lead at a time, with
 *   nothing on screen to say so. So the write gate is deliberately a SUPERSET of
 *   the send gate: if the sender would refuse it, the owner cannot store it.
 *   includePrice matches the sender exactly, so the two cannot disagree about a
 *   hedged "from £X".
 *
 * THE RAW TEMPLATE IS SCANNED, tokens and all. `{name}` carries no wording of its
 * own, and the values substituted at send time are the patient's own first name
 * and the practice's name — neither of which is copy an owner authored here. (A
 * name that itself trips the guardrail is the send path's problem and is already
 * the same problem for a drafted message, which would echo it too.)
 */
export function validateFollowUpTemplate(value: unknown): FollowUpTemplateResult {
  const failures: FollowUpTemplateFailure[] = [];

  // Length is judged on what the OWNER TYPED, before the cap is applied, so a
  // template that is too long is refused rather than silently truncated mid-word.
  if (typeof value === "string") {
    const trimmedLength = value.trim().length;
    if (trimmedLength > MAX_FOLLOW_UP_TEMPLATE) {
      failures.push({ kind: "length", length: trimmedLength });
    }
  }

  const template = normaliseFollowUpTemplate(value);
  if (!template) {
    // Nothing usable. Reported alone: every other check would be about a string
    // that is not there, and would bury the one thing that is wrong.
    return { ok: false, failures: [{ kind: "empty" }] };
  }

  const seen = new Set<string>();
  for (const match of template.matchAll(TOKEN_RE)) {
    const token = match[1].trim().toLowerCase();
    if ((FOLLOW_UP_TOKENS as readonly string[]).includes(token)) continue;
    // The raw text between the braces, capped, so an owner can see what they typed.
    const shown = match[1].slice(0, 40);
    if (seen.has(shown)) continue;
    seen.add(shown);
    failures.push({ kind: "token", token: shown });
  }

  for (const hit of scanFlowCopyText(TEMPLATE_WHERE, template)) {
    failures.push({ kind: "copy", hit });
  }

  const guard = checkAgentReply(template, { includePrice: false });
  if (!guard.ok) {
    failures.push({
      kind: "guardrail",
      category: guard.category ?? "funding",
      matched: guard.matched ?? template.slice(0, 40),
    });
  }

  return failures.length > 0 ? { ok: false, failures } : { ok: true, template };
}

/** One failure as a sentence an owner reads in an API error. */
export function describeFollowUpTemplateFailure(failure: FollowUpTemplateFailure): string {
  switch (failure.kind) {
    case "empty":
      return "the message is empty; type the wording you want sent, or switch the override off";
    case "length":
      return `the message is ${failure.length} characters; keep a first text to ${MAX_FOLLOW_UP_TEMPLATE} or fewer`;
    case "token":
      return `"{${failure.token}}" is not something we can fill in. Use ${FOLLOW_UP_TOKENS.map((t) => `{${t}}`).join(" or ")}`;
    case "copy":
      return `[${failure.hit.category}] "${failure.hit.matched}" cannot be sent to a patient`;
    case "guardrail":
      return `[${failure.category}] "${failure.matched}" would be blocked before sending, so it cannot be saved`;
  }
}

/** Every failure, one per line — the shape describeFlowCopyHits uses. */
export function describeFollowUpTemplateFailures(
  failures: readonly FollowUpTemplateFailure[],
): string {
  return failures.map((f) => `- ${describeFollowUpTemplateFailure(f)}`).join("\n");
}

/* ---------------------------------------------------------------------------
 * 4. Rendering, at send time.
 * ------------------------------------------------------------------------- */

/**
 * First name for a warm opener, falling back to an empty string.
 *
 * A DELIBERATE NEAR-DUPLICATE of the private `firstName` helper in
 * src/lib/speed-to-lead/draft.ts, and the duplication is the cheaper of the two
 * options: draft.ts imports the Anthropic SDK at module scope, and importing it
 * here to save three lines would drag the SDK into a module the API route, the
 * public submit route and the client panel all load. The two are pinned to the
 * same answers in follow-up.test.ts.
 *
 * DEFANG FIRST, THEN TAKE THE TOKEN — that order is the fix, and it is not
 * interchangeable. `name` here is `lead.name`: text a stranger typed into a
 * public web form (src/lib/speed-to-lead/contact.ts hands it straight to
 * renderFollowUpTemplate). Taking the first whitespace-delimited token reads
 * like a structural guarantee — one word cannot be a paragraph — and it is not
 * one, because JS `\s` does NOT match NEL (U+0085) or the rest of the C1 block.
 * A name whose separators are all C1 controls was therefore ONE token to
 * `split(/\s+/)`, so the WHOLE payload survived as the "first name" and was
 * transmitted verbatim in the practice's own first text. `stripControls` turns
 * those controls into real spaces first, which makes the first-token rule true
 * again. Exactly the fix draft.ts's `firstName` carries; the hole was closed on
 * that side and left open on this one.
 *
 * WHY `stripControls` AND NOT `sanitiseName`. This is a template renderer, not a
 * prompt builder: no model reads the output, so the model-facing half of
 * @/lib/agent/free-text (the boundary sentence, the sweep in
 * src/lib/agent-wiring/free-text-boundary.test.ts that every importer of that
 * module must appear in) has nothing to say about it. @/lib/text/prompt-safety
 * holds the tree's ONE definition of the control-character class and imports
 * nothing at all, so it is reachable from the client panel this module is loaded
 * by. What is NOT taken from `sanitiseName` and is deliberately left: its
 * sentence cut and its 40-character cap. Both are about what a MODEL should be
 * handed; capping a patient's name in the text they receive is a different
 * decision, and the parity gap is ledgered rather than guessed at.
 *
 * The empty result is unchanged and still reachable only for a name made
 * entirely of control characters — `str()` at both intake routes rejects a blank
 * one, and String.prototype.trim does not strip C1. renderFollowUpTemplate turns
 * it into "there" (W3/37), the same fallback draft.ts uses.
 */
export function firstNameOf(name: string | null | undefined): string {
  const trimmed = stripControls(name ?? "").trim();
  return trimmed.split(/\s+/)[0] || trimmed;
}

export interface FollowUpVars {
  /** The lead's name, as captured. Only its first word is used. */
  name?: string | null;
  /** The practice's name. */
  practice?: string | null;
}

/**
 * The template with its tokens filled in — the exact string that is handed to the
 * send path.
 *
 * SUBSTITUTION ONLY. No expressions, no conditionals, no nesting: a token is
 * replaced by a value and a value is never re-scanned for tokens, so a patient
 * called "{practice}" cannot expand into anything.
 *
 * An unknown token cannot reach here (validateFollowUpTemplate refuses it at the
 * door), but if one somehow did — a row written before a token was retired, say —
 * it is left EXACTLY AS TYPED rather than blanked. Literal braces in a message are
 * an obvious, reportable bug; a silently missing clause is not.
 */
export function renderFollowUpTemplate(template: string, vars: FollowUpVars = {}): string {
  const name = firstNameOf(vars.name);
  const practice = (vars.practice ?? "").trim();
  const values: Record<FollowUpToken, string> = {
    // "there" and "the practice" are the same fallbacks nurtureFallback uses when
    // it has no client, so an un-named practice reads the same in both places.
    name: name || "there",
    practice: practice || "the practice",
  };
  return template
    .replace(TOKEN_RE, (whole, raw: string) => {
      const token = raw.trim().toLowerCase();
      return (FOLLOW_UP_TOKENS as readonly string[]).includes(token)
        ? values[token as FollowUpToken]
        : whole;
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
