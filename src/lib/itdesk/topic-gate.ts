// ===========================================================================
// THE IT DESK AGENT'S SERVER-SIDE GATE.
//
// Same shape as the equipment agent's (see src/lib/desk/gate.ts for why the gate
// exists at all when the rules are also in the system prompt), with a different
// deny class in the safety slot.
//
// FOR AN IT DESK, "SAFETY" IS SECURITY. The four things this agent must never do,
// enforced here rather than asked for in a prompt:
//
//   1. HANDLE A CREDENTIAL. It never reads out, stores, sets, or asks for a
//      password, PIN, key or code. Not the Wi-Fi password, not a shared login,
//      not "just this once". A desk that hands out credentials trains a practice
//      to hand out credentials, and that is how a phishing call succeeds.
//   2. WEAKEN A PROTECTION. Antivirus, firewall, disk encryption, MFA, screen
//      lock, automatic updates: not turned off, not "just for now".
//   3. OFFER REMOTE ACCESS OR ENDPOINT SOFTWARE. The installed per-computer
//      agent is PARKED BY DECISION (programme charter §4). The refusal is not
//      only "we can't", it must not hint that we could — no copy anywhere in
//      this module may promise a thing the practice has not agreed to install.
//   4. MOVE PATIENT DATA. Exporting the database, emailing a patient list,
//      copying records to a personal device: refused outright, and it is not a
//      close call.
//
// EVERY RULE IS NAMED AND EVERY REFUSAL REPORTS THE NAME. `topic-gate.test.ts`
// asserts the rule id, so a battery entry cannot pass by tripping a neighbour.
// ===========================================================================

import {
  bothWays,
  firstMatch,
  looksLikeContinuation,
  normaliseForGate,
  type GateRule,
  type GateVerdict,
} from "@/lib/desk/gate";

export const IT_DESK_REFUSALS = {
  /** Credentials. Separate from the other security refusals: staff ask this one innocently, constantly. */
  credentials:
    "I never handle passwords, PINs or access codes — I will not read one out, set one, or ask you for one, and nobody legitimate ever will either. If you are locked out, the practice's IT contact does the reset; for this platform, use the 'Forgotten password' link and set it yourself.",
  /** Weakening a protection, remote access, admin rights, moving patient data. */
  security:
    "That one I have to refuse. Turning off antivirus, a firewall, encryption or two-factor sign-in, granting admin rights, taking remote control of a machine, or moving patient data off the practice's systems are all decisions for the practice's IT contact and the owner — not something to do from a chat window. Tell them what you are trying to achieve and they will find a safe way to do it.",
  offTopic:
    "I only help with the practice's day-to-day IT: the internet and network, printers and scanning, logins, getting into Dentally, and the iPads and form kiosks. That one is outside what I cover — the co-pilot on the Ask the brain page handles practice questions, and anything about a patient belongs in their record.",
  outOfScope:
    "I can help with the internet and network, printers and scanning, being locked out, getting into Dentally, and the iPads or form kiosks. Tell me what is not working and what you see on the screen, and I will walk you through it.",
} as const;

// ---------------------------------------------------------------------------
// 1a. CREDENTIALS.
// ---------------------------------------------------------------------------

const SECRET =
  "password|passwords|passcode|pass ?phrase|\\bpin\\b|security code|access code|one-?time code|otp|\\b2fa code\\b|mfa code|api key|secret key|licence key|license key|product key|credential\\w*|login details|log-?in details|sign-?in details|username and password";

export const IT_DESK_SAFETY_RULES: GateRule[] = [
  {
    // DISCLOSURE. "what's the wifi password", "can you tell me the admin
    // password", "remind me of the Dentally login details".
    //
    // THE VERBS HERE ARE DELIBERATELY ONLY THE DISCLOSING ONES. An earlier draft
    // included "need", which refused "I need my password reset for Dentally, who
    // does that?" — the single most common IT-desk question in a dental practice
    // and one this agent is FOR: routing a reset to the right person is the whole
    // of the accounts playbook. Asking WHO resets it is in scope; asking WHAT it
    // is never is. That line is the rule, and it is asserted in both directions.
    id: "security.asks_for_credential",
    pattern: bothWays(
      "what(?:'s| is| are)|tell me|give me|send me|remind me|share|read (?:me |out )?|do you (?:know|have)|look up|find out",
      SECRET,
      45,
    ),
  },
  {
    // SUPPLYING or SETTING one. Matched by SHAPE rather than by verb proximity,
    // for the same reason: "reset" near "password" is a routing question, while
    // "my password is ..." and "set my password to ..." are a secret arriving in
    // a chat log and a request to choose one. Neither ever belongs here.
    id: "security.supplies_or_sets_credential",
    pattern: new RegExp(
      `\\b(?:my|the|our|his|her|their|a) (?:${SECRET}) (?:is|was|=)\\b` +
        `|\\b(?:set|change|make|reset|update) (?:my|the|our|his|her|their) (?:${SECRET}) to\\b` +
        `|\\b(?:use|store|save|write down|type in|remember|keep) (?:my|the|our) (?:${SECRET})\\b`,
    ),
  },
  {
    // Weakening a protection.
    id: "security.weaken_protection",
    pattern: bothWays(
      "disabl\\w*|turn off|switch off|uninstall|remov\\w*|bypass|by-?pass|get (?:a)?round|skip|opt out of|pause|stop",
      "anti-?virus|antivirus|firewall|defender|endpoint protection|encryption|bitlocker|filevault|\\bmfa\\b|\\b2fa\\b|two-?factor|multi-?factor|screen ?lock|auto-?lock|automatic updates|windows update|security update|backup",
      50,
    ),
  },
  {
    // Remote access and endpoint software. PARKED BY DECISION, and the refusal
    // must not read as "not yet" — see the header note.
    id: "security.remote_access",
    pattern:
      /\b(remote(ly)? (access|control|desktop|session|in(to)?|onto)|take (over|control of) (my|the|this) (screen|machine|computer|pc)|teamviewer|anydesk|logmein|screen ?share|rdp|vnc|install (an? )?(agent|software|program|app) on|put (an? )?agent on|remote support tool)\b/,
  },
  {
    // Admin rights.
    id: "security.admin_rights",
    pattern:
      /\b(local admin|admin rights|administrator (rights|access|account|password)|sudo|root access|elevate (my|the) (rights|privileges)|make me (an )?admin|run as administrator)\b/,
  },
  {
    // Patient data leaving the practice's systems.
    id: "security.exfiltrate_patient_data",
    pattern: bothWays(
      "export|download|extract|copy|email|e-?mail|send|upload|move|back ?up|dump|print off",
      "patient (?:data|record|records|list|details|database)|the database|whole database|dentally (?:data|database|export)|patient information",
      50,
    ),
  },
];

// ---------------------------------------------------------------------------
// 2. OFF TOPIC.
// ---------------------------------------------------------------------------

export const IT_DESK_OFF_TOPIC_RULES: GateRule[] = [
  {
    id: "offtopic.clinical",
    pattern:
      /\b(diagnos\w*|prescri\w*|symptom|toothache|tooth|teeth|filling|extraction|root canal|implant|denture|crown|whitening|anaesthet\w*|antibiotic|medical history|treatment plan|dosage|pain relief|swelling|abscess|which patients|patient'?s (details|history|record))\b/,
  },
  {
    id: "offtopic.money",
    pattern:
      /\b(takings|revenue|turnover|profit|invoice|outstanding balance|owes|owed|debtor|payroll|salary|salaries|wages|payslip|uda|what do we charge|our prices|price list)\b|\bhow much (did|do|does) (we|the practice|us|you)\b/,
  },
  {
    id: "offtopic.people",
    pattern:
      /\b(rota|shift|holiday|annual leave|sick (pay|leave|note)|appraisal|disciplinary|grievance|contract of employment|recruit\w*|maternity|probation)\b/,
  },
  {
    id: "offtopic.marketing",
    pattern:
      /\b(google ad|facebook|instagram|tiktok|ad campaign|advert\w*|seo|landing page|marketing|social media|new patient offer)\b/,
  },
  {
    id: "offtopic.general_assistant",
    pattern:
      /\b(weather|capital of|tell me a joke|write (me )?(a|an|the) (poem|song|story|essay|letter|email|speech|blog)|recipe|football|premier league|who won|translate|holiday destination|restaurant)\b/,
  },
  {
    id: "offtopic.instruction_override",
    pattern:
      /\b(ignore (all |any |your |the )?(previous |prior |above |earlier )?(instruction|rule|prompt)|forget (your|the|all) (instruction|rule|prompt|training)|you are now|from now on you|new instructions|system prompt|your prompt|act as (a|an|if)|pretend (to be|you are)|roleplay|jailbreak|developer mode|dan mode|no restrictions|without any (rules|restrictions|limits))\b/,
  },
  {
    // Development work. An IT desk that will write code is not an IT desk.
    id: "offtopic.write_code",
    pattern:
      /\b(write|generate|debug|fix) (me )?(some |a |an )?(python|javascript|typescript|sql|vba|powershell|bash|code|script|macro|formula|regex)\b/,
  },
];

// ---------------------------------------------------------------------------
// 3. ALLOW-LIST. The vocabulary of front-desk IT.
// ---------------------------------------------------------------------------

const IT_TERMS =
  /\b(wi-?fi|internet|network|ethernet|router|broadband|hub|modem|offline|online|connection|connect\w*|vpn|printer|print\w*|scanner|scan\w*|toner|ink|paper ?jam|tray|queue|login|log ?in|log ?on|sign ?in|signed out|locked out|account|dentally|diary (?:will not|won'?t) (?:open|load)|ipad|i-?pad|tablet|kiosk|screen|monitor|display|keyboard|mouse|\bpc\b|laptop|computer|machine|desktop|browser|chrome|edge|safari|firefox|email|e-?mail|outlook|inbox|software|app\b|application|update|reboot|restart|frozen|freezes|crash\w*|slow|lagging|not loading|will not load|won'?t load|blue screen|error message|pop-?up|backup|server|phone system|voip|headset|webcam|camera|card machine|payment terminal|barcode|label printer)\b/;

/** True when this reads like a front-desk IT problem. */
export function looksLikeItQuestion(normalised: string): boolean {
  return IT_TERMS.test(normalised);
}

export interface ItDeskGateInput {
  /** Every user turn in the window, oldest first. Security runs over all of them. */
  userTurns: string[];
  /** True once an earlier turn put a playbook in scope (enables continuations). */
  playbookInScope: boolean;
}

/** The gate. Pure, synchronous, and runs before `runAgentTurn`. */
export function gateItDeskQuestion(input: ItDeskGateInput): GateVerdict {
  const turns = input.userTurns.map(normaliseForGate).filter((t) => t.length > 0);
  if (turns.length === 0) {
    return {
      kind: "refuse",
      reason: "out_of_scope",
      message: IT_DESK_REFUSALS.outOfScope,
      rule: "scope.empty_message",
    };
  }

  // 1. SECURITY, over every turn. The credential rules get their own sentence,
  //    because "I never handle passwords" is a different (and more reassuring)
  //    thing to say than "that is a decision for your IT contact".
  for (const turn of turns) {
    const hit = firstMatch(IT_DESK_SAFETY_RULES, turn);
    if (hit) {
      const isCredential = hit.id.includes("credential");
      return {
        kind: "refuse",
        reason: "safety",
        message: isCredential ? IT_DESK_REFUSALS.credentials : IT_DESK_REFUSALS.security,
        rule: hit.id,
      };
    }
  }

  const latest = turns[turns.length - 1];

  // 2. OFF TOPIC beats the allow-list.
  const offTopic = firstMatch(IT_DESK_OFF_TOPIC_RULES, latest);
  if (offTopic) {
    return {
      kind: "refuse",
      reason: "off_topic",
      message: IT_DESK_REFUSALS.offTopic,
      rule: offTopic.id,
    };
  }

  // 3. ALLOW-LIST. Note there is no "nothing to answer from" branch here, and
  //    that is the one real difference from the equipment gate: the playbooks
  //    ship with the product, so this agent always has something to say.
  if (looksLikeItQuestion(latest)) return { kind: "allow" };
  if (input.playbookInScope && looksLikeContinuation(latest)) return { kind: "allow" };

  return {
    kind: "refuse",
    reason: "out_of_scope",
    message: IT_DESK_REFUSALS.outOfScope,
    rule: "scope.unrecognised",
  };
}
