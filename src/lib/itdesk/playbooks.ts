// ===========================================================================
// THE SHIPPED TROUBLESHOOTING PLAYBOOKS.
//
// WHY THESE ARE CODE AND NOT ROWS. The compliance module ships the CQC framework
// the same way (`src/lib/compliance/knowledge.ts`): reference knowledge that is
// true of every UK dental practice ships with the product, and the practice's own
// records go on top. These five playbooks are the front-desk IT problems every
// practice has, written so a receptionist can follow them without help. They are
// the agent's knowledge base, and they are versioned, reviewable and diffable
// precisely because they are source rather than data somebody typed once.
//
// WHAT IS DELIBERATELY ABSENT FROM EVERY STEP:
//   - anything needing local admin rights or an installer;
//   - anything that touches a password, a PIN or a key (the agent ROUTES a
//     password problem, it never handles one — see topic-gate.ts);
//   - anything involving remote access or endpoint software of ours, which is
//     parked by decision and must not appear even as a suggestion;
//   - anything about the clinical record. "Dentally access" is about GETTING IN,
//     never about what is inside.
//
// A practice-specific playbook (their own printer, their own broadband) is a
// later, owner-dependent addition: it needs the practice to tell us what theirs
// are, and migration 0099 explains why no table is shipped for it yet.
// ===========================================================================

import type { Playbook, PlaybookArea } from "./types";

/** The last line of every escalation, so the hand-off reads the same each time. */
const HANDOFF = "then it is one for the practice's IT contact";

export const PLAYBOOKS: Playbook[] = [
  {
    id: "connectivity.no-internet",
    area: "connectivity",
    title: "No internet, or the internet keeps dropping",
    symptoms: [
      "no internet",
      "the internet is down",
      "wifi not working",
      "web pages will not load",
      "the connection keeps dropping",
      "everything is offline",
    ],
    steps: [
      "Check whether it is one machine or all of them. If one computer is offline and the others are fine, it is that computer; if everything is offline, it is the line or the router.",
      "On the affected computer, look at the network icon by the clock. If it says no connection, and the machine is on Wi-Fi, turn Wi-Fi off and on again and reconnect to the practice network.",
      "If the machine is wired, unplug the network cable at both ends and plug it back in firmly until it clicks. A half-seated cable is the single most common cause.",
      "If every machine is offline, look at the router or broadband box: note which lights are on, which are off and which are flashing or red, and write that down — it is the first thing the IT contact will ask.",
      "Restart the router only if the practice's own procedure allows it: switch it off at the wall, wait 30 seconds, switch it back on and give it 3 to 5 minutes to come back. Do not do this mid-treatment or while anyone is taking a payment.",
      "Once it is back, re-check the affected machine before telling anyone it is fixed.",
    ],
    escalation:
      `If it is still down after a full router restart, or the broadband box shows a red or off light, stop there — ${HANDOFF} (and, if the line itself is down, the broadband provider). Tell them which lights, which machines, and what time it started.`,
  },
  {
    id: "printing.wont-print",
    area: "printing",
    title: "Nothing will print",
    symptoms: [
      "the printer is not printing",
      "nothing comes out",
      "print jobs are stuck",
      "printer offline",
      "cannot print",
    ],
    steps: [
      "Check the printer itself first: powered on, no error on its display, paper in the tray, no lid open, no paper jam.",
      "Check whether it prints from a different computer. If it does, the problem is the computer, not the printer.",
      "On the computer, open the print queue and clear any stuck jobs — a single failed job at the front of the queue holds up everything behind it.",
      "If the printer shows as offline on the computer, right-click it and take it out of offline mode, then send one test page.",
      "If it is a network printer and nothing has worked, switch the printer off at the wall, wait 30 seconds and switch it back on. Give it two minutes to rejoin the network before trying again.",
      "If a jam is showing, follow the diagram on the printer's own flap. Pull jammed paper in the direction the paper travels, slowly, and never through the fuser area while it is hot.",
    ],
    escalation:
      `If the printer prints a test page from itself but not from any computer, or an error code stays on the display after a restart, ${HANDOFF}. Have the printer's make, model and the exact error to hand.`,
  },
  {
    id: "accounts.locked-out",
    area: "accounts",
    title: "Locked out, or a password needs resetting",
    symptoms: [
      "I am locked out",
      "my password does not work",
      "I need a password reset",
      "it says my account is locked",
      "new starter needs a login",
    ],
    steps: [
      "Check the obvious three first: Caps Lock, the keyboard language, and whether the password was recently changed on another device.",
      "Confirm which system is refusing you — the computer itself, Dentally, email, or this platform. They are separate accounts with separate passwords and the fix is different for each.",
      "For this platform, use the 'Forgotten password' link on the sign-in page: the reset email goes to you and you set the new password yourself. Nobody at the practice and nobody here ever sees it.",
      "For a computer or email account, the practice's IT contact does the reset. Ask them directly rather than asking a colleague to log you in on theirs — a shared login breaks the audit trail on everything you then do.",
      "For a new starter who needs access to this platform, the practice owner invites them from People & logins; they set their own password from the invitation.",
    ],
    escalation:
      `Password resets for the computers, the email accounts and Dentally are not something this desk can do, and never something to ask a colleague to work around: ${HANDOFF}. I will never ask you for a password and you should never be asked for one over the phone or by email.`,
  },
  {
    id: "dentally.cannot-access",
    area: "dentally",
    title: "Cannot get into Dentally",
    symptoms: [
      "Dentally will not load",
      "Dentally is down",
      "cannot log into Dentally",
      "the diary will not open",
      "Dentally is very slow",
    ],
    steps: [
      "Check whether other websites load on the same machine. If nothing loads, this is a connectivity problem — use the internet playbook instead.",
      "Try Dentally on a second machine. If it fails everywhere in the practice, it is either the line or Dentally itself, not your computer.",
      "Check Dentally's own status page or their support channel before doing anything else — if they have an incident open, there is nothing to fix at this end and the answer is to wait and work on paper.",
      "On a single affected machine: close the browser completely, reopen it, and go to Dentally fresh. If it still fails, try a private/incognito window, which rules out a stale session.",
      "If the login is refused rather than the page failing to load, that is an account problem, not an access problem — use the locked-out playbook.",
      "If the diary loads but is very slow, note the time of day and how many people are affected before reporting it; intermittent slowness needs that detail to be actionable.",
    ],
    escalation:
      `If Dentally is unreachable from more than one machine and other sites load fine, ${HANDOFF} and Dentally's own support. This platform reads from Dentally but cannot fix a Dentally outage, and nothing here changes anything in Dentally.`,
  },
  {
    id: "devices.ipad-kiosk",
    area: "devices",
    title: "The iPad or form kiosk is not working",
    symptoms: [
      "the iPad will not load the form",
      "the check-in tablet is stuck",
      "the kiosk screen is frozen",
      "patients cannot fill in the form",
      "the tablet will not stay on",
    ],
    steps: [
      "Check the battery and that the charging cable is actually delivering power — a kiosk stand cable that has worked loose looks identical to a dead tablet.",
      "Check it is on the practice Wi-Fi, not a guest network and not a neighbouring one it has drifted onto.",
      "If the screen is frozen, force the browser or app closed and reopen it. If that does nothing, hold the power and volume-down buttons to restart the device.",
      "Reopen the form link from the practice's own bookmark rather than typing it, so you know you are on the right link and not an expired one.",
      "If the form loads but will not submit, check the connection first, then try once more. Do not have the patient re-enter everything until you know the connection is good.",
      "If the tablet keeps sleeping mid-form, check the auto-lock setting is set long enough for somebody to complete the form without rushing.",
    ],
    escalation:
      `If the device will not hold a charge, will not stay on the network, or the form link is rejected on every device, ${HANDOFF}. If the link itself has expired, the practice can generate a fresh one from the form's own page in this platform.`,
  },
];

const STOP = new Set([
  "the", "a", "an", "of", "to", "and", "or", "is", "are", "in", "on", "for", "with", "it", "my",
  "we", "our", "i", "you", "not", "no", "can", "cannot", "will", "wont", "does", "do", "how", "what",
  "why", "when", "keeps", "keep", "at", "be", "been", "this", "that", "have", "has", "get", "got",
]);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2 && !STOP.has(t));
}

/** Below this a match is one incidental word, not a playbook. See rankPlaybooks. */
const MIN_SCORE = 3;

export interface RankedPlaybook {
  playbook: Playbook;
  score: number;
}

/**
 * Rank the playbooks against a member of staff's own words.
 *
 * The SAME shape as the practice brain's `rankNodes` (title weighted highest,
 * then the terms people search by, then the body), deliberately: a second ranking
 * philosophy in the same product is a second thing to tune and a second thing to
 * be wrong. Symptoms are weighted like tags because that is what they are — the
 * phrases a receptionist actually types, indexed so "nothing comes out of the
 * printer" finds the printer playbook without the word "printer" scoring twice.
 */
export function rankPlaybooks(query: string, limit = 3, pool: Playbook[] = PLAYBOOKS): RankedPlaybook[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  return pool
    .map((playbook) => {
      const title = playbook.title.toLowerCase();
      const symptoms = playbook.symptoms.join(" ").toLowerCase();
      const body = playbook.steps.join(" ").toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 5;
        if (symptoms.includes(term)) score += 4;
        if (playbook.area.includes(term)) score += 3;
        score += Math.min(body.split(term).length - 1, 2);
      }
      return { playbook, score };
    })
    // A FLOOR, not `> 0`. One incidental word in a body ("showing", "check") is
    // noise, and a ranker that returns a match for it hands the agent a playbook
    // to walk somebody through for a problem it does not cover — which is worse
    // than the honest empty result, because the honest one produces "I can help
    // with X, Y and Z; that is not one of them". The floor is set so a hit needs
    // the title, the symptoms, the area, or the same word twice in the steps.
    .filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.playbook.id.localeCompare(b.playbook.id))
    .slice(0, limit);
}

/** Every area, with its playbooks, for the Playbooks tab. */
export function playbooksByArea(): { area: PlaybookArea; playbooks: Playbook[] }[] {
  const areas = [...new Set(PLAYBOOKS.map((p) => p.area))];
  return areas.map((area) => ({ area, playbooks: PLAYBOOKS.filter((p) => p.area === area) }));
}
