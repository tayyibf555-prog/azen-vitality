// ===========================================================================
// IS THIS CLINICIAN ACTUALLY AT THIS PRACTICE TODAY?
//
// THE PROBLEM, and it is a patient-safety one.
//
// GET /v1/appointments/availability takes NO site parameter and its rows carry
// no site either. The only thing scoping an availability read to a practice is
// the practitioner id set we send, which comes from that site's own
// /v1/practitioners list. That is sound for a clinician who works at one site.
// It is FALSE for a clinician who appears on more than one site's list, which is
// exactly the rota case this practice has: one person moving between practices
// through the week.
//
// The failure it produces: on a day when Femi is at N15, N17's diary asks for
// availability for its own practitioner list, which still includes him, and
// Dentally answers with his N15 session. N17 then paints that session WHITE,
// meaning "here and free", and it is precisely his N15 free time, so N17
// reception is shown another practice's gaps as its own capacity. The move
// guard, which reads the same availability, then accepts a drop into it. A
// patient is booked with a clinician who is not in the building.
//
// THE RULE, and why it is this one.
//
// Nothing in the availability response can be filtered after the fact, and there
// is no per-day rota endpoint on the Dentally client. So the windows of a
// clinician who could be at another practice are only trusted when something
// SITE-SCOPED corroborates their presence: at least one appointment at THIS
// site, on THIS day, in a state that consumes their time. Appointments are read
// per site, so they are the one honest positive signal available.
//
//   single-site clinician                  -> trusted. Nothing to confuse.
//   multi-site clinician, booked here      -> trusted. They are demonstrably in.
//   multi-site clinician, nothing here     -> NOT trusted. The column says so in
//                                             words and refuses moves; it never
//                                             paints white and never claims "off".
//
// A failed read of the other sites' lists means we cannot tell WHO is multi-site,
// so corroboration is demanded of everybody rather than assumed for anybody. The
// busy columns keep working and the empty ones say they cannot be confirmed.
//
// THE LIMIT, stated rather than hidden: a clinician who genuinely splits ONE day
// between two practices is corroborated at both, and their combined windows would
// be shown at both. Resolving that needs a per-day rota source, which no API here
// exposes. It is a narrower hole than the one this closes, and it is not papered
// over anywhere: this comment is the record.
// ===========================================================================

import { getSites } from "@/lib/mock/clients";
import { listSitePractitionersSafe, type ThroughClient } from "@/lib/dentally/read";

export interface PresenceInput {
  /** True when this id also appears on another of the client's site lists. */
  sharedWithAnotherSite: boolean;
  /** True when the other sites' lists could not be read, so sharing is unknown. */
  rosterUnknown: boolean;
  /**
   * True when this clinician has at least one appointment AT THIS SITE on this
   * day whose state consumes their time. Cancelled and did-not-attend rows do
   * NOT corroborate presence: an appointment that did not happen is not evidence
   * that anybody was in the building.
   */
  bookedHere: boolean;
}

/** May this clinician's availability windows be read as "at this practice"? */
export function availabilityTrustedHere(input: PresenceInput): boolean {
  if (input.rosterUnknown) return input.bookedHere;
  if (!input.sharedWithAnotherSite) return true;
  return input.bookedHere;
}

export interface SharedPractitioners {
  /** Ids that appear on at least one OTHER site belonging to the same client. */
  shared: Set<string>;
  /** True when at least one other site's list could not be read. */
  rosterUnknown: boolean;
}

/**
 * Which of this client's practitioners also sit on another of its sites' lists.
 *
 * Bounded by the client's site count (three here) and answered from the same 60
 * second practitioner cache the diary already uses, so it costs nothing on a
 * page that has already drawn its columns.
 */
export async function readSharedPractitionerIds(
  clientId: string,
  siteId: string,
  opts: ThroughClient = {},
): Promise<SharedPractitioners> {
  const others = getSites(clientId).filter((s) => s.id !== siteId);
  if (others.length === 0) return { shared: new Set(), rosterUnknown: false };

  const reads = await Promise.all(others.map((s) => listSitePractitionersSafe(s.id, opts)));
  const shared = new Set<string>();
  let rosterUnknown = false;
  for (const read of reads) {
    if (read.failed) {
      rosterUnknown = true;
      continue;
    }
    for (const p of read.practitioners) shared.add(p.id);
  }
  return { shared, rosterUnknown };
}
