import "server-only";

// ===========================================================================
// THE PERIO GATE.
//
// Mirrors isChartDraftEnabled() in src/lib/charting/write-gate.ts, with ONE
// deliberate difference: this module is server-only and that flag is not.
//
// isChartDraftEnabled() is read by chart-workspace.tsx, a client component, so
// its value ships in the bundle. That is tolerable for a draft overlay. It is
// not tolerable here. Perio has no Dentally counterpart at all: with the gate
// off there is nothing to render, no partial state worth showing and no reason
// for a browser to hold an opinion about whether the practice has switched on a
// second clinical record. The server decides, the server answers 503, and the
// flag never crosses the wire. `import "server-only"` is what makes that a build
// error rather than a code-review convention.
//
// WHY THE COPY LIVES HERE and not in CHART_COPY (src/lib/patient/tabs.ts): the
// perio sentences are about a feature that renders nothing while it is off, and
// the only place they are read is the API's own 503 body. Moving them into the
// chart's copy module would put perio sentences on the chart's copy sweep, which
// covers the read-only mirror's honesty claims -- a different subject.
// ===========================================================================

/**
 * Whether this practice records periodontal findings IN THIS PLATFORM.
 *
 * DEFAULTS FALSE, and the default is the whole point.
 *
 * Dentally's API exposes no periodontal resource of any kind, so there is
 * nothing to mirror: everything perio holds is authored here, which makes this
 * platform the system of record for it the moment the flag flips, while
 * Dentally's own Perio tab still exists and still works. Two live clinical
 * records for the same patient is the worst outcome available, so the decision
 * belongs to the practice in writing, not to a developer with an env var.
 *
 * Read on the SERVER ONLY. Never expose this as NEXT_PUBLIC_.
 */
export function isPerioEnabled(): boolean {
  return process.env.PERIO_ENABLED === "true";
}

/**
 * Whether a periodontal finding may be persisted. Same answer, different
 * question, named separately so a future read-only preview mode has somewhere to
 * diverge without anyone having to re-read every call site.
 */
export function canSavePerio(): boolean {
  return isPerioEnabled();
}

/** The env var this whole module turns on, named once so the 503 can quote it. */
export const PERIO_ENV_FLAG = "PERIO_ENABLED";

export const PERIO_COPY = {
  /**
   * The 503 body. It NAMES the environment variable, because the alternative
   * responses are all worse: a 404 says the feature does not exist, and an empty
   * 200 says this patient has no periodontal findings -- which is
   * indistinguishable from a healthy BPE 0 and is precisely the false
   * completeness CHARTING.md 6.3 is about.
   */
  disabled:
    "Periodontal charting is switched off in this platform, so nothing is recorded or shown here. " +
    "This is not a statement about this patient: check Dentally for their BPE and periodontal chart. " +
    `Switching it on is a practice decision and requires ${PERIO_ENV_FLAG}.`,

  /**
   * Shown wherever perio is enabled, and never omitted for tidiness.
   *
   * BPE has been a mandatory FP17 field since 1 October 2022. If it is recorded
   * here while claims still go out of Dentally, it is entered twice, and a
   * mandatory claim field entered twice is where a claim gets rejected or two
   * records quietly disagree. The feature is worth having; pretending this
   * consequence does not exist is not.
   */
  doubleEntry:
    "BPE is a mandatory field on the NHS FP17 claim. While claims are submitted from Dentally, a score " +
    "recorded here must also be entered there, and the two records can disagree. This is better charting, " +
    "not a replacement for Dentally's perio record.",

  /**
   * What the SCREEN is, while the gate is shut.
   *
   * ADDED BY THE INTEGRATOR, and here rather than in the shell for the reason the
   * header gives: every sentence on this record that distinguishes "we hold none"
   * from "we cannot show this" lives in a tested module. `disabled` above is
   * written for the API's 503 body, where nothing is rendered at all, and it says
   * "nothing is recorded or shown here". The tab renders the real screen read-only
   * — the grid, the legend, the empty chart — so a reader is looking at six empty
   * sextant boxes while being told nothing is shown. This sentence is what makes
   * those boxes legible: they are the SHAPE of the feature, not six normal
   * findings, and the difference between an unread sextant and a healthy one is
   * the whole safety argument of this module.
   */
  preview:
    "What follows is the shape of the periodontal screen, not this patient's periodontal record. Nothing on " +
    "it can be entered, amended or saved while the feature is off, and every box below is empty because " +
    "nothing is being read — not because a finding was normal.",

  /**
   * The sentence for the moment perio is enabled here AND still kept in Dentally.
   *
   * PERIO.md §4, last bullet: that is exactly when a clinician is most likely to
   * look in the wrong place, so the screen must say BOTH. `doubleEntry` above says
   * what it costs on the claim; this says where the data physically is. They are
   * different facts and neither substitutes for the other.
   */
  bothRecords:
    "Dentally's own Perio tab still exists and still works, so this patient may have periodontal findings in " +
    "both places. Nothing recorded here is sent to Dentally, and nothing recorded in Dentally is read here — " +
    "check both before treating.",

  /**
   * Why the BPE entry panel cannot be typed into while the gate is shut.
   *
   * IT REPLACES `bpeEntryUnbuilt`, which said a BPE could not be typed on this
   * screen at all. That was true and is no longer: bpe-entry.tsx records one, and
   * a screen that keeps apologising for a gap it no longer has trains people to
   * read past its warnings — which is the same failure as amber on a standing
   * condition, one level down.
   *
   * It is NOT `preview` and it is NOT `disabled`, both of which are already on
   * this screen once each. Those two say what the whole tab is and where the
   * patient's real record lives. This one is about the six boxes directly beneath
   * it: they are the shape of an entry grid rather than a BPE anyone could take,
   * and the panel renders rather than vanishing precisely so the practice can see
   * what switching the flag on would give them.
   */
  bpeEntryReadOnly:
    "This is what recording a BPE here would look like. Nothing on it can be typed while periodontal charting " +
    "is switched off — there is no field below, not a disabled one — and the six boxes are the shape of the " +
    "entry grid, not this patient's scores. Record their BPE in Dentally, which is also where the FP17 claim is made.",

  /**
   * Why a write is refused when the server cannot name the clinician.
   *
   * GDC 4.1.4 puts the treating clinician on the record. Writing 'Team' onto a
   * periodontal finding would satisfy the column and fail the standard, so the
   * route refuses instead. Reads are unaffected.
   */
  noAuthor:
    "Periodontal findings record the clinician who made them, and this server cannot currently identify a " +
    "signed-in clinician, so nothing was saved. Sign in, or ask for authentication to be enabled here.",

  /** A write that failed. Never phrased as if it might have half-succeeded. */
  saveFailed:
    "That periodontal record was not saved. Nothing has been stored, and nothing has been sent to Dentally.",

  /** A read that failed. Explicitly not the same as "no findings". */
  readFailed:
    "Periodontal records could not be read. This is a failure to read them, not a finding that there are none.",
} as const;
