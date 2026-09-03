import type { Tier } from "@/lib/practice-brain/types";

// ===========================================================================
// THE PRACTICE'S INTERNAL KNOWLEDGE MUST NOT GO OUT IN A PATIENT MESSAGE.
//
// THE HOLE THIS CLOSES. `search_knowledge` and `send_sms` are both the owner's
// tools, and in one turn the co-pilot can legitimately run both. The knowledge
// tree is tiered 1 General / 2 Operational / 3 Management / 4 Confidential, and
// the owner reads it at tier 4: the objection-handling scripts, the commercial
// notes on a treatment, the margin thinking behind a price, the wording the team
// uses about a competitor. Retrieval's clearance filter is doing its job when it
// hands the OWNER all of that — and the very next tool call can put it verbatim
// into a text message to a patient, because nothing downstream knew where the
// words came from.
//
// Nobody has to be malicious for this to happen. "Text Mrs Ahmed about the
// implant she asked about" plus a tier-3 note that reads like good copy is all
// it takes, and a model that has just been handed the practice's own words is
// exactly the model most likely to reuse them.
//
// WHAT THIS DOES. The dispatch remembers, for the life of ONE session, the
// bodies of any tier-2-and-above knowledge it handed the model. Every send —
// preview and commit — is scanned for a long verbatim run from one of them, and
// a hit REFUSES the send with a sentence the owner can act on.
//
// WHY VERBATIM AND NOT SEMANTIC. Because a semantic check would be a judgement,
// and a judgement here is another model deciding whether it is safe to send the
// practice's confidential words to a patient. A verbatim run of 60 characters is
// a fact: it is not paraphrase, it is not coincidence, and it is not the model
// writing a message of its own. The check is deliberately narrow so a refusal is
// always right; the ordinary path — the model reading tier-3 context and WRITING
// ITS OWN patient-appropriate sentence — is untouched, which is what the tool is
// for. This is a floor, not a filter.
//
// WHY TIER 2 AND NOT TIER 3. Tier 1 is General — that is the tier the
// patient-facing scripts and the published prices live at, and pasting one of
// those into a message is the feature. Everything from Operational upwards is
// written for staff, by staff, about how the practice runs. The line is drawn
// where "written for a colleague" starts.
//
// PURE. No DB, no env, no `server-only`. The recorder is a closure the dispatch
// owns, so the memory lives exactly as long as one session and never becomes a
// process-wide cache of one practice's knowledge.
// ===========================================================================

/** The lowest tier whose bodies must never be echoed to a patient. */
export const PROTECTED_TIER: Tier = 2;

/**
 * The shortest verbatim run counted as an echo, in normalised characters.
 *
 * SIXTY, and the number is a trade rather than a taste. Shorter and ordinary
 * shared phrasing starts to trip it ("please give us a call to rebook and we
 * will find you a time" is 58 and could be written independently by anybody).
 * Longer and a whole sentence of internal wording slips under. Sixty characters
 * of exact agreement is about a full clause and is not something two people
 * write by accident.
 */
export const MIN_ECHO_CHARS = 60;

/**
 * How much of one knowledge body is retained per session. A cap, because a
 * session that searched the brain twenty times must not carry twenty full bodies
 * for the rest of its life; the opening 4,000 characters of a body is far more
 * than any message could echo without tripping the check many times over.
 */
export const MAX_RETAINED_CHARS = 4000;

/** How many bodies one session retains. Beyond this the OLDEST are dropped. */
export const MAX_RETAINED_BODIES = 24;

/**
 * Normalise for comparison: case-folded, whitespace collapsed, punctuation and
 * accents left alone.
 *
 * Whitespace is the one thing a model reliably changes when it copies (a line
 * break becomes a space, two spaces become one), so collapsing it is what stops
 * the check being defeated by reformatting. Punctuation is NOT stripped: a
 * sixty-character run that agrees on every comma is the signal, and stripping
 * punctuation would only widen the net towards false positives.
 */
export function normaliseForEcho(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** One session's memory of protected knowledge it has handed the model. */
export interface KnowledgeEchoGuard {
  /** Record the bodies of any tier >= PROTECTED_TIER nodes just returned. */
  remember: (nodes: readonly { tier: number; body?: string | null; snippet?: string | null }[]) => void;
  /** The first protected run this text echoes, or null when it echoes none. */
  echoedRun: (text: string) => string | null;
  /** How many protected bodies this session is holding. For tests and audit. */
  size: () => number;
}

export function makeKnowledgeEchoGuard(): KnowledgeEchoGuard {
  const bodies: string[] = [];

  return {
    remember(nodes) {
      for (const n of nodes) {
        if (!n || typeof n.tier !== "number" || n.tier < PROTECTED_TIER) continue;
        // Both the body and the snippet: the snippet is what the model is most
        // likely to copy, because it is the part that answered the question.
        for (const raw of [n.body, n.snippet]) {
          const text = normaliseForEcho(String(raw ?? "")).slice(0, MAX_RETAINED_CHARS);
          if (text.length < MIN_ECHO_CHARS) continue;
          if (bodies.includes(text)) continue;
          bodies.push(text);
          if (bodies.length > MAX_RETAINED_BODIES) bodies.shift();
        }
      }
    },

    echoedRun(text) {
      const message = normaliseForEcho(text);
      if (message.length < MIN_ECHO_CHARS || bodies.length === 0) return null;
      // Slide a window over the MESSAGE, not over the bodies: the message is the
      // short side (an SMS is ~160 characters, a body can be four thousand), so
      // this is a few hundred `includes` calls at worst.
      for (let i = 0; i + MIN_ECHO_CHARS <= message.length; i += 1) {
        const window = message.slice(i, i + MIN_ECHO_CHARS);
        for (const body of bodies) {
          if (body.includes(window)) return window;
        }
      }
      return null;
    },

    size: () => bodies.length,
  };
}

/**
 * The refusal, written for the model to relay to the owner.
 *
 * It says WHAT happened and WHAT TO DO, and it does not reproduce the offending
 * run: quoting the confidential wording back into the conversation to explain
 * why it must not be sent would be its own small version of the same mistake.
 */
export const KNOWLEDGE_ECHO_REFUSAL =
  "That message repeats wording taken straight from the practice's internal knowledge, which is written for the team and not for patients, so nothing was sent. Write the message in your own words as something a patient would read, and offer that instead. Do not paste from the knowledge base, and do not try to get round this by rearranging it.";
