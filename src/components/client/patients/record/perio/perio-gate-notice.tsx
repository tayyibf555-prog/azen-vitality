import type { ReactNode } from "react";

// ===========================================================================
// THE GATE NOTICE — the whole risk of this module, rendered.
//
// Perio is the one part of this platform that mirrors nothing. Dentally's API
// exposes no periodontal resource at all (PERIO.md §1), so every value on the
// screen below is AUTHORED here, and this platform becomes the system of record
// for it the moment PERIO_ENABLED is set — while Dentally's own Perio tab still
// exists and still works. Two live clinical records for the same patient is the
// worst outcome available, and this component is the only thing on the tab whose
// entire job is to say which world the reader is in.
//
// IT SAYS DIFFERENT THINGS IN THE TWO STATES, and neither is a softened version
// of the other:
//
//   OFF (the shipping default). The screen is a preview. Nothing below is a
//   statement about this patient, the empty boxes are the shape of the feature
//   rather than six normal findings, and this patient's real periodontal record
//   is in Dentally. Nothing on the tab can be authored.
//
//   ON. The thing that costs money. BPE has been a mandatory FP17 field since
//   1 October 2022, so a score recorded here while claims go out of Dentally is
//   entered twice — and a mandatory claim field entered twice is where a claim
//   is rejected or two records quietly disagree. Alongside it, the fact that
//   makes a clinician look in the wrong place: findings may now exist in BOTH
//   systems and neither is read by the other.
//
// EVERY SENTENCE COMES FROM PERIO_COPY IN src/lib/perio/gate.ts. Not one word of
// clinical-safety copy is written in this file. That module is `import
// "server-only"` — the flag must never cross the wire — so the sentences arrive
// as props, resolved by the server component that reads the gate. The same
// arrangement the two builders arrived at independently, for the same reason.
//
// WHAT THIS DELIBERATELY DOES NOT SAY. PERIO_COPY.disabled and
// PERIO_COPY.doubleEntry are rendered by BpeGrid, directly above the scores,
// which is where the person recording one looks. Repeating either here would put
// the same sentence on the screen twice within one scroll, and a warning printed
// twice is a warning being trained past. This notice carries the statements that
// are about the TAB rather than about the grid.
//
// NO "use client", no function props, no state: a server component renders this
// directly. That is not an accident of style — a shared component taking function
// props that gains a client directive builds green and throws at render, which
// this repo has already shipped once.
// ===========================================================================

export interface PerioGateCopy {
  /** PERIO_COPY.preview — what the screen is while the gate is shut. */
  preview: string;
  /** PERIO_COPY.bothRecords — findings may exist here AND in Dentally. */
  bothRecords: string;
}

export function PerioGateNotice({
  enabled,
  copy,
}: {
  /** isPerioEnabled(), resolved on the server. */
  enabled: boolean;
  copy: PerioGateCopy;
}) {
  if (!enabled) {
    // NEUTRAL, NOT AMBER, and the choice is deliberate: this is the permanent,
    // correct, chosen state of the feature, not an incident. Amber on a standing
    // condition is how a practice learns to read past amber — the same argument
    // unavailable-panel.tsx makes for the Medical tab, in the same visual register,
    // so every "we are not showing you this" on the record looks alike.
    return (
      <section
        className="space-y-2 rounded-xl border border-line bg-card-muted/40 px-5 py-4"
        aria-label="Periodontal charting is switched off"
      >
        {/* NOT "periodontal charting is switched off here" — BpeGrid's own banner,
            immediately below, is headed almost exactly that. Two stacked blocks
            with the same title read as the page repeating itself and a reader
            skips the second, which is the one naming Dentally. This heading says
            what the block IS; that one says why. */}
        <Heading>This is a preview of the periodontal screen</Heading>
        <p className="text-[13.5px] font-medium leading-[1.5] text-ink">{copy.preview}</p>
        <p className="text-[12.5px] leading-[1.5] text-muted">
          Switching it on makes this platform a second place a periodontal finding can live, so it is a
          practice decision taken in writing rather than a consequence of the code being finished.
        </p>
      </section>
    );
  }

  // ENABLED. The one fact a clinician needs before reading a single number: where
  // the data now lives, and that neither system reads the other. The FP17 cost is
  // stated by the grid itself, immediately below.
  //
  // A SECOND PARAGRAPH USED TO SIT HERE saying a BPE could not be typed on this
  // screen. It can now — bpe-entry.tsx records one — so the sentence and the test
  // pinning it are gone. A screen that keeps apologising for a gap it has closed
  // teaches its readers to skip its warnings, which is the failure this whole
  // component exists to avoid.
  return (
    <section
      className="space-y-2 rounded-xl border border-tint-amber-line bg-tint-amber px-5 py-4"
      aria-label="Periodontal records are kept in two places"
    >
      <Heading>Periodontal findings can now exist in two places</Heading>
      <p className="text-[13.5px] font-medium leading-[1.5] text-ink">{copy.bothRecords}</p>
    </section>
  );
}

/** One heading treatment for both states, so switching the flag changes the words
 *  and the colour and not the shape of the block. */
function Heading({ children }: { children: ReactNode }) {
  return <h3 className="text-[14px] font-semibold tracking-[-0.1px] text-navy">{children}</h3>;
}
