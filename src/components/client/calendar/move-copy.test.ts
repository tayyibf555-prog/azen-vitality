import { describe, it, expect } from "vitest";
import { checkContinuity } from "@/lib/calendar/continuity";
import {
  cancelledAnnouncement,
  moveModeAnnouncement,
  moveSubjectLine,
  movedAnnouncement,
  notSavedAnnouncement,
  notifyNotice,
  proposedAnnouncement,
  savingAnnouncement,
  truncateRefusal,
  unknownOutcomeSentence,
  MOVE_BLOCKED_BY_READ,
  REFUSAL_CHIP_MAX,
  WRITE_GATE_OFF_PANEL,
  WRITE_GATE_ON_PANEL,
} from "./move-copy";

const NINE_THIRTY = { startIso: "2026-07-31T08:30:00Z" };
const TWO_THIRTY = { startIso: "2026-07-31T13:30:00Z" };

describe("notifyNotice", () => {
  it("a time change with nothing in the way says the patient will be texted", () => {
    const n = notifyNotice({ from: NINE_THIRTY, to: TWO_THIRTY, blocker: "none", dryRun: false });
    expect(n).toEqual({
      willQueue: true,
      text:
        "The patient will be texted about the new time. Nothing is sent if they have opted out or have no mobile number on file.",
      tone: "plain",
    });
  });

  it("a clinician-only move sends nothing and says so", () => {
    const n = notifyNotice({ from: NINE_THIRTY, to: { ...NINE_THIRTY }, blocker: "none", dryRun: false });
    expect(n.willQueue).toBe(false);
    expect(n.text).toBe("The patient will not be texted. Only the clinician is changing.");
  });

  it("the same instant written two ways is not a change", () => {
    // The mock emits Z, live Dentally emits +01:00. A string comparison would text
    // every patient on every reassignment the first time this ran against the API.
    const n = notifyNotice({
      from: { startIso: "2026-07-31T13:30:00Z" },
      to: { startIso: "2026-07-31T14:30:00+01:00" },
      blocker: "none",
      dryRun: false,
    });
    expect(n.willQueue).toBe(false);
  });

  it("names each blocker in its own words", () => {
    const cases: Array<[Parameters<typeof notifyNotice>[0]["blocker"], string]> = [
      ["messaging_off", "The patient will not be texted: messaging is switched off."],
      ["no_phone", "The patient will not be texted: no practice phone number is configured."],
      ["no_mobile", "The patient will not be texted: there is no mobile number on their record."],
      ["opted_out", "The patient will not be texted: they have opted out of messages."],
    ];
    for (const [blocker, text] of cases) {
      const n = notifyNotice({ from: NINE_THIRTY, to: TWO_THIRTY, blocker, dryRun: false });
      expect(n.willQueue).toBe(false);
      expect(n.text).toBe(text);
    }
  });

  it("a blocker wins over the dry run, because nothing is queued either way", () => {
    const n = notifyNotice({ from: NINE_THIRTY, to: TWO_THIRTY, blocker: "opted_out", dryRun: true });
    expect(n.willQueue).toBe(false);
    expect(n.tone).toBe("plain");
  });

  it("the dry run queues a row but says plainly that nothing is delivered", () => {
    const n = notifyNotice({ from: NINE_THIRTY, to: TWO_THIRTY, blocker: "none", dryRun: true });
    expect(n.willQueue).toBe(true);
    expect(n.tone).toBe("amber");
    expect(n.text).toBe(
      "The patient will not actually be texted. Messages are simulated on this environment.",
    );
  });

  it("never claims a send on a clinician-only move, whatever the environment", () => {
    for (const dryRun of [true, false]) {
      const n = notifyNotice({ from: NINE_THIRTY, to: { ...NINE_THIRTY }, blocker: "none", dryRun });
      expect(n.willQueue).toBe(false);
    }
  });
});

describe("moveSubjectLine", () => {
  it("reads as the reference does", () => {
    expect(moveSubjectLine({ patientShort: "N.Lamprell", treatment: "Scale & Polish", minutes: 30 })).toBe(
      "N.Lamprell, Scale & Polish, 30 minutes.",
    );
  });

  it("omits a missing treatment rather than printing an empty separator", () => {
    expect(moveSubjectLine({ patientShort: "N.Lamprell", treatment: null, minutes: 30 })).toBe(
      "N.Lamprell, 30 minutes.",
    );
    expect(moveSubjectLine({ patientShort: "N.Lamprell", treatment: "  ", minutes: null })).toBe(
      "N.Lamprell.",
    );
  });

  it("gets the singular right", () => {
    expect(moveSubjectLine({ patientShort: "A.Bell", treatment: null, minutes: 1 })).toBe(
      "A.Bell, 1 minute.",
    );
  });

  it("returns nothing at all when there is nothing to say", () => {
    expect(moveSubjectLine({ patientShort: "", treatment: null, minutes: null })).toBe("");
  });
});

describe("announcements", () => {
  it("move mode names the appointment, the time and the keys", () => {
    expect(moveModeAnnouncement("move", "N.Lamprell", "09:30", "Jin Kim")).toBe(
      "Move mode. N.Lamprell, 09:30, Jin Kim. Arrow keys to move, Enter to confirm, Escape to cancel.",
    );
  });

  it("resize mode says it is the length that changes", () => {
    expect(moveModeAnnouncement("resize", "N.Lamprell", "09:30", null)).toContain("change the length");
  });

  it("the proposal names the new time, clinician and length", () => {
    expect(proposedAnnouncement("N.Lamprell", "14:30", "Femi Osei", 30)).toBe(
      "N.Lamprell to 14:30 with Femi Osei, 30 minutes.",
    );
  });

  it("saving, moved and not-saved each name where the appointment actually is", () => {
    expect(savingAnnouncement("N.Lamprell", "14:30", "Femi Osei")).toBe(
      "Saving: N.Lamprell to 14:30 with Femi Osei.",
    );
    expect(movedAnnouncement("N.Lamprell", "14:30", "Femi Osei")).toBe(
      "Moved. N.Lamprell is now 14:30 with Femi Osei. Press Control Z to undo.",
    );
    expect(notSavedAnnouncement("N.Lamprell", "09:30", "Jin Kim")).toBe(
      "That move did not save. N.Lamprell is still at 09:30 with Jin Kim.",
    );
    expect(cancelledAnnouncement("N.Lamprell", "09:30", "Jin Kim")).toBe(
      "Move cancelled. N.Lamprell is still at 09:30 with Jin Kim.",
    );
  });

  it("the unknown outcome claims nothing and says what to do", () => {
    const s = unknownOutcomeSentence("N.Lamprell");
    expect(s).toContain("may or may not have saved");
    expect(s).toContain("check before telling the patient");
  });

  it("drops the clinician cleanly when there is not one", () => {
    expect(movedAnnouncement("N.Lamprell", "14:30", null)).toBe(
      "Moved. N.Lamprell is now 14:30. Press Control Z to undo.",
    );
    expect(movedAnnouncement("N.Lamprell", "14:30", "   ")).toBe(
      "Moved. N.Lamprell is now 14:30. Press Control Z to undo.",
    );
  });
});

describe("truncateRefusal", () => {
  it("leaves a short sentence alone", () => {
    expect(truncateRefusal("Outside working hours.")).toBe("Outside working hours.");
  });

  it("cuts a long one to the chip width, with the full text going to the live region", () => {
    const long = "The proposed time is outside Femi Osei's working hours.";
    const cut = truncateRefusal(long);
    expect(cut.length).toBeLessThanOrEqual(REFUSAL_CHIP_MAX);
    expect(cut.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE CHIP IS THE ONLY REFUSAL A SIGHTED READER SEES.
//
// A drop that is refused never opens the confirmation dialog: the block goes
// back, the full sentence goes to an sr-only live region, and the ONLY thing
// drawn on the screen is the drag preview's chip — cut to REFUSAL_CHIP_MAX. So
// whatever the chip cannot carry is, for anybody looking at the diary, not said.
//
// The practice manager's requirement is specifically that the refusal name the
// clinician the course has to stay with. This measures the refusal AS DRAWN,
// through the real truncation, because the earlier wording passed every prose
// assertion in continuity.test.ts and still rendered
// "This is continuing treatment (Continuin…" on the grid.
// ---------------------------------------------------------------------------
describe("the continuing-treatment refusal, as the chip actually draws it", () => {
  const refusal = (reason: string | null, name: string | null = "Dana Hale"): string => {
    const res = checkContinuity({
      reason,
      fromPractitionerId: "prac-1",
      fromPractitionerName: name,
      toPractitionerId: "prac-2",
    });
    if (res.ok) throw new Error("expected a refusal");
    return res.message;
  };

  it("names the clinician inside the chip for a named continuing course", () => {
    const cut = truncateRefusal(refusal("Root canal review"));
    expect(cut.length).toBeLessThanOrEqual(REFUSAL_CHIP_MAX);
    expect(cut).toContain("Dana Hale");
  });

  it("names the clinician inside the chip for a course typed as continuing treatment", () => {
    expect(truncateRefusal(refusal("Continuing Treatment"))).toContain("Dana Hale");
  });

  it("names the clinician inside the chip when the treatment is merely unclear", () => {
    expect(truncateRefusal(refusal("Review"))).toContain("Dana Hale");
    expect(truncateRefusal(refusal("Emergency"))).toContain("Dana Hale");
  });

  it("names the clinician inside the chip when nothing at all is recorded", () => {
    expect(truncateRefusal(refusal(null))).toContain("Dana Hale");
  });

  it("survives a long clinician name by still leading with it", () => {
    const cut = truncateRefusal(refusal("Root canal review", "Priya Raman-Whitmore"));
    expect(cut).toContain("Priya Raman-Whitmore");
  });

  it("still says something usable when there is no name to give", () => {
    expect(truncateRefusal(refusal("Root canal review", "  "))).toContain("the same clinician");
  });

  it("does not say the treatment twice when the treatment IS continuing treatment", () => {
    expect(refusal("Continuing Treatment")).not.toContain("(Continuing Treatment)");
  });
});

describe("house rules", () => {
  const strings = [
    MOVE_BLOCKED_BY_READ,
    WRITE_GATE_OFF_PANEL,
    WRITE_GATE_ON_PANEL,
    notifyNotice({ from: NINE_THIRTY, to: TWO_THIRTY, blocker: "none", dryRun: false }).text,
    notifyNotice({ from: NINE_THIRTY, to: TWO_THIRTY, blocker: "none", dryRun: true }).text,
    movedAnnouncement("N.Lamprell", "14:30", "Femi Osei"),
    unknownOutcomeSentence("N.Lamprell"),
  ];

  it("carries no em-dash anywhere", () => {
    for (const s of strings) expect(s).not.toContain("—");
  });

  it("carries no exclamation mark anywhere", () => {
    for (const s of strings) expect(s).not.toContain("!");
  });

  it("never presents the appointment update as proven against live Dentally", () => {
    expect(WRITE_GATE_ON_PANEL).not.toMatch(/verified|proven|guaranteed/i);
  });
});
