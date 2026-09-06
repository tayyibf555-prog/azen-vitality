// ===========================================================================
// THE CO-PILOT'S PER-TURN CONTEXT: the person's own words IN, the sentences the
// SERVER must say OUT.
//
// WHY IT EXISTS. `makeCopilotDispatch` is handed a tool name and a tool INPUT,
// and a tool input is written by the model. That is fine for every tool whose
// job is to fetch something, and it is not fine for the two places where a
// deterministic rule has to run on what the PERSON actually asked:
//
//   1. THE EQUIPMENT DOOR. The equipment module page runs
//      `gateEquipmentQuestion` over the user's own turns before any model call
//      (src/app/api/equipment/[action]/route.ts). Through the co-pilot the same
//      gate used to see only `input.question` — the model's paraphrase — so
//      "the autoclave is out of test, can we run it today?" could reach the
//      register as "autoclave next service date" and lose the standing
//      take-out-of-use refusal that ruling W1-D/2 says is never optional.
//      Programme ruling W3/14: the gate runs on the USER'S OWN words, and the
//      paraphrase never decides.
//
//   2. THE JUDGEMENT SENTENCE. The equipment route APPENDS
//      `EQUIPMENT_REFUSALS.judgement` to the reply itself, unconditionally,
//      "rather than after a 'did it already say this?' check", because its
//      failure direction is silence on the one sentence that must never be
//      missing. Through the co-pilot the sentence was handed to the model
//      inside the tool result with a note asking it to relay it, which is a
//      prompt, and a fact that rests on a prompt is not a fact. So the dispatch
//      RAISES A FLAG here and the route appends the sentence to the answer it
//      returns, exactly as the module page does.
//
//   3. THE DECISION-SUPPORT LABEL, for the same reason and by the same
//      mechanism. `second_opinion` is the one door in the co-pilot that reads a
//      named patient's clinical record and reasons about it, and the charter is
//      explicit that such an answer is "always labelled as such" (§2 W1-E DoD,
//      §0 item 10). SECOND_OPINION_LABEL was in the tool RESULT and in the
//      system prompt — both of which the clinician never sees — with the prompt
//      asking the model to say it "in your own words". So the one sentence that
//      says "this is not a diagnosis, not a treatment plan and not an
//      instruction to treat" reached the person only if the model chose to
//      relay it, and a dentist asking for a straight answer at the chair is
//      exactly the turn where a model drops boilerplate. The clinical door now
//      raises a flag like the machine door, and the label is appended by this
//      server.
//
// The context is per TURN and per SESSION, never module state: it is created by
// the route from the request it is already holding, handed to the dispatch, and
// read once on the way out.
//
// OPTIONAL BY CONSTRUCTION. Every existing caller (and every test that drives
// one tool directly) passes nothing and gets exactly today's behaviour: the
// gate then sees the paraphrase alone, which is where it started. What it can
// never do is see LESS than the paraphrase, so adding the context can only
// tighten the door, never loosen it.
// ===========================================================================

import { EQUIPMENT_JUDGEMENT_RULES, EQUIPMENT_REFUSALS } from "@/lib/equipment/topic-gate";
import { SECOND_OPINION_LABEL } from "./second-opinion";
import { firstMatch, normaliseForGate } from "@/lib/desk/gate";

export interface CopilotTurn {
  /**
   * The person's OWN messages in this conversation, oldest first — never the
   * assistant's, and never a tool input. The route takes them from the request
   * body it has already validated, the same way the equipment route does
   * (`messages.filter((m) => m.role === "user").map((m) => m.content)`).
   */
  readonly userTurns: readonly string[];
  /**
   * SET BY THE DISPATCH, READ BY THE ROUTE. True once any equipment answer in
   * this turn was capped to facts only, which is the state that obliges the
   * server to end the reply with the standing judgement sentence.
   *
   * Deliberately a mutable field on a per-turn object rather than a return
   * value: a turn can call `equipment_lookup` more than once, and the flag has
   * to survive across those calls without any of them being able to clear it.
   */
  equipmentJudgementRequired: boolean;
  /**
   * SET BY THE DISPATCH, READ BY THE ROUTE. True once any `second_opinion` call
   * was made in this turn — the answer AND every refusal, because a refusal is
   * still a clinical reply and a clinician reading one should not have to
   * remember which mode they are in (second-opinion.ts, rule 1).
   *
   * A latch on the turn for the same reason as the field above: one turn can
   * ask about two patients, and no call may clear what an earlier one owed.
   */
  secondOpinionLabelRequired: boolean;
}

/** A fresh context for one co-pilot turn. */
export function copilotTurn(userTurns: readonly string[]): CopilotTurn {
  return {
    // Copied, so nothing downstream can push a fabricated "user" turn into the
    // window the safety gate reads.
    userTurns: userTurns.filter((t) => typeof t === "string" && t.trim() !== "").map((t) => t),
    equipmentJudgementRequired: false,
    secondOpinionLabelRequired: false,
  };
}

/**
 * Did the person themselves ask the judgement question — "is it OK to keep
 * using it" — in their latest message?
 *
 * THE MODULE'S OWN RULE TABLE, imported, never a second copy of it: this is
 * `EQUIPMENT_JUDGEMENT_RULES`, the same list `gateEquipmentQuestion` checks at
 * its step 4, matched with the same normaliser.
 *
 * It is asked SEPARATELY from the gate for one reason, and only one. The gate
 * answers off-topic BEFORE judgement, and a co-pilot turn is allowed to be
 * about more than one thing: "the autoclave is out of test but we have patients
 * booked all day, can we still use it?" trips `offtopic.clinical` on the
 * equipment page and so never reaches the judgement rules. In the co-pilot the
 * patient half is answered by another tool, and the equipment half must still
 * be capped to facts. Asking the table directly is what makes that true.
 *
 * THE LATEST TURN ONLY, matching the gate's own calibration: "a judgement asked
 * and answered three messages ago must not silently facts-only-cap a later,
 * ordinary question".
 */
export function equipmentJudgementAskedByPerson(turn: CopilotTurn | null | undefined): boolean {
  const words = turn?.userTurns ?? [];
  const latest = words.length > 0 ? words[words.length - 1] : "";
  if (latest.trim() === "") return false;
  return firstMatch(EQUIPMENT_JUDGEMENT_RULES, normaliseForGate(latest)) !== null;
}

/**
 * The reply the practice actually sees.
 *
 * APPENDED UNCONDITIONALLY when a flag is up, with no "did the model already
 * say it?" check — the same decision the equipment route makes and for the same
 * stated reason: that check is a fuzzy match on generated prose whose failure
 * direction is silence on the one sentence that must always be there.
 * Occasional redundancy is by far the cheaper mistake.
 *
 * It also covers the two replies the model did not write: the route's own
 * "Sorry, I could not respond just now." fallback, and an empty turn.
 *
 * ORDER, WHERE A TURN OWES BOTH. The decision-support label frames the clinical
 * answer that was just given, so it follows the body; the equipment refusal is
 * the last word because it is the one a nurse must be left holding — and because
 * the equipment door's own tests have always asserted that a reply owing it ENDS
 * with it, which is a property worth keeping rather than quietly relaxing.
 */
export function finaliseCopilotReply(reply: string, turn: CopilotTurn | null | undefined): string {
  const owed: string[] = [];
  if (turn?.secondOpinionLabelRequired) owed.push(SECOND_OPINION_LABEL);
  if (turn?.equipmentJudgementRequired) owed.push(EQUIPMENT_REFUSALS.judgement);
  if (owed.length === 0) return reply;
  const body = reply.trim();
  return [...(body === "" ? [] : [body]), ...owed].join("\n\n");
}
