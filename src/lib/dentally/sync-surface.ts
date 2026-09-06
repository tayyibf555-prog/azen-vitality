// PURE, and it imports only the pure leaf. Nothing here reaches a database, an
// environment variable or the network, so the browser component that renders
// these words reads the same module the server composed them from.
import {
  BLOCKED_REASON_COPY,
  DENTALLY_WRITE_SOURCES,
  type DentallyWriteKind,
  type DentallyWriteMode,
  type DentallyWriteSource,
} from "./write-vocabulary";

// ===========================================================================
// WHAT FLOWS BACK TO DENTALLY, AND WHAT DOES NOT — in plain English.
//
// This module is PURE. It composes no data and reads no environment of its own;
// it is handed the write mode and returns the three groups the Sync Status page
// renders. Pure because these sentences are the ones a practice will act on:
// "our notes are in Dentally" is a belief somebody could be sacked over, and a
// belief like that should be pinned by a test, not by a paragraph in a view.
//
// THE THREE GROUPS.
//
//   MIRRORED             the write kinds that really do reach the practice's
//                        Dentally book right now.
//   PENDING ON THE KEY   the same kinds, while the write path is off. They are
//                        built, calibrated and recorded as intents. The name is
//                        historical: this group is reached by EITHER switch
//                        being off, so nothing that renders it may assert which
//                        one is in the way without being told (see
//                        SYNC_GROUP_TITLES and syncGroupTitle at the foot).
//   BLOCKED BY GOVERNANCE things this platform holds that will NOT flow back,
//                        because Dentally publishes no supported way to write
//                        them. These do not move when the key arrives. They are
//                        the group the practice most needs to have been told
//                        about BEFORE it starts relying on the platform.
//
// The first two are the SAME five kinds; which group they land in is decided by
// the write mode and by nothing else. That is deliberate: there is no third
// state in which some of the five flow and others do not, and a surface that
// implied there was would be inventing a fact.
// ===========================================================================

export type SyncGroup = "mirrored" | "pending_on_key" | "blocked_by_governance";

export interface SyncFact {
  /** Stable id, for React keys and for tests to name a row. */
  id: string;
  /** What this is, as an owner would say it. */
  label: string;
  /** The plain-English statement. Never hedged, never jargon. */
  detail: string;
  group: SyncGroup;
  /** Which surfaces of the platform produce this, where it is a write kind. */
  sources?: string[];
}

/**
 * THE FIVE SUPPORTED WRITES, and which of the platform's surfaces make each one.
 * `sources` is DERIVED from DENTALLY_WRITE_SOURCES rather than restated, so a
 * new write source appears on this page the moment it exists — a surface that
 * writes to a patient's record and is not on the page the practice reads to
 * find out what writes to their records is exactly the gap this lane closes.
 */
const SUPPORTED_WRITES: Array<{ kind: DentallyWriteKind; label: string; detail: string }> = [
  {
    kind: "appointment.create",
    label: "New appointments",
    detail:
      "An appointment booked in this platform is created in the Dentally diary, with the clinician, the times and the reason the platform booked it.",
  },
  {
    kind: "appointment.update",
    label: "Appointment changes",
    detail:
      "Moving, resizing or reassigning an appointment updates the same appointment in Dentally, and the result is read back from Dentally before anybody is told it saved.",
  },
  {
    kind: "appointment.cancel",
    label: "Cancellations",
    detail:
      "Cancelling here cancels the appointment in Dentally. The freed slot is only offered to a waitlist patient once Dentally has actually released it.",
  },
  {
    kind: "patient.create",
    label: "New patient records",
    detail:
      "A patient who registers through the booking page, the onboarding form or the assistant is created in Dentally with the details Dentally requires.",
  },
  {
    kind: "patient.update",
    label: "Patient detail edits",
    detail:
      "Correcting a patient's details here updates the same fields in Dentally, and switching a record active or inactive sets Dentally's own active flag.",
  },
];

/**
 * WHAT WILL NEVER FLOW BACK ON THE CONNECTION WE HAVE — one entry per thing a
 * practice would reasonably assume does.
 *
 * Each `detail` states the EVIDENCE, not an opinion, because every one of these
 * is a claim about somebody else's API and the practice is entitled to know how
 * firmly we know it. The evidence is the same evidence recorded in
 * src/lib/dentally/client.ts at the read method for each resource; if one of
 * those comments changes, this list is wrong and must change with it.
 */
const GOVERNANCE_BLOCKS: Array<{ id: string; label: string; detail: string }> = [
  {
    id: "notes",
    label: "Clinical and practice notes",
    detail:
      "Notes written in this platform stay in this platform. Dentally documents no way to create a note through its API; the only route that answers at all is undocumented and was seen once on a single read-only check that has never been repeated, which is not enough to write a clinical record on.",
  },
  {
    id: "sms",
    label: "Text messages sent to patients",
    detail:
      "Messages this platform sends are recorded here, on the patient's Correspondence tab, and are not copied into Dentally's own message log. Dentally sends its texts through its own provider, so posting to that log would most likely send the patient a second, duplicate text rather than file a record of the first — so the platform never posts to it at all.",
  },
  {
    id: "emails",
    label: "Emails sent to patients",
    detail:
      "The same as text messages, and for the same reason: Dentally sends email on the practice's behalf, so writing to its email endpoint would send a message rather than record one. The platform only ever reads it.",
  },
  {
    id: "charting",
    label: "Charting and treatment plans",
    detail:
      "The tooth chart, the perio chart and the treatment plan panel are a read-only mirror of what is in Dentally. Dentally publishes no way to create or change any of them through its API, and building a route around that is not permitted by Dentally's terms.",
  },
  {
    id: "medical-history",
    label: "Medical histories and consent forms",
    detail:
      "Medical histories, NHS declarations and consent captured here are held here. Dentally's medical-history resource holds no records for this practice, and there is no consent or FP17 endpoint to write to at all.",
  },
  {
    id: "documents",
    label: "Signed documents",
    detail:
      "Documents already signed in Dentally can be opened from the patient record, and nothing is written back to them. These are signed clinical records and a write path against them is not something this platform should have.",
  },
];

/** Which platform surfaces make a given write kind. Derived, never restated. */
export function sourcesForKind(kind: DentallyWriteKind): string[] {
  return (Object.keys(DENTALLY_WRITE_SOURCES) as DentallyWriteSource[])
    .filter((s) => (DENTALLY_WRITE_SOURCES[s].kinds as readonly string[]).includes(kind))
    .map((s) => DENTALLY_WRITE_SOURCES[s].label)
    .sort();
}

/**
 * The three groups, for one deployment's write mode.
 *
 * When writes are OFF every supported kind is "pending on the key" and the
 * mirrored group is EMPTY — and the page says so in as many words rather than
 * rendering an empty heading. Nothing is ever in both.
 */
export function syncFacts(mode: DentallyWriteMode, masterOff = false): SyncFact[] {
  // TWO SWITCHES, ONE ANSWER. Writing back needs the connection in place (the
  // agency's DENTALLY_WRITE_*, aimed at the practice's own book) AND the
  // practice's own master switch on. Either one off means nothing flows, so the
  // facts are grouped on the CONJUNCTION — and the sentence names whichever one
  // is in the way, because "waiting on a key the agency has to issue" and
  // "waiting on a switch you can flip yourself" are two very different things to
  // be told.
  //
  // AND SO IS "BOTH", which is the state this deployment is actually in. See the
  // note above `syncHeadline` for why the third sentence exists and why it may
  // not be collapsed back into the master-switch one.
  const flowing = mode === "live" && !masterOff;
  const writeGroup: SyncGroup = flowing ? "mirrored" : "pending_on_key";
  const waiting = masterOff
    ? mode === "live"
      ? "This is built and ready. It is waiting on ONE thing you control: switch Dentally write-back on in System controls. Until then every one of these is recorded below and nothing is sent."
      : "This is built and ready. Two things have to be in place before it flows, and neither is yet: your Dentally write-back switch in System controls, and the connection to your Dentally book that your agency sets up. Every one of these is recorded below and nothing is sent."
    : "This is built and ready; it is waiting on the practice's Dentally write key, and until that arrives every one of these is recorded below as an intent instead of being sent.";
  const supported: SyncFact[] = SUPPORTED_WRITES.map((w) => ({
    id: w.kind,
    label: w.label,
    detail: flowing ? w.detail : `${w.detail} ${waiting}`,
    group: writeGroup,
    sources: sourcesForKind(w.kind),
  }));
  const blocked: SyncFact[] = GOVERNANCE_BLOCKS.map((b) => ({
    id: b.id,
    label: b.label,
    detail: `${b.detail} ${BLOCKED_REASON_COPY.no_supported_endpoint}`,
    group: "blocked_by_governance" as const,
  }));
  return [...supported, ...blocked];
}

/**
 * The headline sentence, given both switches.
 *
 * `mode` here answers "does a write from this platform reach the practice's real
 * Dentally book" — `assembleSyncStatus` passes the CONJUNCTION of the arming and
 * the target, not the raw `DENTALLY_WRITE_*` state — so "live" means connected
 * and anything else means not.
 *
 * FOUR STATES, NOT THREE, AND THE FOURTH IS THE ONE THIS DEPLOYMENT IS IN.
 *
 * "we cannot yet" and "you have chosen not to" are different facts and only one
 * of them is something the reader can change, so the owner's own switch is named
 * FIRST when it is the thing in the way — nobody should wait on their agency for
 * a control sitting on the next tab. That was three states, and it was written
 * on the assumption that a master switch reading OFF meant an owner had turned
 * it off.
 *
 * It does not. Migration 0096 (APPLIED, 3 September 2026) seeds
 * `('vitality','dentally-write-back',false,'migration:0096')`, so on every
 * database the migrations have run against the master switch reads OFF from the
 * moment the platform is installed, with the write connection ALSO absent. In
 * that state the three-state sentence told an owner "because you have switched
 * it off … turn it back on whenever you are ready" — a thing they never did,
 * followed by an instruction that would achieve nothing (the connection is the
 * agency's half) while arming their half of a two-key lock over 51,000 real
 * patient records ahead of anybody deciding to.
 *
 * So when BOTH are in the way the sentence says both, names neither party as the
 * one who chose it, and says plainly that flipping the switch is not on its own
 * enough. The armed-and-only-the-switch-is-off state keeps the sentence it had:
 * there the instruction is true and immediately actionable.
 */
export function syncHeadline(mode: DentallyWriteMode, masterOff = false): string {
  if (masterOff) {
    return mode === "live"
      ? "Writing back to Dentally is OFF, because you have switched it off. Everything in this platform keeps working; nothing reaches your Dentally book, and every appointment and patient change is recorded below so you can see exactly what was held back. Turn Dentally write-back back on in System controls whenever you are ready."
      : "Writing back to Dentally is OFF, and two separate things are holding it back: your Dentally write-back switch in System controls is off, and the connection to your Dentally book is not in place yet. Everything in this platform keeps working, and every appointment and patient change is recorded below so you can see exactly what was held back. Switching write-back on will not start sending them on its own — the connection is your agency's half.";
  }
  return mode === "live"
    ? "Writing back to Dentally is ON. Appointments and patient records made or changed here are written to your Dentally book."
    : "Writing back to Dentally is OFF. Nothing this platform does reaches your Dentally book yet: every appointment and patient change is recorded below as an intent, so you can see exactly what would have been written.";
}

/**
 * THE HEADINGS — AND WHY THE MIDDLE ONE IS NOT ALLOWED TO NAME A CAUSE.
 *
 * `pending_on_key` is reached by BOTH ways of not flowing (see `syncFacts`: the
 * grouping is the conjunction of the two switches), so a heading that names the
 * write key is a heading that is WRONG in half the states it renders in — and
 * wrong in the specific direction that costs the practice time. On the day the
 * agency arms the key with the owner's own master switch still off, this page
 * says "you have switched it off" in the headline, "Armed for writing" beside
 * the connection, and "waiting on ONE thing you control" under every bullet: a
 * heading between them reading "waiting on your Dentally write key" points the
 * owner at the one party who has already done their part.
 *
 * So this record holds the CAUSE-NEUTRAL wording — true in either state — and is
 * the safe answer for any caller that does not know which switch is in the way.
 * A caller that DOES know (the page, the co-pilot tool; both hold `master.off`)
 * should call `syncGroupTitle`/`syncGroupTitles` and get the sentence that names
 * the switch the reader can actually act on. Neutral is the fallback because a
 * vaguer true heading costs a reader a glance; a precise false one costs them a
 * week of waiting on somebody else.
 */
export const SYNC_GROUP_TITLES: Record<SyncGroup, string> = {
  mirrored: "Flowing into Dentally",
  pending_on_key: "Built and ready, not flowing yet",
  blocked_by_governance: "Stays in this platform (Dentally has no way to accept it)",
};

/**
 * The heading for one group, given the owner's master switch.
 *
 * The precedence is the SAME as the headline's and the same as the bullets':
 * when the owner's own switch is off it is named first, whatever the key is
 * doing, because it is the nearer of the two and the only one they can flip
 * themselves. Every other group's heading is a fact about Dentally rather than
 * about a switch, so it does not move.
 *
 * IT STATES THE SWITCH, IT DOES NOT PROMISE THE SWITCH IS ENOUGH. This function
 * is handed one boolean and cannot tell the master-switch-only state from the
 * both-are-off state the seeded 0096 row puts every deployment in (see
 * `syncHeadline`), and it is rendered by a browser component that holds nothing
 * else. "Waiting on your switch" would therefore be a heading that promises,
 * above bullets that deny it, that one flip starts the writes. Naming the switch
 * as a FACT is true in both states, still points the reader at the control they
 * own, and leaves the "what would it take" answer to the headline and the
 * bullets, which know.
 */
export function syncGroupTitle(group: SyncGroup, masterOff = false): string {
  if (group !== "pending_on_key") return SYNC_GROUP_TITLES[group];
  return masterOff
    ? "Ready — your write-back switch in System controls is off"
    : "Ready, waiting on your Dentally write key";
}

/** All three headings for one deployment, for callers that render every group. */
export function syncGroupTitles(masterOff = false): Record<SyncGroup, string> {
  return {
    mirrored: syncGroupTitle("mirrored", masterOff),
    pending_on_key: syncGroupTitle("pending_on_key", masterOff),
    blocked_by_governance: syncGroupTitle("blocked_by_governance", masterOff),
  };
}

export const SYNC_GROUP_ORDER: SyncGroup[] = ["mirrored", "pending_on_key", "blocked_by_governance"];
