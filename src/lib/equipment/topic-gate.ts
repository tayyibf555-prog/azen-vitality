// ===========================================================================
// THE EQUIPMENT AGENT'S SERVER-SIDE GATE.
//
// Two jobs, and they are not the same job:
//
//   SAFETY   Some questions must be refused however well they are asked and
//            whoever asks them. Defeating a chamber-door interlock, working on
//            240V behind a panel, running an autoclave past its pressure-vessel
//            inspection, taking a radiograph without shielding: these are not
//            "off topic", they are the exact subject of this agent, and that is
//            precisely why the refusal has to be structural. The manual sitting
//            in our own database is what makes the request answerable — page 12
//            really does describe how the interlock works — so "the model
//            wouldn't say that" is not a control. This file is the control.
//
//   SCOPE    Everything else the agent will not touch. Allow-list, not
//            deny-list: a message has to be positively recognisable as a
//            question about the practice's registered equipment, or it is
//            refused. Narrow is the product.
//
// EVERY RULE IS NAMED AND EVERY REFUSAL REPORTS THE NAME. `topic-gate.test.ts`
// asserts the rule id, not merely that something was refused, so a battery entry
// cannot pass by accidentally tripping an unrelated rule.
// ===========================================================================

import {
  bothWays,
  firstMatch,
  looksLikeContinuation,
  mentionsVocabulary,
  normaliseForGate,
  type GateRule,
  type GateVerdict,
} from "@/lib/desk/gate";

// ---------------------------------------------------------------------------
// THE REFUSAL SENTENCES. Exported so the prompt, the UI and the tests all read
// the same words, and so nothing downstream invents a softer version.
// ---------------------------------------------------------------------------

export const EQUIPMENT_REFUSALS = {
  /**
   * The safety refusal. It refuses, says why in one line, and hands over the one
   * action that IS correct — because a refusal with no route forward is how a
   * person ends up doing the dangerous thing anyway, having asked and been told
   * nothing.
   */
  safety:
    "I can't help with that one. Anything that defeats a safety interlock or guard, involves the mains supply or the inside of a machine, or means running equipment past its service or inspection date is for the manufacturer's engineer, not for me — the manual says the same. Call the supplier or service engineer on the asset's record, and take the machine out of use until they have seen it.",
  /**
   * THE JUDGEMENT REFUSAL — appended by the route to every facts-only answer.
   *
   * Not a substitute for the answer: the agent has just read out what the
   * register records and what the manual states, which is the half a practice is
   * entitled to. This is the half that is not ours: whether a machine that is
   * out of test may go on being used is a decision for the practice and the
   * engineer, and an agent that answers it is standing between a nurse and a
   * pressure vessel with an opinion nobody can be accountable for.
   *
   * Appended UNCONDITIONALLY rather than checked for in the model's reply. A
   * "did it already say this?" test is a fuzzy match on generated prose, and the
   * failure direction is silence on the one sentence that must always be there.
   * Occasional redundancy is the cheaper mistake by a wide margin.
   */
  judgement:
    "I can't tell you whether it is safe to keep using it — that is a decision for the practice and the manufacturer's engineer, not for me. Take the machine out of use and call the supplier or service engineer on its record.",
  /** Recognisably about something else entirely. */
  offTopic:
    "I only answer questions about the practice's registered equipment, using the manuals uploaded against them. That one is outside what I cover — the co-pilot on the Ask the brain page handles practice questions, and anything about a patient belongs in their record.",
  /** On topic, but the register is empty, so there is nothing to answer from. */
  nothingRegistered:
    "There is no equipment on the register yet, so I have nothing to answer from. Add your equipment on the Register tab (or import your existing spreadsheet), upload each manual, and I can answer from them.",
  /** Not recognisable as an equipment question at all. */
  outOfScope:
    "I can only help with the practice's registered equipment — what a machine is, where it is, when it is next due a service, and what its manual says about a fault. Name the machine you mean and I will look it up.",
} as const;

// ---------------------------------------------------------------------------
// 1. SAFETY. Checked first, over every user turn in the window.
//
// The spans are `[^.?!]{0,N}` rather than `.*` on purpose: a rule must match two
// things inside ONE sentence. `.*` would fire on "the interlock is fine. can you
// disable the daily reminder", which is a legitimate question about a different
// subject, and a gate that refuses legitimate questions gets switched off.
// ---------------------------------------------------------------------------

const PROTECTION =
  "interlock|door lock|lid lock|lid switch|door switch|safety switch|safety catch|limit switch|cut-?out|cutout|guard|shield|alarm|warning (?:light|buzzer|beep)|trip switch|rcd|residual current|fuse|earth|ground wire|thermal cut|pressure relief|relief valve|safety valve|emergency stop|e-?stop|lockout|dead ?man";

const DEFEAT =
  "bypass|by-?pass|defeat\\w*|overrid\\w*|disabl\\w*|deactivat\\w*|switch off|turn off|short(?: out)?|jump\\w*|tap(?:e|ing|ed)|wedg\\w*|trick|fool|cheat|circumvent\\w*|get (?:a)?round|work(?: a)?round|hot-?wire|remov\\w*";

/**
 * THE HARD REFUSALS. No model call, no facts, no exceptions.
 *
 * Every rule here describes an ACT: defeating a protection, working on the
 * mains, forcing a pressure chamber, exposing without shielding, doing the
 * engineer's job. There is nothing to read out that would help, because the help
 * being asked for is the dangerous part.
 *
 * Distinct from EQUIPMENT_JUDGEMENT_RULES below, which describe a QUESTION.
 */
export const EQUIPMENT_HARD_SAFETY_RULES: GateRule[] = [
  {
    // "how do I bypass the door interlock", "can I tape the lid switch down",
    // "the emergency stop is annoying, can it be wedged?" — one rule, both word
    // orders, because they are the same request (see `bothWays`).
    id: "safety.defeat_protection",
    pattern: bothWays(DEFEAT, PROTECTION, 50),
  },
  {
    // "can we keep using it without the guard / with the cover off / with no earth"
    id: "safety.run_without_protection",
    pattern: new RegExp(
      `\\b(?:run|use|using|keep using|carry on|carry on using|still use|operate)\\b[^.?!]{0,50}\\b(?:without|with no|minus|missing|with the)\\b[^.?!]{0,30}\\b(?:${PROTECTION}|cover|panel|casing|lid) ?(?:off|removed|open)?\\b`,
    ),
  },
  {
    // "just ignore the E11 warning", "how do I silence the fault alarm"
    id: "safety.ignore_warning",
    pattern:
      /\b(ignore|skip|dismiss|silence|mute|clear|reset|suppress|get rid of|stop)\b[^.?!]{0,40}\b(warning|alarm|error code|fault code|fault|safety notice|lockout|manufacturer'?s? (advice|instruction|warning))\b/,
  },
  {
    // Live electrical work by someone who is not an engineer.
    // The parts list is deliberately the INSIDE of the machine and its supply.
    // A filter, a gasket, an O-ring, a water reservoir and a printer roll are all
    // user-maintenance items the manual tells the practice to change themselves,
    // and the agent must go on reading those instructions out.
    id: "safety.electrical_work",
    pattern:
      /\b(re-?wire|rewiring|splice|strip the (wire|cable)|bare wire|live wire|mains (wiring|supply|terminal|voltage)|240 ?v|230 ?v|consumer unit|distribution board|solder|open (up )?the (electrical|mains|power|control) (box|panel|compartment)|(chang\w*|replac\w*|swap\w*|fit\w*|remov\w*|wir\w*) (the |a |an )?(mains )?(fuse|heating element|element|heater|thermostat|pcb|circuit board|transformer|capacitor|solenoid|contactor|relay))\b/,
  },
  {
    // The pressure vessel. Forcing a chamber open mid-cycle is the injury this
    // whole class exists for.
    id: "safety.pressure_vessel",
    pattern:
      /\b(open|force|prise|prize|pry|lever|crack|unscrew)\b[^.?!]{0,40}\b(door|chamber|lid|autoclave|steriliser|sterilizer|vessel)\b[^.?!]{0,50}\b(under pressure|pressuris|whilst|while|mid-?cycle|during (the )?cycle|still (hot|running|pressuris)|before it (cools|has cooled|depressuris))\b/,
  },
  {
    // Radiation. Never, in any framing. Bidirectional, because "do I really need
    // the dosimeter badge for the OPG?" puts the shielding first.
    id: "safety.radiation",
    pattern: bothWays(
      "x-?ray|radiograph\\w*|opg|cbct|dpt|tube ?head|exposure",
      "(?:without|no|skip\\w*|not wear\\w*|don'?t need|do i (?:really )?need|really need|forget|optional|do we have to wear)[^.?!]{0,30}(?:lead|apron|shield\\w*|screen|badge|dosimeter|barrier|thyroid)|(?:lead|apron|shield\\w*|badge|dosimeter|thyroid collar)[^.?!]{0,30}(?:optional|necessary|really needed|skip\\w*)",
      70,
    ),
  },
  {
    // A direct request to do the engineer's job. "Talk me through repairing the
    // heater" is the same request as the electrical one, one abstraction up.
    id: "safety.diy_repair",
    pattern: bothWays(
      "repair\\w*|fix\\w*|dismantl\\w*|strip\\w*|take (?:it|the unit|the machine|them) apart|servic\\w*|recalibrat\\w*|calibrat\\w*|overhaul\\w*|rebuild",
      "myself|ourselves|in-?house|by ourselves|without (?:an? )?engineer|instead of (?:calling|an engineer|the engineer)|to save (?:the |a |on )?(?:call|money|cost)",
      45,
    ),
  },
];


// ---------------------------------------------------------------------------
// 1b. THE JUDGEMENT QUESTIONS — facts allowed, decision refused.
//
// PROGRAMME RULING (W1-D), and it is the correction of a line I first drew too
// far. These are questions about a machine that is out of test, and there are
// three shapes that must be told apart:
//
//   "which equipment is overdue a service?"     ANSWERED. A register query, and
//                                               the most safety-POSITIVE thing a
//                                               practice manager can ask.
//   "can we keep using the overdue autoclave?"  FACTS read out, DECISION refused,
//                                               engineer named. This set.
//   "how do I bypass its interlock?"            HARD refusal, no model call.
//
// The middle one used to be a flat refusal, which was wrong in a way worth
// naming: the practice is entitled to know what its own register records and
// what the manufacturer's manual states about running past an interval. Refusing
// those facts does not make anyone safer — it sends somebody to guess, or to ask
// a colleague who will guess. What is not ours is the DECISION, and that half is
// refused deterministically: the route appends EQUIPMENT_REFUSALS.judgement to
// every facts-only answer itself rather than trusting the model to end with it.
//
// AND THE FACT MAY COME FROM THE REGISTER, NOT ONLY FROM THE PERSON. The two
// rules below need the out-of-test half spelled out in the message, and somebody
// who is ASKING does not spell it out: "is it safe to run the Lisa MB17?" is one
// sentence with no out-of-test word in it, and the REGISTER is the thing that
// knows the answer is "that machine's pressure test lapsed in August". So there
// is a third evidence path — `equipmentJudgementFromRegister` — pairing the same
// intent with the register's own overdue list. It NARROWS an allow and never
// creates one, and it never fires on a machine the register says is in date.
// ---------------------------------------------------------------------------

/**
 * WHAT "OUT OF TEST" SOUNDS LIKE WHEN A NURSE TYPES IT.
 *
 * Written as a named constant rather than inline because the prompt's own
 * refusal list (`prompt.ts`, WHAT YOU REFUSE, ALWAYS) names four words —
 * service, calibration, inspection, VALIDATION — and an earlier draft of this
 * rule carried only two of them. A boundary the prompt states and the gate
 * cannot see is a boundary that rests on the model, which is the one thing
 * `desk/gate.ts` exists to stop.
 *
 * EVERY BRANCH HERE IS PAST TENSE, AND THAT IS A CORRECTION. The W3/15 widening
 * added `due (?:in|back|last|on)` alongside `(?:was|were) due`, and three of
 * those four words are the ordinary English for a service that has NOT happened
 * yet: "the next service is due in June", "the service is due on the 3rd", "the
 * chair is due back from the engineer on Friday". Paired with the deliberately
 * generous KEEP_USING_INTENT below — which now carries "is that ok" — an
 * IN-DATE machine selected facts-only mode and both doors appended "Take the
 * machine out of use and call the supplier or service engineer" to a question
 * about a service three months away.
 *
 * That is not the cheap direction of error. The standing sentence only works
 * while it means something, and the way it stops working is being printed under
 * answers that did not need it until staff read past it — which is the day a
 * machine really is out of test. `due last` is kept because it IS past tense;
 * "was/were due" carries the rest ("our compressor service was due in June").
 * The register-aware rule below is what catches the person who never states the
 * fact at all, which is the case the widening was reaching for.
 */
const OUT_OF_TEST =
  "overdue|out of date|out of test|expired|lapsed|no longer in date" +
  "|past (?:its|the|it'?s) (?:\\w+ )?(?:service|inspection|test|date|calibration|validation|certificate|certification)" +
  "|behind on|missed|skipped|late for|haven'?t had|hasn'?t had|not had" +
  "|not been (?:serviced|tested|calibrated|validated|inspected)" +
  "|(?:was|were) due|due last";

/**
 * WHAT "MAY WE GO ON USING IT ANYWAY" SOUNDS LIKE.
 *
 * The list is deliberately generous. This side of the rule does not select
 * anything on its own — it can only fire when an out-of-test FACT is present as
 * well, either because the person stated it (rule 1) or because the register
 * says the named machine is past its date (`equipmentJudgementFromRegister`) — so a false
 * positive costs one extra appended sentence, while a false negative costs the
 * whole "always refused" half of W1-D/2. The phrasings W3/15 names by hand ("can
 * we still use it", "is it safe to run", "should I keep using", "is it OK to
 * carry on", "fine to use") are each covered below.
 */
const KEEP_USING_INTENT =
  "(?:keep|carry on|still|go on|continue) (?:go\\w*|us\\w*|runn\\w*)" +
  "|can (?:we|i) (?:still |just |really |safely |carry on |go on )?(?:use|run|keep|carry on|continue|go on)" +
  "|should (?:we|i) (?:keep|carry on|still|go on|continue|stop|be using)" +
  "|is (?:that|this|it) (?:ok|okay|fine|safe|a problem|alright|all right|acceptable)" +
  "|(?:ok|okay|fine|safe|alright|all right|acceptable) to (?:use|run|carry on|keep|continue|go on)" +
  "|can it (?:still )?be used" +
  "|does it matter|do we have to stop|need to stop|safe to (?:use|run|carry on)";

/**
 * The same intent as a standalone matcher, wrapped EXACTLY as
 * `bothWaysAcrossSentences` wraps it, so the register-aware rule below and the
 * stated-fact rule above cannot drift into recognising different sentences.
 */
const KEEP_USING_INTENT_RE = new RegExp(`\\b(?:${KEEP_USING_INTENT})\\b`);

/** The out-of-test half on its own, for the turn BEFORE a pronoun question. */
const OUT_OF_TEST_RE = new RegExp(`\\b(?:${OUT_OF_TEST})\\b`);

/**
 * The rule id reported when the REGISTER, not the person, supplied the fact.
 *
 * Named separately from `judgement.overdue_service` on purpose: the two are
 * caught by different evidence and a refusal count that cannot tell them apart
 * cannot answer "how often does somebody ask about a machine they do not know is
 * out of test", which is the question the practice would actually want.
 */
export const JUDGEMENT_FROM_REGISTER_RULE = "judgement.register_out_of_test";

/**
 * `bothWays`, BUT ALLOWED TO CROSS A FULL STOP — and only for this one class.
 *
 * Everywhere else in this file the spans are `[^.?!]{0,n}`, which is right: a
 * REFUSAL that pairs a word in one question with a word in the next is a gate
 * that refuses things nobody asked, and a gate that refuses legitimate questions
 * gets switched off. But the judgement rules do not refuse. They select
 * facts-only mode, which reads out everything the register and the manual say
 * and appends one standing instruction — so the two error directions here are
 * not comparable:
 *
 *   fires when it should not   one redundant "take it out of use" sentence.
 *   misses when it should fire the decision half of W1-D/2 rests on the prompt.
 *
 * And the miss was the common case, not the exotic one: "The autoclave is
 * overdue its service. Can we keep using it?" is how a person types at a front
 * desk, and a comma instead of that full stop was the only thing separating a
 * caught message from an uncaught one (programme ruling W3/15).
 *
 * Still bounded, not `.*`: the span keeps the two halves in the same THOUGHT
 * rather than the same message, so a genuine subject change three sentences
 * later does not pair with an overdue date mentioned at the start.
 */
function bothWaysAcrossSentences(a: string, b: string, span: number): RegExp {
  return new RegExp(
    `(?:\\b(?:${a})\\b[\\s\\S]{0,${span}}\\b(?:${b})\\b)|(?:\\b(?:${b})\\b[\\s\\S]{0,${span}}\\b(?:${a})\\b)`,
  );
}

export const EQUIPMENT_JUDGEMENT_RULES: GateRule[] = [
  {
    // KEEPING TO USE a machine that is past its service, calibration, inspection
    // or validation date.
    //
    // THE NARROWING THAT MATTERS. An earlier draft matched "overdue" near
    // "service" and nothing else, which refused "which of our equipment is
    // overdue a service?" — the single most useful, most safety-POSITIVE question
    // a practice manager can ask this agent, and exactly the question the
    // register exists to answer. So the rule now needs the second half: an intent
    // to go on using it anyway. Asking WHICH is a register query and is answered
    // normally; asking WHETHER IT IS FINE lands here, where the facts are read
    // out and the decision is handed to the engineer.
    id: "judgement.overdue_service",
    pattern: bothWaysAcrossSentences(OUT_OF_TEST, KEEP_USING_INTENT, 90),
  },
  {
    // The other phrasing of the same thing: "can we still use it, the service is
    // due next month" is fine; "can we use it until the service" is not.
    id: "judgement.use_until_service",
    pattern:
      /\b(ok|okay|safe|fine|alright|all right|can we|can i|is it (ok|okay|safe|fine))\b[^.?!]{0,60}\b(use|run|carry on|keep going)\b[^.?!]{0,50}\b(until|till|before|pending|awaiting|despite|even though)\b[^.?!]{0,40}\b(service|engineer|repair|inspection|calibration|part|fixed)\b/,
  },
];

// ---------------------------------------------------------------------------
// 2. OFF TOPIC. Deny rules that beat the allow-list below, so a message that
// names a machine AND a patient is refused rather than answered.
// ---------------------------------------------------------------------------

export const EQUIPMENT_OFF_TOPIC_RULES: GateRule[] = [
  {
    // Anything clinical or about a person in the book. This agent has no patient
    // data, no clinical training and no business having an opinion.
    id: "offtopic.clinical",
    pattern:
      /\b(patient|patients|diagnos\w*|prescri\w*|symptom|toothache|tooth|teeth|filling|extraction|root canal|implant|denture|crown|whitening|anaesthet\w*|antibiotic|medical history|treatment plan|recall|dosage|mg\b|pain relief|swelling|abscess)\b/,
  },
  {
    // The practice's money. There is a co-pilot for this and it is owner-gated.
    id: "offtopic.money",
    pattern:
      /\b(takings|revenue|turnover|profit|invoice|outstanding balance|owes|owed|debtor|payroll|salary|salaries|wages|payslip|uda|what do we charge|our prices|price list|discount)\b|\bhow much (did|do|does) (we|the practice|us|you)\b|\b(take|took|make|made|earn|earned) last (week|month|year)\b/,
  },
  {
    // Staff, HR and the rota.
    id: "offtopic.people",
    pattern:
      /\b(rota|shift|holiday|annual leave|sick (pay|leave|note)|appraisal|disciplinary|grievance|contract of employment|recruit\w*|interview|maternity|probation)\b/,
  },
  {
    id: "offtopic.marketing",
    pattern:
      /\b(google ad|facebook|instagram|tiktok|ad campaign|advert\w*|seo|landing page|marketing|social media|new patient offer|lead)\b/,
  },
  {
    // General-purpose assistant use. The single most common way a narrow agent
    // stops being narrow is somebody discovering it will write their emails.
    id: "offtopic.general_assistant",
    pattern:
      /\b(weather|capital of|tell me a joke|write (me )?(a|an|the) (poem|song|story|essay|letter|email|speech|blog)|recipe|football|premier league|who won|translate|python|javascript|sql query|spreadsheet formula|excel formula|holiday destination|restaurant)\b/,
  },
  {
    // Attempts to re-instruct the agent. Refused as a topic rather than treated
    // as a safety event, because the overwhelming majority are curiosity — but
    // refused all the same, and never passed to the model.
    id: "offtopic.instruction_override",
    pattern:
      /\b(ignore (all |any |your |the )?(previous |prior |above |earlier )?(instruction|rule|prompt)|forget (your|the|all) (instruction|rule|prompt|training)|you are now|from now on you|new instructions|system prompt|your prompt|act as (a|an|if)|pretend (to be|you are)|roleplay|jailbreak|developer mode|dan mode|no restrictions|without any (rules|restrictions|limits))\b/,
  },
];

// ---------------------------------------------------------------------------
// 3. THE ALLOW-LIST. A message must name a registered asset, or use the
// vocabulary of dental equipment, or (mid-conversation) read as a continuation.
// ---------------------------------------------------------------------------

/**
 * Equipment nouns. Broad enough that a nurse's plain question gets through.
 *
 * THE GENERIC NOUNS ARE HERE ON PURPOSE (programme ruling W3/20). The list is
 * otherwise an enumeration of SPECIFIC kit — autoclave, compressor, chair — and
 * a person who has not yet named a machine does not use those words: they say
 * "which machines are out of test?" or "what equipment do we have?", which are
 * the register's own two headline questions and which this list refused, with
 * "Name the machine you mean", until `machine`/`equipment` were added to it.
 * (`list_assets`' own tool description offers "what equipment do we have" as its
 * example use, and the gate in front of it would not let the sentence through.)
 *
 * Widening the ALLOW-LIST cannot widen anything dangerous: hard safety (step 1),
 * off topic (step 2), the empty register (step 3) and the judgement rules
 * (steps 4/4b) have all already run by the time this list is consulted, and 4b
 * NARROWS the allow it produces. The cost of a false positive here is one
 * on-topic-looking question reaching a desk that will say it cannot find that
 * machine; the cost of the false negative was refusing "which machines are out
 * of test?", which is the most safety-positive question the register answers.
 */
const EQUIPMENT_TERMS =
  /\b(machine\w*|equipment|autoclave|steril\w*|sterilis\w*|steriliz\w*|decon\w*|washer.?disinfector|ultrasonic (bath|cleaner)|thermal disinfector|compressor|suction|aspirator|vacuum pump|handpiece|contra.?angle|turbine|micromotor|scaler|cavitron|curing light|light cure|x-?ray|radiograph\w*|opg|dpt|cbct|tube ?head|phosphor plate|sensor|intra-?oral (camera|scanner)|scanner|dental chair|chair|dental unit|operating light|spittoon|amalgam separator|waterline|water line|ro unit|reverse osmosis|distiller|water softener|apex locator|endo motor|sandblaster|model trimmer|vacuum former|laser|nitrous|sedation|oxygen|defibrillat\w*|aed|emergency drug|fire extinguisher|legionella|boiler|air ?con\w*|fridge|refrigerator|centrifuge|microscope|loupe|pouch sealer|heat sealer|tray|cassette)\b/;

/**
 * Maintenance vocabulary — the words a fault report is made of.
 *
 * "OUT OF TEST" LIVES HERE NOW, WHICH IT DID NOT (programme ruling W3/20). The
 * phrase existed in this file only inside `OUT_OF_TEST`, which the JUDGEMENT
 * rules read at steps 4/4b — and those, by their own comment, "narrow an allow,
 * never create one". So the words a nurse uses for a lapsed service could
 * constrain an answer and could not obtain one: "which machines are out of
 * test?" fell through to `scope.unrecognised`. The out-of-test phrasings are
 * repeated here rather than spliced in from `OUT_OF_TEST` deliberately — that
 * constant is deliberately ALL PAST TENSE for a reason its own comment sets out
 * at length (an in-date machine must not select facts-only mode), and this list
 * has the opposite job: recognising the topic, whatever the tense.
 */
const MAINTENANCE_TERMS =
  /\b(out of test|out of date|in date|due (?:a|an|its|another) (?:test|service|inspection|calibration|validation|check)|(?:test|service|servic\w*|calibrat\w*|validat\w*|inspect\w*)(?:ing|ed|ion)? (?:due|overdue)|need\w* (?:a |an )?(?:test|testing|tested|service|servicing|serviced|calibrat\w*|validat\w*|inspect\w*)|error code|fault code|error|fault|e\d{2}\b|breakdown|broken|not working|won'?t (start|turn on|run|drain|fill|seal|close)|leaking|leak|dripping|noisy|overheat\w*|smell\w*|cycle|programme|program|abort|filter|gasket|seal|o-?ring|hose|belt|blade|bulb|lamp|cartridge|consumable|spare part|serial number|model number|warranty|service (due|date|record|history)|next service|last service|overdue|engineer|supplier|manual|instruction book|register|asset|inventory|pat test|calibration|log book|reservoir|chamber|drain|distilled water|temperature|pressure)\b/;

/** True when this message reads like a question about the practice's kit. */
export function looksLikeEquipmentQuestion(normalised: string): boolean {
  return EQUIPMENT_TERMS.test(normalised) || MAINTENANCE_TERMS.test(normalised);
}

// ---------------------------------------------------------------------------

export interface EquipmentGateInput {
  /** Every user turn in the window, oldest first. Safety runs over all of them. */
  userTurns: string[];
  /**
   * Names, makes, models and serials from the register, so "is the Lisa due a
   * service?" is recognised without the word "autoclave" appearing anywhere.
   */
  registerVocabulary: readonly string[];
  /**
   * THE SUBSET OF `registerVocabulary` BELONGING TO ASSETS THE REGISTER SAYS ARE
   * PAST THEIR NEXT SERVICE DATE. Names, makes, models and serials, same shape.
   *
   * WITHOUT THIS THE JUDGEMENT GATE ONLY FIRES WHEN THE PERSON RESTATES THE FACT,
   * and a person asking does not restate it — that is what asking is. Every one
   * of the five phrasings W3/15 names by hand ("can we still use the Lisa MB17?",
   * "is it safe to run the Lisa MB17?", "should I keep using the autoclave?", "is
   * it OK to carry on with the autoclave?", "is the Lisa MB17 fine to use?")
   * reached the model as an ordinary allow with no mode, so neither door appended
   * the take-out-of-use sentence and the "always refused" half of W1-D/2 rested
   * on the prompt — the exact posture `desk/gate.ts` exists to stop.
   *
   * OPTIONAL ONLY SO THE TYPE DOES NOT BREAK A CALLER MID-WIRING. Omitting it is
   * NOT a neutral choice: it disarms this half of the rule silently, and a caller
   * that can compute it (both callers hold `assets` and `today` already) must.
   */
  outOfTestVocabulary?: readonly string[];
  /** How many assets the practice has registered. Zero has its own refusal. */
  registeredCount: number;
  /** True once an earlier turn resolved a specific asset (enables continuations). */
  assetInScope: boolean;
}

/** The register fields a caller already holds, shaped so this file imports nothing. */
export interface OutOfTestSource {
  name: string;
  make: string | null;
  model: string | null;
  serial: string | null;
  nextServiceDue: string | null;
}

/**
 * BUILD `outOfTestVocabulary` FROM THE REGISTER. One helper rather than the same
 * filter written out at each door, because the two doors drifting on what counts
 * as "overdue" is how one of them quietly stops arming the rule.
 *
 * Overdue is `nextServiceDue` strictly BEFORE today — the same line
 * `service_due` draws when it puts an asset in `overdue` rather than `dueSoon`
 * (`daysUntil < 0`). Both are ISO YYYY-MM-DD in London, so the comparison is a
 * string comparison and there is no clock in here.
 *
 * An asset with no service date recorded is NOT overdue. It is unknown, which is
 * a different fact and one the register reports separately; treating unknown as
 * overdue would put the take-out-of-use sentence under every question about
 * every asset a practice has not finished filling in.
 */
export function outOfTestVocabulary(
  assets: readonly OutOfTestSource[],
  today: string,
): string[] {
  return assets
    .filter((a) => a.nextServiceDue !== null && a.nextServiceDue < today)
    .flatMap((a) => [a.name, a.make, a.model, a.serial].filter((v): v is string => Boolean(v)));
}

/**
 * TRUE when the person is asking whether to go on using a machine the REGISTER
 * says is out of test — whether or not they know it is.
 *
 * Two shapes, and the second is the one people actually type:
 *
 *   "Is it safe to run the Lisa MB17?"        the latest turn carries the intent
 *                                             AND names an out-of-test asset.
 *   "Which of ours is overdue?" / "Can we      the latest turn carries the intent
 *    still use it?"                            and names no machine at all; the
 *                                             turn immediately before it either
 *                                             named an out-of-test asset or
 *                                             stated the out-of-test fact.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is fire on the intent alone. "Can we still use
 * the Lisa MB17?" about a machine that is IN date must come back unconstrained:
 * appending "take the machine out of use and call the engineer" to a question
 * about a compliant autoclave is its own harm, and it is how the sentence stops
 * being read at all. So a latest turn that names a registered asset which is not
 * on the out-of-test list ends the check there — the person named a machine, and
 * the register says that machine is fine.
 *
 * Only the PREVIOUS turn is consulted for the split, not the whole window: two
 * consecutive turns are one thought, and a machine mentioned six turns ago is
 * not what "it" refers to.
 */
export function equipmentJudgementFromRegister(
  userTurns: readonly string[],
  input: { registerVocabulary: readonly string[]; outOfTestVocabulary?: readonly string[] },
): boolean {
  const outOfTest = input.outOfTestVocabulary ?? [];
  if (outOfTest.length === 0) return false;

  // Normalised here as well as by the gate: `normaliseForGate` is idempotent, and
  // the co-pilot door calls this with the person's RAW turns (its own window ends
  // with the model's paraphrase, which must not be what decides this).
  const turns = userTurns.map(normaliseForGate).filter((t) => t.length > 0);
  const latest = turns[turns.length - 1];
  if (latest === undefined) return false;
  if (!KEEP_USING_INTENT_RE.test(latest)) return false;
  if (mentionsVocabulary(latest, outOfTest)) return true;
  // The person named a machine and it is not one of the overdue ones.
  if (mentionsVocabulary(latest, input.registerVocabulary)) return false;

  const previous = turns[turns.length - 2];
  if (previous === undefined) return false;
  // The turn before a pronoun question either NAMED an overdue machine ("is the
  // Lisa MB17 overdue?" / "can we still use it?") or stated the out-of-test fact
  // without naming one ("which of our equipment is overdue?" / "can we still use
  // it?"). Both are the same thought, and the second is the shape the register
  // itself invites, because "which is overdue" is the question W1-D/2 says is
  // always answered.
  return mentionsVocabulary(previous, outOfTest) || OUT_OF_TEST_RE.test(previous);
}

/**
 * The gate. Pure, synchronous, and the only thing standing between the request
 * and `runAgentTurn`.
 */
export function gateEquipmentQuestion(input: EquipmentGateInput): GateVerdict {
  const turns = input.userTurns.map(normaliseForGate).filter((t) => t.length > 0);
  if (turns.length === 0) {
    return {
      kind: "refuse",
      reason: "out_of_scope",
      message: EQUIPMENT_REFUSALS.outOfScope,
      rule: "scope.empty_message",
    };
  }

  // 1. HARD SAFETY, over every turn in the window. A request planted three
  //    messages back is still in the context the model reads.
  for (const turn of turns) {
    const hit = firstMatch(EQUIPMENT_HARD_SAFETY_RULES, turn);
    if (hit) {
      return { kind: "refuse", reason: "safety", message: EQUIPMENT_REFUSALS.safety, rule: hit.id };
    }
  }

  const latest = turns[turns.length - 1];

  // 2. OFF TOPIC beats the allow-list.
  const offTopic = firstMatch(EQUIPMENT_OFF_TOPIC_RULES, latest);
  if (offTopic) {
    return {
      kind: "refuse",
      reason: "off_topic",
      message: EQUIPMENT_REFUSALS.offTopic,
      rule: offTopic.id,
    };
  }

  // 3. Nothing to answer from. Checked before the allow-list so an on-topic
  //    question against an empty register gets the useful sentence, not "out of
  //    scope" — the practice has done nothing wrong, they just have not loaded
  //    the register yet.
  if (input.registeredCount <= 0) {
    return {
      kind: "refuse",
      reason: "nothing_to_answer_from",
      message: EQUIPMENT_REFUSALS.nothingRegistered,
      rule: "scope.empty_register",
    };
  }

  // 4. THE JUDGEMENT QUESTIONS. Checked before the allow-list, because they
  //    would otherwise pass it as ordinary equipment questions and lose the
  //    constraint. Only the LATEST turn: a judgement asked and answered three
  //    messages ago must not silently facts-only-cap a later, ordinary question.
  const judgement = firstMatch(EQUIPMENT_JUDGEMENT_RULES, latest);
  if (judgement) return { kind: "allow", mode: "facts_only", rule: judgement.id };

  // 4b. THE SAME QUESTION, ASKED WITHOUT STATING THE FACT — because the person
  //     is ASKING. The rules above need the out-of-test half in the person's own
  //     words; this one takes it from the register instead.
  //
  //     IT NARROWS AN ALLOW, IT NEVER CREATES ONE. Deliberately applied to the
  //     allow-list results below rather than returned here: a message that would
  //     have been refused as out of scope must still be refused, or a rule whose
  //     whole purpose is to CONSTRAIN an answer would have widened the gate.
  const fromRegister = equipmentJudgementFromRegister(turns, input);
  const allow: GateVerdict = fromRegister
    ? { kind: "allow", mode: "facts_only", rule: JUDGEMENT_FROM_REGISTER_RULE }
    : { kind: "allow" };

  // 5. ALLOW-LIST.
  if (mentionsVocabulary(latest, input.registerVocabulary)) return allow;
  if (looksLikeEquipmentQuestion(latest)) return allow;
  if (input.assetInScope && looksLikeContinuation(latest)) return allow;

  return {
    kind: "refuse",
    reason: "out_of_scope",
    message: EQUIPMENT_REFUSALS.outOfScope,
    rule: "scope.unrecognised",
  };
}
