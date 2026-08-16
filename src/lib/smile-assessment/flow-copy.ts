// THE WRITE-TIME COPY GATE for an authored funnel.
//
// A funnel graph carries five kinds of free text an owner (or the generator) can
// put in front of a patient: welcome.headline, welcome.intro, question.transition,
// edge.transition and outcome.headline - plus, since A2, every string inside a
// CONTENT BLOCK (a trust strip's chips, a testimonial's quote, a faq's answers, a
// picture's alt text). Everything ELSE a patient reads on the deterministic funnel
// comes from QUIZ_QUESTIONS, and QUIZ_QUESTIONS is already walked by
// area16-18-patient-copy-jargon.test.ts.
//
// WHICH IS EXACTLY THE PROBLEM THIS MODULE EXISTS FOR. That walk cannot see them,
// because they are not in the bank: they are rows in a database, written
// after the test ran, by a person or by a model. A suite can only prove things
// about code. So the check has to happen at WRITE time, on the way into the row,
// and it has to happen in ONE place that every write path goes through
// (updateCampaignFlow) rather than being remembered at each call site.
//
// TWO SCANNERS, BOTH NEEDED, AND THEY ARE NOT THE SAME SCANNER:
//
//   scanBannedText (src/lib/landing/compliance.ts) is the house's single source
//   of truth for "wording a UK dental practice must not publish": testimonials,
//   guarantees, pain-free claims, superlatives, funding wording, banned symbols,
//   unverifiable proof claims. Reused rather than re-listed, so a pattern added
//   for the landing pages protects the funnel the same day.
//
//   THE JARGON REGEXES are stricter than compliance.ts on one word and that is
//   deliberate. compliance.ts scopes "private" to funding-ish usage
//   (/\bprivate (?:patient|treatment|...)\b/) so benign marketing prose is not
//   caught. The patient-copy rule for this platform is absolute: a patient-facing
//   message never says NHS or private, in any usage. These are the SAME three
//   regexes area16-18-patient-copy-jargon.test.ts:17 applies to the bank, applied
//   here to the copy the bank cannot cover.
//
// PURE. No I/O, no React, no server imports, so the rules are testable in the node
// env (flow-copy.test.ts) and the route just reports what this returns.

import { scanBannedText, type BannedTextHit } from "@/lib/landing/compliance";
import { blockCopyFields, blocksOf, type FlowGraph } from "./flow";

/**
 * The absolute patient-copy ban. Kept as a literal copy of the list in
 * area16-18-patient-copy-jargon.test.ts:17 rather than imported from it: a test
 * file is not a module other code should depend on, and this list is short enough
 * that a duplicate is safer than a dependency in that direction. flow-copy.test.ts
 * asserts the two stay identical.
 */
export const FLOW_JARGON_PATTERNS: readonly RegExp[] = [/\bNHS\b/i, /\bprivate\b/i, /\bprivately\b/i];

export type FlowCopyCategory = BannedTextHit["category"] | "jargon";

export interface FlowCopyHit {
  /** Which authored string, named so an owner can find it: `node "welcome".intro`. */
  where: string;
  category: FlowCopyCategory;
  /** The offending phrase, as matched. */
  matched: string;
}

export interface FlowCopyField {
  where: string;
  text: string;
}

/**
 * Every authored, patient-facing string in a graph, with a human-findable path.
 *
 * Deliberately exhaustive over the shape rather than clever: if a future node kind
 * gains a copy field and is not added here, it ships unscanned. A `never` guard on
 * the switch would not help, because the miss is a new PROPERTY on an existing
 * kind, not a new kind. flow-copy.test.ts pins the field list instead.
 */
export function collectFlowCopy(graph: FlowGraph): FlowCopyField[] {
  const out: FlowCopyField[] = [];
  const push = (where: string, text: string | undefined): void => {
    if (typeof text === "string" && text.trim() !== "") out.push({ where, text });
  };

  for (const n of graph.nodes) {
    if (n.kind === "welcome") {
      push(`node "${n.id}".headline`, n.headline);
      push(`node "${n.id}".intro`, n.intro);
    } else if (n.kind === "question") {
      push(`node "${n.id}".transition`, n.transition);
    } else if (n.kind === "outcome") {
      push(`node "${n.id}".headline`, n.headline);
    }
    // A contact node carries no authored copy: the contact screen's wording is
    // hand-written JSX in the runtime component, which the jargon suite can read.

    // CONTENT BLOCKS (A2). Every string in a block is typed by a practice and
    // rendered to a patient, so every string in a block is scanned - including
    // the picture's ALT, which a screen reader says out loud like any other
    // sentence on the page.
    //
    // THE TESTIMONIAL QUOTE IS SCANNED LIKE EVERYTHING ELSE, and it is worth
    // being explicit about why, because "it is a real quote from a real patient"
    // is exactly the argument that would exempt it. It cannot be exempt: the
    // practice is the PUBLISHER here, and the ASA/GDC rules do not care who
    // originally said "they are the best in London" or "it was totally pain
    // free" - publishing it is the claim. So a quote a practice genuinely holds
    // can still be refused, and the honest answer is to quote a different part
    // of it. The picture keys are NOT scanned: a key is not copy, and rule 13
    // already holds it to the curated manifest.
    for (const [i, b] of blocksOf(n).entries()) {
      for (const f of blockCopyFields(b)) {
        push(`node "${n.id}".blocks[${i}].${f.field}`, f.text);
      }
    }
  }

  for (const e of graph.edges) {
    push(`edge ${e.from} -> ${e.to} (${e.answer === null ? "default" : e.answer}).transition`, e.transition);
  }

  return out;
}

/**
 * Scan one string with both scanners. Returns at most one hit per category (what
 * scanBannedText already does) plus at most one jargon hit, because a second
 * example of the same problem tells an owner nothing new.
 */
export function scanFlowCopyText(where: string, text: string): FlowCopyHit[] {
  const hits: FlowCopyHit[] = scanBannedText(text).map((h) => ({ where, category: h.category, matched: h.matched }));
  for (const re of FLOW_JARGON_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      hits.push({ where, category: "jargon", matched: m[0] });
      break;
    }
  }
  return hits;
}

/**
 * EVERY offending string in the graph, never just the first: same doctrine as
 * validateFlow. An owner fixing a funnel by hand should see the whole list, and
 * the generator's repair pass quotes it back to the model.
 */
export function scanFlowCopy(graph: FlowGraph): FlowCopyHit[] {
  const hits: FlowCopyHit[] = [];
  for (const f of collectFlowCopy(graph)) hits.push(...scanFlowCopyText(f.where, f.text));
  return hits;
}

/** One line per hit, for a 400 body or a repair prompt. */
export function describeFlowCopyHits(hits: FlowCopyHit[]): string {
  return hits.map((h) => `- [${h.category}] ${h.where}: "${h.matched}"`).join("\n");
}
