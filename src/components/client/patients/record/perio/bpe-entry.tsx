"use client";

import { useCallback, useReducer, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  BPE_CODE_MEANING,
  MIN_TEETH_PER_SEXTANT,
  SEXTANTS,
  SEXTANT_LABEL,
  SEXTANT_TEETH,
  serialiseBpeScore,
} from "@/lib/perio/bpe";
import {
  bpeEntryReducer,
  canScore,
  entryRequirement,
  initBpeEntry,
  saveRefusal,
  skipReason,
  toSavePayload,
  travelOrder,
} from "@/lib/perio/bpe-entry-state";
import type { BpeEntryState } from "@/lib/perio/bpe-entry-state";
import type { ClinicianRef, PerioProbe, SextantId } from "@/lib/perio/types";
import { BAND_CLASS, PROBE_LABEL, UNSCORED_CLASS, bpeBand } from "./bpe-legend";

// ===========================================================================
// RECORDING A BPE — six numbers, typed at every examination.
//
// THIS IS THE MOST-USED CONTROL IN THE MODULE. A six-point chart is 192 numbers
// and is taken when a screening demands one; a BPE is six numbers and is taken
// every time. It is also a MANDATORY FP17 CLAIM FIELD (since 1 October 2022), so
// it is the one periodontal reading that has to exist whether or not anybody is
// thinking about periodontal disease that morning.
//
// -- THIS FILE HOLDS NO RULE AND NO STATE MACHINE -------------------------
//
// Everything that decides anything is in src/lib/perio/bpe-entry-state.ts, which
// vitest can reach — this repo's runner collects src/**/*.test.ts in a node
// environment and cannot test a .tsx at all. The travel order, the skip rule, the
// `*` toggle, the refusal of a 5 and the refusal of a score aimed at a sextant
// that cannot hold one are all tested there. This component turns KeyboardEvents
// into that machine's actions, paints the result, and posts it.
//
// The charting consequence is likewise the ENGINE'S. entryRequirement() calls
// chartingRequirement(), so "a 3 charts that sextant after initial therapy, a 4
// charts the whole mouth from the outset" is stated once in tested code and
// merely displayed here. There is no second copy of that rule in this JSX, and
// the sentence printed is the engine's own `reason`.
//
// -- THE COLOURS ARE THE READ-ONLY GRID'S ---------------------------------
//
// BAND_CLASS, UNSCORED_CLASS and bpeBand come from bpe-legend.tsx, which owns the
// band vocabulary for this whole tab. A second colour table here is exactly how
// an entry grid comes to paint a 4 differently from the grid printing the same 4
// eight lines above it. Every class string is written out LITERALLY, because
// Tailwind v4 scans raw source: a class name assembled at runtime from a tone
// variable is never generated, and the utility paints a clinical severity
// transparent. (The literal form of that mistake is not even written in this
// comment — the token test in perio-shell.test.ts scans this file for colour
// utilities and would demand a variable for the half-name.)
//
// -- WITH THE GATE SHUT THERE IS NOTHING TO TYPE INTO ----------------------
//
// The panel still renders, because the shape of the feature is what the preview
// is for, and a screen that hides its own entry grid teaches nobody what turning
// the flag on would mean. But read-only here is a FACT, not an attribute: with
// `canSave` false this component emits no input, no button, no select, no
// textarea and nothing focusable. "Disabled" is a claim a bug can undo; a screen
// with no control on it cannot be typed into by any means.
//
// -- ATTRIBUTION, AND WHAT A FAILED SAVE MUST NOT COST --------------------
//
// GDC Standard 4.1.4 puts the treating clinician on the record, so with no
// signed-in clinician this offers no save and says why in PERIO_COPY.noAuthor's
// own words — the sentence the API refuses with, so the screen and the refusal
// agree. And a save that fails keeps every number: six scores a clinician has
// just called out with their hands in someone's mouth are not re-callable, and
// losing them is worse than never having offered to save.
//
// -- CLIENT BOUNDARY -------------------------------------------------------
//
// "use client", so EVERY PROP IS PLAIN DATA — no functions, no children. A server
// component (BpeGrid, rendered by PerioShell) renders this directly. It also
// cannot import src/lib/perio/gate.ts, which is `import "server-only"`, which is
// why the gate's answer arrives as `canSave` and its sentences arrive as strings.
// ===========================================================================

/** The gate's sentences. All three are PERIO_COPY's, none is written here. */
export interface BpeEntryCopy {
  /** PERIO_COPY.noAuthor — why a write is refused with no named clinician. */
  noAuthor: string;
  /** PERIO_COPY.bpeEntryReadOnly — why nothing here can be typed. */
  readOnly: string;
  /** PERIO_COPY.saveFailed — never phrased as if it might have half-succeeded. */
  saveFailed: string;
}

export interface BpeEntryProps {
  /** Scope. Every write carries all three. */
  client: string;
  siteId: string;
  patientId: string;
  /** canSavePerio(), resolved on the server. False renders the panel read-only. */
  canSave: boolean;
  /** GDC 4.1.4. Null refuses authorship rather than inventing an author. */
  clinician: ClinicianRef | null;
  /** FDI numbers of the teeth present. Omit when the platform does not know —
   *  the machine then opens every sextant scorable rather than inventing a mouth,
   *  and lets the clinician say which cannot be scored. */
  presentTeeth?: readonly number[];
  implantTeeth?: readonly number[];
  probe?: PerioProbe;
  copy: BpeEntryCopy;
  className?: string;
}

/** The digits that are BPE codes, and the ones that are not. Both are handed to
 *  the machine: it refuses the second set in its own words, so there is no
 *  validity rule in this adapter. */
const DIGITS = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

export function BpeEntry({
  client,
  siteId,
  patientId,
  canSave,
  clinician,
  presentTeeth,
  implantTeeth,
  probe,
  copy,
  className,
}: BpeEntryProps) {
  const [state, dispatch] = useReducer(
    bpeEntryReducer,
    { presentTeeth, implantTeeth, probe },
    initBpeEntry,
  );

  const [saving, setSaving] = useState(false);
  const [saveIssues, setSaveIssues] = useState<string[]>([]);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);

  const requirement = entryRequirement(state);
  const refusal = saveRefusal(state);
  const order = travelOrder(state);

  // ---- the keyboard adapter ---------------------------------------------
  //
  // It maps keys onto the machine's actions and holds nothing else. Every branch
  // has a non-keyboard equivalent, which is the point: a transcription stream of
  // an assistant reading numbers aloud dispatches "code" and "furcation" without
  // going near this function (PERIO.md §4).
  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const key = event.key;
    if (DIGITS.has(key)) {
      event.preventDefault();
      dispatch({ type: "code", code: Number(key) });
      return;
    }
    switch (key) {
      case "*":
      case "f":
      case "F":
        event.preventDefault();
        dispatch({ type: "furcation" });
        return;
      case "Tab":
        event.preventDefault();
        dispatch({ type: "move", by: event.shiftKey ? -1 : 1 });
        return;
      case " ":
      case "Enter":
      case "ArrowRight":
        event.preventDefault();
        dispatch({ type: "move", by: 1 });
        return;
      case "ArrowLeft":
        event.preventDefault();
        dispatch({ type: "move", by: -1 });
        return;
      // Three places is one arch, so with a whole mouth this is the sextant
      // directly above or below. Where a sextant is skipped the travel order is
      // shorter and the machine clamps — it never lands somewhere unscorable.
      case "ArrowDown":
        event.preventDefault();
        dispatch({ type: "move", by: 3 });
        return;
      case "ArrowUp":
        event.preventDefault();
        dispatch({ type: "move", by: -3 });
        return;
      case "Home":
        event.preventDefault();
        dispatch({ type: "move", by: -SEXTANTS.length });
        return;
      case "End":
        event.preventDefault();
        dispatch({ type: "move", by: SEXTANTS.length });
        return;
      case "Backspace":
      case "Delete":
        event.preventDefault();
        dispatch({ type: "clear" });
        return;
      case "Escape":
        // Never trap the keyboard in a grid. Escape hands focus back.
        event.currentTarget.blur();
        return;
      default:
        break;
    }
  }, []);

  // ---- saving -------------------------------------------------------------

  const save = useCallback(async () => {
    setSaveIssues([]);
    setSaveNotice(null);
    // GDC 4.1.4, in the gate's own words — the same sentence the route refuses
    // with, so the screen and a 503 never say different things.
    if (!clinician) {
      setSaveIssues([copy.noAuthor]);
      return;
    }
    const blocked = saveRefusal(state);
    if (blocked) {
      setSaveIssues([blocked]);
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/perio/bpe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client, siteId, patientId, ...toSavePayload(state) }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        error?: string;
        issues?: string[];
        notice?: string;
        exam?: { version?: number };
      };
      if (!response.ok || !body.ok) {
        // NOTHING TYPED IS TOUCHED. Six numbers just called out are not
        // re-callable, so a failed save keeps every one of them on screen.
        setSaveIssues(body.issues ?? [body.error ?? copy.saveFailed]);
        return;
      }
      // The FP17 double-entry sentence comes back on every successful write.
      // Shown from the response rather than remembered, so it cannot be switched
      // off by forgetting to pass a prop.
      setSaveNotice(body.notice ?? null);
      setSavedVersion(typeof body.exam?.version === "number" ? body.exam.version : null);
      dispatch({ type: "saved" });
    } catch {
      setSaveIssues([copy.saveFailed]);
    } finally {
      setSaving(false);
    }
  }, [clinician, copy.noAuthor, copy.saveFailed, state, client, siteId, patientId]);

  const canPressSave = canSave && Boolean(clinician) && !saving && refusal === null && state.dirty;

  return (
    <section
      className={`space-y-2.5 rounded-xl border border-line bg-card p-3 ${className ?? ""}`}
      aria-label="Record a Basic Periodontal Examination"
    >
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1.5">
        <div className="space-y-0.5">
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-navy">
            Record a BPE
          </h3>
          {/* WHO THIS WOULD BE ATTRIBUTED TO, before a number is typed — GDC
              4.1.4. There is deliberately NO "no clinician" line here: with none,
              PERIO_COPY.noAuthor is printed below in full, and a short version of
              the same statement directly above it would be this panel saying one
              thing twice in two inches. */}
          {clinician ? (
            <p className="text-[11.5px] leading-tight text-muted">
              Recording as <span className="font-medium text-navy">{clinician.name}</span>
              {clinician.gdcNumber ? ` · GDC ${clinician.gdcNumber}` : ""}
            </p>
          ) : null}
        </div>

        {/* THE PROBE. Data about the reading, not decoration: the 3.5–5.5mm band
            that separates a code 3 from a code 4 is a property of the probe. */}
        {canSave ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
              Probe
              <select
                className="rounded border border-line bg-card px-1.5 py-1 text-[11.5px] text-navy"
                value={state.probe}
                onChange={(event) =>
                  dispatch({ type: "probe", probe: event.target.value as PerioProbe })
                }
              >
                <option value="who-621">WHO 621</option>
                <option value="who-cpi">WHO CPI</option>
                <option value="other">other</option>
              </select>
            </label>
            {state.probe === "other" ? (
              <input
                className="rounded border border-line bg-card px-2 py-1 text-[11.5px] text-navy"
                placeholder="which probe"
                value={state.probeNote}
                onChange={(event) =>
                  dispatch({ type: "probe", probe: "other", note: event.target.value })
                }
              />
            ) : null}
          </div>
        ) : (
          <p className="text-[11.5px] text-faint">{PROBE_LABEL[state.probe]}</p>
        )}
      </header>

      {/* WHY NOTHING CAN BE TYPED. Not a disabled attribute — there is no control
          below this line at all while the gate is shut. */}
      {!canSave ? (
        <p className="rounded-lg border border-line bg-card-muted px-3 py-2 text-[12px] leading-[1.45] text-muted">
          {copy.readOnly}
        </p>
      ) : null}

      {/* GDC 4.1.4, before the boxes rather than after them: a clinician who
          types six numbers and is then told they cannot be attributed has done
          the work twice. */}
      {canSave && !clinician ? (
        <p className="rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12px] leading-[1.45] text-ink">
          {copy.noAuthor}
        </p>
      ) : null}

      {/* THE SIX BOXES. Two rows of three, upper above lower, patient's right on
          the viewer's left — the order SEXTANTS is already in, which is also the
          order the cursor travels and the order a clinician calls out. */}
      <div
        role="grid"
        aria-label={
          canSave
            ? "BPE entry. Type 0 to 4 to score the sextant at the cursor and move on, * for furcation, arrows to move, Escape to leave the grid."
            : "BPE entry, read-only."
        }
        tabIndex={canSave ? 0 : undefined}
        onKeyDown={canSave ? onKeyDown : undefined}
        className="space-y-2 rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-royal"
      >
        {ARCHES.map(({ label, sextants }) => (
          <div key={label}>
            <div className="flex items-center gap-2 px-0.5 pb-1">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-faint">
                {label}
              </span>
              <span aria-hidden className="h-px flex-1 bg-line" />
            </div>
            <div role="row" className="grid grid-cols-3 gap-2">
              {sextants.map((sextant) => (
                <EntryCell
                  key={sextant}
                  sextant={sextant}
                  state={state}
                  canSave={canSave}
                  // With the gate shut there is no cursor, because there is
                  // nothing for it to be a cursor for.
                  atCursor={canSave && state.cursor === sextant}
                  position={order.indexOf(sextant)}
                  total={order.length}
                  onSelect={() => dispatch({ type: "moveTo", sextant })}
                  // THE DECLARATION NAMES ITS OWN BOX. This control sits under
                  // one sextant and says so on its face, so it dispatches that
                  // sextant — never the cursor, which is wherever the last number
                  // left it. The status matches the button's own words: "fewer
                  // than MIN_TEETH_PER_SEXTANT teeth" is insufficient-teeth, and
                  // is a different clinical claim from an edentulous sextant.
                  onDeclare={
                    state.dentitionKnown
                      ? null
                      : () =>
                          dispatch(
                            canScore(state, sextant)
                              ? { type: "declareUnscorable", sextant, status: "insufficient-teeth" }
                              : { type: "undeclare", sextant },
                          )
                  }
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* The live region, keyed on the nonce so two identical consecutive
          announcements are distinct states and the second is announced rather
          than lost. Only where something can be typed: a status region narrating
          a cursor on a screen with no cursor is noise a screen-reader user cannot
          silence. */}
      {canSave ? (
        <p className="sr-only" role="status" aria-live="polite" key={state.nonce}>
          {state.message ??
            (state.cursor === null
              ? "No sextant in this mouth can be scored."
              : `${SEXTANT_LABEL[state.cursor]} sextant. ${describeScore(state, state.cursor)}`)}
        </p>
      ) : null}

      {state.message ? (
        <p className="rounded-lg border border-tint-royal-line bg-tint-royal px-3 py-2 text-[12px] leading-[1.45] text-status-royal">
          {state.message}
        </p>
      ) : null}

      {/* WHAT THESE SCORES NOW REQUIRE, live, as they go in. The sentence is
          chartingRequirement()'s own, written for exactly this slot: "code 4 in
          the lower left, so a full-mouth chart from the outset" is actionable
          and a red dot is not. It appears only once something has been scored —
          before that the engine's answer is that the screening says nothing, and
          printing that under an empty grid would be noise. */}
      {requirement.highest ? (
        <div
          className={`rounded-lg border px-3 py-2 ${
            requirement.kind === "none" ? "border-line bg-card-muted" : "border-tint-red-line bg-tint-red"
          }`}
        >
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-faint">
            What these scores now require
          </p>
          <p className="pt-0.5 text-[12.5px] leading-[1.45] text-ink">{requirement.reason}</p>
          {requirement.advisories.map((advisory) => (
            <p key={advisory} className="pt-1 text-[12px] leading-[1.45] text-muted">
              {advisory}
            </p>
          ))}
        </div>
      ) : null}

      {canSave ? <KeyHelp declarable={!state.dentitionKnown} /> : null}

      {/* SAVE. Everything that would stop it is printed before it is pressed. */}
      {canSave ? (
        <div className="space-y-2">
          {refusal ? (
            <p className="rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12px] leading-[1.45] text-ink">
              {refusal}
            </p>
          ) : null}

          {saveIssues.length > 0 ? (
            <ul className="space-y-1 rounded-lg border border-tint-red-line bg-tint-red px-3 py-2 text-[12px] leading-[1.45] text-status-red">
              {saveIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}

          {saveNotice ? (
            <p className="rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12px] leading-[1.45] text-status-amber">
              {saveNotice}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!canPressSave}
              className="rounded-lg bg-blue-royal px-3.5 py-1.5 text-[12.5px] font-semibold text-on-navy disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Recording…" : "Record BPE"}
            </button>
            <span className="text-[11.5px] leading-[1.4] text-faint">
              {savedVersion !== null && !state.dirty
                ? `Recorded${savedVersion ? ` as version ${savedVersion}` : ""}. Scoring again and recording writes a further examination, not an amendment to this one.`
                : state.dirty
                  ? "Not yet on the record. Nothing here is sent to Dentally."
                  : "Nothing scored yet."}
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The arches. Derived from SEXTANTS, in SEXTANTS' own order, so this grid cannot
// gain, lose or reorder a sextant without bpe.ts saying so — the same derivation
// bpe-grid.tsx makes, for the same reason.
// ---------------------------------------------------------------------------

const ARCHES: readonly { label: string; sextants: readonly SextantId[] }[] = [
  { label: "Upper", sextants: SEXTANTS.filter((s) => s.startsWith("U")) },
  { label: "Lower", sextants: SEXTANTS.filter((s) => s.startsWith("L")) },
];

// ---------------------------------------------------------------------------
// One box
// ---------------------------------------------------------------------------

/**
 * A sextant, in whichever of its three states it is in: scored, scorable and
 * empty, or not scorable at all.
 *
 * NO BOX IS EVER BLANK. A blank box on a BPE grid reads as a 0 to a clinician
 * with twenty seconds between patients, and a 0 is a positive claim of health
 * (CHARTING.md §6.3). So a box with no score says which kind of nothing it is,
 * and a box that cannot hold a score says why and names where its teeth are
 * recorded instead — skipReason()'s sentence, from the tested module.
 */
function EntryCell({
  sextant,
  state,
  canSave,
  atCursor,
  position,
  total,
  onSelect,
  onDeclare,
}: {
  sextant: SextantId;
  state: BpeEntryState;
  canSave: boolean;
  atCursor: boolean;
  /** Place in the travel order, or -1 when this sextant is skipped. */
  position: number;
  total: number;
  onSelect: () => void;
  /** Null when the platform knows the dentition and the question is settled. */
  onDeclare: (() => void) | null;
}) {
  const scorable = canScore(state, sextant);
  const score = state.scores[sextant];
  const band = score ? bpeBand(score) : null;
  const skin = band ? BAND_CLASS[band] : UNSCORED_CLASS;
  const cursorSkin = atCursor
    ? "outline outline-2 outline-offset-2 outline-blue-royal"
    : "outline-none";
  const reason = skipReason(state, sextant);

  const body = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em]">{sextant}</span>
        <span className="text-[10.5px] font-medium capitalize opacity-80">
          {SEXTANT_LABEL[sextant]}
        </span>
      </div>

      {/* THE NUMBER, big enough to read across a surgery. serialiseBpeScore
          writes the star, so "3" and "3*" come from the engine's own writer and
          this grid cannot print a star the state does not hold. */}
      <div className="flex items-end gap-2 pt-0.5">
        <span className="text-[30px] font-semibold leading-[1] tabular-nums">
          {score ? serialiseBpeScore(score) : "–"}
        </span>
        <span className="pb-[3px] text-left text-[11px] font-semibold leading-[1.25]">
          {score
            ? score.furcation
              ? "furcation"
              : null
            : scorable
              ? "No score yet"
              : state.statuses[sextant] === "no-teeth"
                ? "No teeth"
                : "Too few teeth"}
        </span>
      </div>

      {/* The engine's own definition of the code, or the engine's own sentence
          about why this sextant holds none. On the box, not in a tooltip: a title
          attribute is not reachable by keyboard and is not dependably announced. */}
      <p className="pt-1 text-left text-[11px] leading-[1.35]">
        {score
          ? BPE_CODE_MEANING[score.code]
          : (reason ??
            `Not yet scored. A blank box is not a 0 — code 0 is a claim that this sextant is healthy, and nobody has made it.`)}
      </p>

      {/* The tooth set. Canonical from SEXTANT_TEETH; the teeth this record does
          not list as present are struck through, so the reason a sextant is
          unscorable is visible rather than merely asserted. */}
      <div className="flex flex-wrap gap-x-1.5 pt-1.5 text-[10.5px] tabular-nums opacity-70">
        {SEXTANT_TEETH[sextant].map((tooth) => (
          <span
            key={tooth}
            className={
              state.dentitionKnown && !state.qualification[sextant].presentTeeth.includes(tooth)
                ? "line-through opacity-60"
                : undefined
            }
          >
            {tooth}
          </span>
        ))}
      </div>

      {/* Where this box sits in the travel order, and whether the next number
          lands in it. ONLY WHEN A NUMBER COULD LAND: with the gate shut there is
          no cursor to be at, and "entering here" over a box nothing can be typed
          into is the screen contradicting itself. */}
      {canSave && scorable && position >= 0 ? (
        <p className="pt-1 text-[10px] uppercase tracking-[0.06em] opacity-70">
          {position + 1} of {total}
          {atCursor ? " · entering here" : ""}
        </p>
      ) : null}
    </>
  );

  const shell = `w-full rounded-lg border px-2.5 py-2 text-left ${skin} ${cursorSkin}`;

  // READ-ONLY IS A FACT, NOT AN ATTRIBUTE. With the gate shut this is a div: no
  // button, nothing focusable, nothing to type into by any route.
  if (!canSave) {
    return (
      <div role="gridcell" className={shell} aria-label={`${SEXTANT_LABEL[sextant]} sextant`}>
        {body}
      </div>
    );
  }

  return (
    <div role="gridcell" aria-selected={atCursor} className="space-y-1">
      <button
        type="button"
        onClick={onSelect}
        disabled={!scorable}
        aria-label={`${SEXTANT_LABEL[sextant]} sextant. ${describeScore(state, sextant)}`}
        className={`${shell} disabled:cursor-not-allowed`}
      >
        {body}
      </button>

      {/* THE ESCAPE HATCH, and only where the platform does not know the mouth.
          A BPE records all six sextants, so one that genuinely has too few teeth
          has to be sayable — otherwise a real examination cannot be saved at all.
          Where the record DOES list the teeth this control is absent, because the
          chart answers the question and a clinician must not be able to type a
          sextant out of existence. */}
      {onDeclare ? (
        <button
          type="button"
          onClick={onDeclare}
          className="w-full rounded-md border border-line bg-card px-2 py-1 text-[10.5px] leading-tight text-muted"
        >
          {scorable
            ? `Cannot be scored: fewer than ${MIN_TEETH_PER_SEXTANT} teeth`
            : "This sextant can be scored after all"}
        </button>
      ) : null}
    </div>
  );
}

/** One sentence about a sextant, for a screen reader and for a button label. */
function describeScore(state: BpeEntryState, sextant: SextantId): string {
  const score = state.scores[sextant];
  if (score) {
    return `Scored ${serialiseBpeScore(score)}. ${BPE_CODE_MEANING[score.code]}`;
  }
  return skipReason(state, sextant) ?? "No score yet. This is not a 0.";
}

// ---------------------------------------------------------------------------
// The keys
// ---------------------------------------------------------------------------

/** What the keyboard does, on the screen rather than in a manual. Entry speed is
 *  the whole feature (PERIO.md §4), and a shortcut nobody can see is a shortcut
 *  nobody uses. */
function KeyHelp({ declarable }: { declarable: boolean }) {
  return (
    <p className="text-[11px] leading-[1.5] text-faint">
      <b className="font-semibold text-muted">0–4</b> scores the sextant at the cursor and moves on
      · <b className="font-semibold text-muted">*</b> (or <b className="font-semibold text-muted">f</b>)
      adds furcation involvement to the score just given ·{" "}
      <b className="font-semibold text-muted">arrows</b> or{" "}
      <b className="font-semibold text-muted">tab</b> move ·{" "}
      <b className="font-semibold text-muted">backspace</b> clears ·{" "}
      <b className="font-semibold text-muted">escape</b> leaves the grid. Travel runs upper right,
      upper anterior, upper left, then lower right, lower anterior, lower left, and steps over any
      sextant with fewer than {MIN_TEETH_PER_SEXTANT} qualifying teeth.
      {declarable
        ? " This record does not list which teeth are present, so a sextant that cannot be scored has to be marked as such on its own box."
        : ""}
    </p>
  );
}
