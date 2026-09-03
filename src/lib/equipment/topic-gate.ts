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
// ---------------------------------------------------------------------------

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
    pattern: bothWays(
      "overdue|out of date|expired|past (?:its|the|it'?s) (?:service|inspection|test|date)|behind on|missed|skipped|late for|haven'?t had|hasn'?t had|not had",
      "(?:keep|carry on|still|go on) (?:go\\w*|us\\w*|runn\\w*)|can we (?:use|run|keep)|can i (?:use|run|keep)|is (?:that|this|it) (?:ok|okay|fine|safe|a problem|alright)|does it matter|do we have to stop|need to stop|safe to (?:use|run)",
      80,
    ),
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

/** Equipment nouns. Broad enough that a nurse's plain question gets through. */
const EQUIPMENT_TERMS =
  /\b(autoclave|steril\w*|sterilis\w*|steriliz\w*|decon\w*|washer.?disinfector|ultrasonic (bath|cleaner)|thermal disinfector|compressor|suction|aspirator|vacuum pump|handpiece|contra.?angle|turbine|micromotor|scaler|cavitron|curing light|light cure|x-?ray|radiograph\w*|opg|dpt|cbct|tube ?head|phosphor plate|sensor|intra-?oral (camera|scanner)|scanner|dental chair|chair|dental unit|operating light|spittoon|amalgam separator|waterline|water line|ro unit|reverse osmosis|distiller|water softener|apex locator|endo motor|sandblaster|model trimmer|vacuum former|laser|nitrous|sedation|oxygen|defibrillat\w*|aed|emergency drug|fire extinguisher|legionella|boiler|air ?con\w*|fridge|refrigerator|centrifuge|microscope|loupe|pouch sealer|heat sealer|tray|cassette)\b/;

/** Maintenance vocabulary — the words a fault report is made of. */
const MAINTENANCE_TERMS =
  /\b(error code|fault code|error|fault|e\d{2}\b|breakdown|broken|not working|won'?t (start|turn on|run|drain|fill|seal|close)|leaking|leak|dripping|noisy|overheat\w*|smell\w*|cycle|programme|program|abort|filter|gasket|seal|o-?ring|hose|belt|blade|bulb|lamp|cartridge|consumable|spare part|serial number|model number|warranty|service (due|date|record|history)|next service|last service|overdue|engineer|supplier|manual|instruction book|register|asset|inventory|pat test|calibration|log book|reservoir|chamber|drain|distilled water|temperature|pressure)\b/;

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
  /** How many assets the practice has registered. Zero has its own refusal. */
  registeredCount: number;
  /** True once an earlier turn resolved a specific asset (enables continuations). */
  assetInScope: boolean;
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

  // 5. ALLOW-LIST.
  if (mentionsVocabulary(latest, input.registerVocabulary)) return { kind: "allow" };
  if (looksLikeEquipmentQuestion(latest)) return { kind: "allow" };
  if (input.assetInScope && looksLikeContinuation(latest)) return { kind: "allow" };

  return {
    kind: "refuse",
    reason: "out_of_scope",
    message: EQUIPMENT_REFUSALS.outOfScope,
    rule: "scope.unrecognised",
  };
}
