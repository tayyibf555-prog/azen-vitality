import { describe, expect, it } from "vitest";
import { diaryMoveGate } from "./move-gate";

describe("diaryMoveGate", () => {
  describe("the write gate is shut, which is how production runs today", () => {
    it("refuses the drag before the gesture starts", () => {
      // The defect this exists for: the block lifted under the pointer, the
      // confirmation offered to text the patient, and only the commit failed.
      expect(diaryMoveGate({ canMove: true, writeEnabled: false }).dragEnabled).toBe(false);
    });

    it("tells the reader who would otherwise have had the affordance", () => {
      expect(diaryMoveGate({ canMove: true, writeEnabled: false }).noticeShown).toBe(true);
    });

    it("says nothing to a reader whose role could never move anything", () => {
      // She could not have dragged it either way, and the appointment panel
      // already tells her the one thing that applies to her.
      expect(diaryMoveGate({ canMove: false, writeEnabled: false })).toEqual({
        dragEnabled: false,
        noticeShown: false,
      });
    });
  });

  describe("the write gate is open", () => {
    it("leaves the role gate exactly as it was", () => {
      // "Unchanged behaviour": with writes on, dragEnabled IS canMove and nothing
      // else, so turning the gate on cannot have introduced a new refusal.
      for (const canMove of [true, false]) {
        expect(diaryMoveGate({ canMove, writeEnabled: true }).dragEnabled).toBe(canMove);
      }
    });

    it("prints no notice in either role", () => {
      for (const canMove of [true, false]) {
        expect(diaryMoveGate({ canMove, writeEnabled: true }).noticeShown).toBe(false);
      }
    });
  });

  it("never shows the notice while the drag is live, in any combination", () => {
    // The two are answers to different questions and could drift apart. A board
    // that says rescheduling is off while blocks still drag is the same lie in
    // the other direction.
    for (const canMove of [true, false]) {
      for (const writeEnabled of [true, false]) {
        const gate = diaryMoveGate({ canMove, writeEnabled });
        expect(gate.dragEnabled && gate.noticeShown).toBe(false);
      }
    }
  });
});
