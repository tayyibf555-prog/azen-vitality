// ===========================================================================
// THE SERVER-SIDE TOPIC GATE, SHARED BY THE TWO STAFF-FACING DESK AGENTS.
//
// WHY THIS EXISTS AT ALL, GIVEN BOTH AGENTS ALSO HAVE THE RULES IN THEIR SYSTEM
// PROMPT. A system prompt is an instruction to a model, and a model is a thing
// that can be talked out of an instruction. Everything downstream of this file
// treats "the agent only answers about X" as a fact, and a fact that rests on a
// prompt is not a fact — it is a preference the next clever message renegotiates.
//
// So the scope is enforced TWICE, by two mechanisms that fail differently:
//
//   1. HERE, deterministically, before a single token is spent. A refusal from
//      this file never reaches Anthropic at all, so there is no prompt to
//      subvert, no tool to call, and no cost.
//   2. In the system prompt, because the gate is a coarse instrument and the
//      model is the one that can tell "the compressor is noisy" from "my
//      colleague is noisy". The prompt narrows what the gate lets through; it
//      never widens it.
//
// Each agent supplies its own rule sets. This file owns the SHAPE: what a
// verdict is, what order the checks run in, and the two helpers every rule set
// uses. `desk/gate.test.ts` pins the shape; each agent's own gate test pins its
// rules against a battery of real prompts.
//
// ---------------------------------------------------------------------------
// THE ORDER IS THE DESIGN, AND IT IS DENY-FIRST.
//
//   safety   -> refuse    (runs over EVERY user turn in the window, not only the
//                          latest: an instruction planted three messages back is
//                          still an instruction the model can read)
//   off-topic-> refuse    (deny beats allow: "what does the patient owe on the
//                          autoclave account" names equipment AND names money,
//                          and the right answer to it is no)
//   nothing  -> refuse    (an agent with an empty knowledge base has no honest
//    to work    answer to give; say so rather than let the model improvise one)
//    from
//   judgement-> allow    (FACTS ONLY. The narrow middle: a question whose facts
//    question             the agent should read out and whose DECISION is not
//                         its to make. Deterministically classified here, and
//                         the caller appends the standing instruction itself
//                         rather than trusting the model to end with it.)
//   on-topic -> allow
//   otherwise-> refuse    (ALLOW-LIST, not deny-list: anything the agent cannot
//                          positively recognise as its own subject is refused.
//                          This is the line that makes the scope narrow rather
//                          than merely careful.)
// ===========================================================================

/** Why a message was refused. Reported to the caller and asserted in tests. */
export type GateReason =
  /** Asked for something that would defeat a safety protection or a credential. */
  | "safety"
  /** Recognisably about something this agent does not cover. */
  | "off_topic"
  /** On-topic, but there is nothing registered/known to answer from yet. */
  | "nothing_to_answer_from"
  /** Not recognisable as this agent's subject at all. */
  | "out_of_scope";

export type GateVerdict =
  | {
      kind: "allow";
      /**
       * How the agent must answer, when "however it likes" is not the answer.
       *
       * "facts_only" is the middle path for the one class of question where a
       * flat refusal and a free answer are both wrong (programme ruling, W1-D):
       * the agent may read out FACTS — what the register records, what the manual
       * states — but must not answer the JUDGEMENT the facts are being gathered
       * for. See EQUIPMENT_JUDGEMENT_RULES.
       *
       * Undefined is the ordinary case and every existing caller is unchanged.
       */
      mode?: "facts_only";
      /** Which rule selected the mode, so a test can assert the reason, not just the outcome. */
      rule?: string;
    }
  | {
      kind: "refuse";
      reason: GateReason;
      /** The exact sentence shown to the member of staff. */
      message: string;
      /** Which named rule fired, so a test can assert the REASON and not just the outcome. */
      rule: string;
    };

/** One named rule. The id is part of the contract: tests assert it by name. */
export interface GateRule {
  id: string;
  pattern: RegExp;
}

/**
 * Lower-case, collapse whitespace, and normalise the punctuation people actually
 * type. Curly apostrophes and non-breaking spaces arrive constantly from anything
 * pasted out of Word or a phone, and a rule written with a straight apostrophe
 * must not miss `don’t`.
 *
 * Deliberately NOT stripping punctuation wholesale: the rules use `[^.?!]{0,n}`
 * spans to keep two matched words inside one sentence, and flattening sentence
 * ends would let a rule span from one question into the next.
 */
export function normaliseForGate(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

/**
 * A rule that matches two ideas in the same sentence, IN EITHER ORDER.
 *
 * Written as a helper rather than as two rules because the two orderings are the
 * same request, not two requests: "how do I bypass the interlock" and "the
 * interlock — any way round it?" differ only in English word order, and a rule
 * set that catches one and not the other is a rule set with a hole in it that
 * looks, in the source, exactly like a rule set without one.
 *
 * `[^.?!]` bounds the span to a single sentence: `.*` would let a rule pair a
 * word in one question with a word in the next, which is how a gate starts
 * refusing things nobody asked.
 */
export function bothWays(a: string, b: string, span = 50): RegExp {
  return new RegExp(`(?:\\b(?:${a})\\b[^.?!]{0,${span}}\\b(?:${b})\\b)|(?:\\b(?:${b})\\b[^.?!]{0,${span}}\\b(?:${a})\\b)`);
}

/** The first rule that matches, or null. */
export function firstMatch(rules: GateRule[], text: string): GateRule | null {
  for (const rule of rules) if (rule.pattern.test(text)) return rule;
  return null;
}

/**
 * Whether the text names one of the words this agent knows about.
 *
 * Word-boundary matched and escaped, because the vocabulary comes from PRACTICE
 * DATA — an asset called "W&H Lisa (+)" would otherwise be compiled into a regex
 * with a live `(` in it and throw at request time. Tokens under three characters
 * are dropped: a model number of "5" matches every message ever sent.
 */
export function mentionsVocabulary(text: string, vocabulary: readonly string[]): boolean {
  for (const raw of vocabulary) {
    const token = normaliseForGate(raw);
    if (token.length < 3) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text)) return true;
  }
  return false;
}

/**
 * A short continuation of a conversation already in scope ("and then?", "what
 * next", "it still won't", "no, it didn't work").
 *
 * NEEDED because the allow-list is a list of NOUNS, and the second turn of a
 * troubleshooting conversation contains none of them. Without this, the agent
 * would answer "the autoclave shows E04" and then refuse "I tried that, still
 * E04" as off-topic, which is worse than useless — it is the shape of a broken
 * product.
 *
 * Deliberately narrow: it only ever applies when an earlier turn ALREADY put a
 * specific asset or playbook in scope, and the deny rules have already run, so a
 * continuation cannot be used to smuggle a new subject in.
 */
export function looksLikeContinuation(text: string): boolean {
  if (text.split(" ").length > 14) return false;
  return /\b(and then|then what|what next|next step|still|didn'?t work|no luck|same (error|thing|problem)|tried that|yes|no|nope|yeah|ok|okay|it did|it does|it doesn'?t|carry on|continue|go on|more detail|explain|why)\b/.test(
    text,
  );
}
