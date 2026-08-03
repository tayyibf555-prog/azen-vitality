// ===========================================================================
// MAY THIS DIARY BE DRAGGED AT ALL?
//
// move-validate.ts judges ONE DROP against one clinician's day. This judges the
// WHOLE BOARD, before any gesture starts, and it exists because the affordance
// used to be gated on the reader's ROLE alone. With DENTALLY_WRITE_ENABLED
// absent, which is how production runs today, the block still lifted under the
// pointer, the confirmation still offered to text the patient, and the only
// refusal arrived from the server after the whole gesture had been completed and
// answered. The gesture promised something the environment could not do.
//
// NOTHING HERE IS A SECURITY BOUNDARY. The write route re-runs the role check,
// the owner's kill switch and isDentallyWriteEnabled() against inputs it fetched
// itself, and it is the only authority. This is honesty: the diary stops
// offering a move it already knows it cannot make.
//
// PURE, so the rule is testable. The board's handlers only read the two booleans
// it returns.
// ===========================================================================

export interface DiaryMoveGateInput {
  /** True when the reader's ROLE may move an appointment (PATIENT_ADMIN_ROLES). */
  canMove: boolean;
  /**
   * isDentallyWriteEnabled(), resolved on the server that rendered the page and
   * handed down as a prop. The SAME gate the write route checks at its step 6,
   * so the affordance and the commit cannot disagree about whether a move is
   * possible at all.
   */
  writeEnabled: boolean;
}

export interface DiaryMoveGate {
  /**
   * Whether the drag and keyboard affordances are live, and whether a
   * confirmation reached by any route could actually commit.
   *
   * The per-day read failures are NOT folded in here: they are transient, worded
   * separately and applied alongside this by the move hook.
   */
  dragEnabled: boolean;
  /**
   * Whether the board prints its standing "rescheduling is switched off" line.
   *
   * ONLY to a reader who would otherwise have had the affordance. A receptionist
   * whose role never permits a move does not need to be told about an
   * environment flag she could not use either way, and the appointment panel
   * already tells her the one thing that applies to her.
   */
  noticeShown: boolean;
}

export function diaryMoveGate(input: DiaryMoveGateInput): DiaryMoveGate {
  return {
    dragEnabled: input.canMove && input.writeEnabled,
    noticeShown: input.canMove && !input.writeEnabled,
  };
}
