// ===========================================================================
// REPLACEMENT SLOTS: available AND suited.
//
// When a patient cancels or asks to reschedule, the platform proposes times. A
// candidate is only valid when BOTH hold:
//   (a) that clinician genuinely has availability then, from Dentally's own
//       windows and not from any hours we invented; and
//   (b) that clinician is SUITED to the treatment.
//
// FILTER FIRST, THEN ORDER. The filter cannot be relaxed by a sort, and the
// criteria are NEVER widened automatically. Proposing a hygienist for an
// extraction because nothing else was free is the failure mode that matters
// here, so widening is a button a person presses and a widened result says it
// was widened.
//
// PURE and unit-tested.
// ===========================================================================

import type { FamilySlug } from "@/components/client/calendar/treatment-type";
import { capabilityFor, isSuitable, type Capability, type CapabilityAnswer } from "./suitability";
import { firstOverlap, mergeSpans, type Span } from "./working-spans";

export interface ProposalClinician {
  practitionerId: string;
  practitionerName: string;
  /** The site this clinician is at on this day, for the capability site override. */
  siteId: string | null;
  /** Availability windows only. NOT the working-spans union: a proposal must sit
   *  inside a genuine window, not inside time we inferred from a booking. */
  windows: readonly Span[];
  /** Spans that consume the clinician's time. cancelled and DNA do not occupy. */
  booked: readonly Span[];
  /** Breaks only. A note does not block a proposal. */
  breaks: readonly Span[];
}

export interface ProposalDay {
  dayKey: string;
  /** The drawn extent of that day. */
  bounds: Span;
  clinicians: readonly ProposalClinician[];
}

export interface ProposalInput {
  /** The treatment's clinical family. null = we could not classify it. */
  familySlug: FamilySlug | null;
  durationMin: number;
  /** The clinician the patient already had, who leads within a level. */
  previousPractitionerId: string | null;
  days: readonly ProposalDay[];
  caps: readonly Capability[];
  maxProposals?: number;
  maxPerClinicianDay?: number;
  stepMin?: number;
}

export interface Proposal {
  dayKey: string;
  startMin: number;
  endMin: number;
  practitionerId: string;
  practitionerName: string;
  level: "can" | "supervised";
}

export const MAX_PROPOSALS = 6;
export const MAX_PER_CLINICIAN_DAY = 2;
const STEP_MIN = 5;

/**
 * The ordered proposals.
 *
 * ORDER, in this exact precedence:
 *  1. every 'can' before every 'supervised';
 *  2. within a level, THE CLINICIAN THE PATIENT ALREADY HAD comes first, for
 *     continuity of care;
 *  3. earliest start;
 *  4. practitioner name localeCompare("en-GB"), purely so the output is
 *     deterministic and the tests can pin it.
 *
 * An unclassifiable treatment (familySlug null) returns [] rather than offering
 * everybody: we cannot check suitability for a treatment we cannot name, and
 * "unknown is not suitable" applies to the treatment as much as to the clinician.
 */
export function proposeSlots(input: ProposalInput): Proposal[] {
  const cap = input.maxProposals ?? MAX_PROPOSALS;
  const perDayCap = input.maxPerClinicianDay ?? MAX_PER_CLINICIAN_DAY;
  const perClinicianDay = new Map<string, number>();
  const out: Proposal[] = [];
  for (const p of allCandidates(input)) {
    if (out.length >= cap) break;
    const key = `${p.practitionerId}|${p.dayKey}`;
    const used = perClinicianDay.get(key) ?? 0;
    if (used >= perDayCap) continue;
    perClinicianDay.set(key, used + 1);
    out.push(p);
  }
  return out;
}

/** Every valid candidate, ordered, BEFORE the caps are applied. */
function allCandidates(input: ProposalInput): Proposal[] {
  if (input.familySlug === null) return [];
  const duration = Math.round(input.durationMin);
  if (!Number.isFinite(duration) || duration <= 0) return [];

  const step = input.stepMin ?? STEP_MIN;
  const family = input.familySlug;
  const candidates: Proposal[] = [];

  for (const day of input.days) {
    for (const c of day.clinicians) {
      const answer = capabilityFor(input.caps, c.practitionerId, c.siteId, family);
      if (!isSuitable(answer)) continue;

      const blocked = mergeSpans([...c.booked, ...c.breaks]);
      for (const window of mergeSpans(c.windows)) {
        const from = Math.max(window.startMin, day.bounds.startMin);
        const to = Math.min(window.endMin, day.bounds.endMin);
        // Start on the window's own edge, then step, so a session that opens at
        // 13:30 offers 13:30 rather than 13:35.
        for (let start = from; start + duration <= to; start += step) {
          const span: Span = { startMin: start, endMin: start + duration };
          if (firstOverlap(span, blocked)) continue;
          candidates.push({
            dayKey: day.dayKey,
            startMin: span.startMin,
            endMin: span.endMin,
            practitionerId: c.practitionerId,
            practitionerName: c.practitionerName,
            level: answer,
          });
        }
      }
    }
  }

  const previous = input.previousPractitionerId;
  candidates.sort((a, b) => {
    const levelRank = (p: Proposal): number => (p.level === "can" ? 0 : 1);
    if (levelRank(a) !== levelRank(b)) return levelRank(a) - levelRank(b);
    const prevRank = (p: Proposal): number => (previous !== null && p.practitionerId === previous ? 0 : 1);
    if (prevRank(a) !== prevRank(b)) return prevRank(a) - prevRank(b);
    if (a.dayKey !== b.dayKey) return a.dayKey < b.dayKey ? -1 : 1;
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return a.practitionerName.localeCompare(b.practitionerName, "en-GB");
  });

  return candidates;
}

export interface ProposalBreakdown {
  /** Clinicians in the period who can (or can, supervised) do this treatment. */
  capable: number;
  /** Of those, how many had no free time in the period. */
  capableWithNoFreeTime: number;
  /** Clinicians present in the period who cannot do it. */
  cannot: number;
  /** Clinicians we have no capability record for at all. */
  unknown: number;
}

/**
 * Why the list is short or empty.
 *
 * ALWAYS rendered alongside the result, because a blank list with no explanation
 * is a confident empty: the reader cannot tell "nobody can do this" from "nobody
 * is free" from "we never recorded who can do this", and those call for three
 * different actions.
 */
export function proposalBreakdown(input: ProposalInput): ProposalBreakdown {
  const answers = new Map<string, CapabilityAnswer>();
  for (const day of input.days) {
    for (const c of day.clinicians) {
      const answer =
        input.familySlug === null
          ? ("unknown" as CapabilityAnswer)
          : capabilityFor(input.caps, c.practitionerId, c.siteId, input.familySlug);
      // A clinician seen at several sites keeps their most permissive answer, so
      // "can at site-cc" is not reported as "cannot" because of another day.
      const current = answers.get(c.practitionerId);
      if (current === undefined || (!isSuitable(current) && isSuitable(answer))) {
        answers.set(c.practitionerId, answer);
      }
    }
  }

  // Computed from the UNCAPPED candidate set, not from the six that were shown.
  // Counting off the capped list would report a clinician with plenty of free
  // time as having none simply because the list filled up first, which is exactly
  // the kind of confidently wrong figure this breakdown exists to prevent.
  const offered = new Set(allCandidates(input).map((p) => p.practitionerId));
  let capable = 0;
  let capableWithNoFreeTime = 0;
  let cannot = 0;
  let unknown = 0;
  for (const [practitionerId, answer] of answers) {
    if (isSuitable(answer)) {
      capable += 1;
      if (!offered.has(practitionerId)) capableWithNoFreeTime += 1;
    } else if (answer === "cannot") {
      cannot += 1;
    } else {
      unknown += 1;
    }
  }
  return { capable, capableWithNoFreeTime, cannot, unknown };
}
