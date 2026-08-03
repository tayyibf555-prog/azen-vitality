import { describe, it, expect } from "vitest";
import {
  chartReducer,
  draftKey,
  initialChartState,
  intentFromKey,
  intentFromPointer,
} from "./selection";
import type { ChartState, DraftEntry } from "./types";

/**
 * The click mechanic, rule by rule. Each test is named as a full sentence
 * stating the behaviour AND the alternative that would be wrong, because the
 * alternative is what a later contributor will be tempted to "fix".
 */

const TREATMENT = { code: "121", name: "NHS Urgent Filling" };

function ready(over: Partial<ChartState> = {}): ChartState {
  return {
    ...initialChartState({ draftEnabled: true }),
    activeTreatment: TREATMENT,
    ...over,
  };
}

/** Left click a surface, then right click the rest. The real gesture. */
function chart(state: ChartState, tooth: number, surfaces: readonly string[]): ChartState {
  let s = chartReducer(state, {
    kind: "chart-first",
    tooth,
    surface: surfaces[0] as DraftEntry["surfaces"][number],
  });
  for (const surface of surfaces.slice(1)) {
    s = chartReducer(s, {
      kind: "chart-add",
      tooth,
      surface: surface as DraftEntry["surfaces"][number],
    });
  }
  return s;
}

describe("intentFromPointer", () => {
  it("charts the first surface on a plain left click and adds one on a right click", () => {
    expect(intentFromPointer({ type: "click", button: 0 })).toBe("first");
    expect(intentFromPointer({ type: "contextmenu", button: 2 })).toBe("add");
  });

  it("treats shift+left as add, so a trackpad with no right button can still chart an MOD", () => {
    expect(intentFromPointer({ type: "click", button: 0, shiftKey: true })).toBe("add");
  });

  // THE MACOS TRAP. ctrl-click fires contextmenu AND, in some browsers, a
  // click. Treating the click as "first" would chart and then add on ONE
  // gesture, producing a two-surface finding from a one-surface intent.
  it("ignores a ctrl+left click, rather than letting one macOS gesture chart twice", () => {
    expect(intentFromPointer({ type: "click", button: 0, ctrlKey: true })).toBe("ignore");
    expect(intentFromPointer({ type: "click", button: 0, ctrlKey: true, shiftKey: true })).toBe(
      "ignore",
    );
  });

  it("ignores a cmd+left click, which is the browser's open-in-new-tab gesture", () => {
    expect(intentFromPointer({ type: "click", button: 0, metaKey: true })).toBe("ignore");
  });

  // A middle click must never chart, and auxclick fires for both middle and
  // right, so honouring it would double-fire the right-click path.
  it("ignores every non-primary button and every auxclick", () => {
    expect(intentFromPointer({ type: "click", button: 1 })).toBe("ignore");
    expect(intentFromPointer({ type: "click", button: 2 })).toBe("ignore");
    expect(intentFromPointer({ type: "auxclick", button: 1 })).toBe("ignore");
    expect(intentFromPointer({ type: "auxclick", button: 2 })).toBe("ignore");
  });
});

describe("intentFromKey", () => {
  it("charts on Enter or Space and adds on shift, so the chart is reachable without a mouse", () => {
    expect(intentFromKey({ key: "Enter" })).toBe("first");
    expect(intentFromKey({ key: " " })).toBe("first");
    expect(intentFromKey({ key: "Enter", shiftKey: true })).toBe("add");
    expect(intentFromKey({ key: "Tab" })).toBe("ignore");
    expect(intentFromKey({ key: "a" })).toBe("ignore");
  });
});

describe("chartReducer", () => {
  it("rule 1: refuses to chart with no treatment selected, and says why rather than doing nothing", () => {
    const s = chartReducer(initialChartState({ draftEnabled: true }), {
      kind: "chart-first",
      tooth: 16,
      surface: "occlusal",
    });
    expect(s.draft).toEqual({});
    expect(s.lastRejection?.reason).toBe("no-treatment-selected");
    expect(s.lastRejection?.tooth).toBe(16);
    expect(s.lastRejection?.surface).toBe("occlusal");
  });

  it("rule 2: a left click REPLACES this tooth's entry with exactly that one surface, because it starts a finding rather than extending one", () => {
    const mod = chart(ready(), 16, ["mesial", "occlusal", "distal"]);
    const after = chartReducer(mod, { kind: "chart-first", tooth: 16, surface: "buccal" });
    expect(after.draft[draftKey(16, "121")].surfaces).toEqual(["buccal"]);
  });

  // THE WHOLE SAFETY OF THE MECHANIC. An accidental right click must never
  // chart. Treating it as a first surface would be convenient and wrong.
  it("rule 3: a right click with no first surface is REFUSED, rather than being treated as the first surface", () => {
    const s = chartReducer(ready(), { kind: "chart-add", tooth: 16, surface: "mesial" });
    expect(s.draft).toEqual({});
    expect(s.lastRejection?.reason).toBe("no-first-surface");
  });

  it("rule 4: right clicks append, de-duplicate and re-sort, so M then O then D is always MOD and never DMO", () => {
    const s = chart(ready(), 16, ["distal", "mesial", "occlusal"]);
    expect(s.draft[draftKey(16, "121")].surfaces).toEqual(["mesial", "occlusal", "distal"]);
    const again = chartReducer(s, { kind: "chart-add", tooth: 16, surface: "distal" });
    // Rule 5: a repeat right click REMOVES, so the surfaces cannot silently duplicate.
    expect(again.draft[draftKey(16, "121")].surfaces).toEqual(["mesial", "occlusal"]);
  });

  it("rule 5: right clicking the last remaining surface deletes the entry, rather than leaving a zero-surface ghost", () => {
    const s = chart(ready(), 16, ["mesial"]);
    const cleared = chartReducer(s, { kind: "chart-add", tooth: 16, surface: "mesial" });
    expect(cleared.draft[draftKey(16, "121")]).toBeUndefined();
    expect(Object.keys(cleared.draft)).toHaveLength(0);
  });

  it("rule 6: left clicking the single already-charted surface clears the tooth, so a left click is its own undo", () => {
    const s = chart(ready(), 16, ["occlusal"]);
    const cleared = chartReducer(s, { kind: "chart-first", tooth: 16, surface: "occlusal" });
    expect(cleared.draft[draftKey(16, "121")]).toBeUndefined();
  });

  it("rule 7: a locked chart refuses every charting intent, which is what stops a sleeve on the trackpad", () => {
    const locked = ready({ locked: true });
    const first = chartReducer(locked, { kind: "chart-first", tooth: 16, surface: "mesial" });
    expect(first.draft).toEqual({});
    expect(first.lastRejection?.reason).toBe("chart-locked");
    const add = chartReducer(chart(ready(), 16, ["mesial"]), { kind: "set-locked", locked: true });
    const blocked = chartReducer(add, { kind: "chart-add", tooth: 16, surface: "occlusal" });
    expect(blocked.draft[draftKey(16, "121")].surfaces).toEqual(["mesial"]);
    expect(blocked.lastRejection?.reason).toBe("chart-locked");
  });

  it("rule 8: switching dentition NEVER discards the other dentition's draft, because losing one is how a clinician stops trusting the screen", () => {
    const permanent = chart(ready(), 16, ["mesial", "occlusal"]);
    const deciduous = chartReducer(permanent, { kind: "set-dentition", dentition: "deciduous" });
    const both = chart(deciduous, 55, ["occlusal"]);
    const back = chartReducer(both, { kind: "set-dentition", dentition: "permanent" });
    expect(back.draft[draftKey(16, "121")].surfaces).toEqual(["mesial", "occlusal"]);
    expect(back.draft[draftKey(55, "121")].surfaces).toEqual(["occlusal"]);
    expect(back.draft[draftKey(55, "121")].dentition).toBe("deciduous");
  });

  it("rule 9: base-chart mode refuses charting, because the base chart is read-only here", () => {
    const s = chartReducer(ready({ dentition: "base" }), {
      kind: "chart-first",
      tooth: 16,
      surface: "mesial",
    });
    expect(s.draft).toEqual({});
    expect(s.lastRejection?.reason).toBe("base-chart-is-read-only");
  });

  it("rule 10: a tooth outside the drawn arch is refused, so a deciduous tooth cannot be charted on a permanent view", () => {
    const s = chartReducer(ready(), { kind: "chart-first", tooth: 55, surface: "occlusal" });
    expect(s.draft).toEqual({});
    expect(s.lastRejection?.reason).toBe("tooth-not-in-arch");
    // And a number that is not a tooth at all.
    expect(
      chartReducer(ready(), { kind: "chart-first", tooth: 19, surface: "occlusal" }).lastRejection
        ?.reason,
    ).toBe("tooth-not-in-arch");
  });

  // THE SHIPPED DEFAULT. The reducer must SAY the draft is off rather than
  // appearing to work and losing the clinician's planning at the route.
  it("rule 11: with the draft switched off every charting intent is refused as draft-disabled, not silently ignored", () => {
    const off = { ...ready(), draftEnabled: false };
    const first = chartReducer(off, { kind: "chart-first", tooth: 16, surface: "mesial" });
    expect(first.draft).toEqual({});
    expect(first.lastRejection?.reason).toBe("draft-disabled");
    const add = chartReducer(off, { kind: "chart-add", tooth: 16, surface: "mesial" });
    expect(add.lastRejection?.reason).toBe("draft-disabled");
    // It outranks every other refusal, so the screen states the real cause.
    const noTreatment = chartReducer(
      { ...off, activeTreatment: null, locked: true },
      { kind: "chart-first", tooth: 16, surface: "mesial" },
    );
    expect(noTreatment.lastRejection?.reason).toBe("draft-disabled");
  });

  it("rule 12: a left click that DISPLACES a multi-surface entry keeps it in undo, and undo restores it byte for byte", () => {
    const mod = chart(ready(), 16, ["mesial", "occlusal", "distal"]);
    const before = mod.draft[draftKey(16, "121")];
    const displaced = chartReducer(mod, { kind: "chart-first", tooth: 16, surface: "buccal" });
    expect(displaced.undo).toEqual({ key: draftKey(16, "121"), entry: before });
    const restored = chartReducer(displaced, { kind: "undo" });
    expect(restored.draft[draftKey(16, "121")]).toEqual(before);
    // One step only, and it does not then re-apply itself.
    expect(restored.undo).toBeNull();
  });

  it("rule 12: undo of a first-ever entry removes it, rather than leaving it behind because there was nothing to restore", () => {
    const s = chart(ready(), 16, ["mesial"]);
    expect(s.undo).toEqual({ key: draftKey(16, "121"), entry: null });
    const undone = chartReducer(s, { kind: "undo" });
    expect(undone.draft[draftKey(16, "121")]).toBeUndefined();
  });

  it("rule 13: two identical consecutive refusals are DIFFERENT states, so an aria-live region announces the second one too", () => {
    const a = chartReducer(ready(), { kind: "chart-add", tooth: 16, surface: "mesial" });
    const b = chartReducer(a, { kind: "chart-add", tooth: 16, surface: "mesial" });
    expect(b.lastRejection?.reason).toBe(a.lastRejection?.reason);
    expect(b.lastRejection?.nonce).not.toBe(a.lastRejection?.nonce);
    expect(b.lastRejection).not.toEqual(a.lastRejection);
  });

  it("rule 14: nothing in state can touch a Dentally-read item, because Dentally items are not in state at all", () => {
    const s = chart(ready(), 16, ["mesial"]);
    // The only mutable clinical data is `draft`. If a later change adds a
    // Dentally items array here, this assertion is the one that must fail.
    expect(Object.keys(s).sort()).toEqual(
      [
        "activePlanId",
        "activeTooth",
        "activeTreatment",
        "dentition",
        "draft",
        "draftEnabled",
        "lastRejection",
        "locked",
        "rejectionSeq",
        "undo",
      ].sort(),
    );
  });

  it("does not mutate the state it was given", () => {
    const before = ready();
    const snapshot = JSON.stringify(before);
    chart(before, 16, ["mesial", "occlusal"]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("clears a tooth on demand and keeps other teeth untouched", () => {
    const two = chart(chart(ready(), 16, ["mesial"]), 26, ["distal"]);
    const cleared = chartReducer(two, { kind: "clear-tooth", tooth: 16 });
    expect(cleared.draft[draftKey(16, "121")]).toBeUndefined();
    expect(cleared.draft[draftKey(26, "121")].surfaces).toEqual(["distal"]);
    expect(chartReducer(cleared, { kind: "undo" }).draft[draftKey(16, "121")].surfaces).toEqual([
      "mesial",
    ]);
  });

  it("hydrates the draft wholesale from the server and drops a stale undo with it", () => {
    const s = chart(ready(), 16, ["mesial"]);
    const server: Record<string, DraftEntry> = {
      [draftKey(26, "121")]: {
        tooth: 26,
        surfaces: ["occlusal"],
        treatmentCode: "121",
        treatmentName: "NHS Urgent Filling",
        dentition: "permanent",
      },
    };
    const hydrated = chartReducer(s, { kind: "hydrate", draft: server });
    expect(hydrated.draft).toEqual(server);
    expect(hydrated.undo).toBeNull();
  });

  it("records the selected treatment and plan without touching the draft", () => {
    const s = chart(ready(), 16, ["mesial"]);
    const t = chartReducer(s, { kind: "select-treatment", code: "0000", name: "Bridge Abutment" });
    expect(t.activeTreatment).toEqual({ code: "0000", name: "Bridge Abutment" });
    expect(t.draft).toEqual(s.draft);
    const p = chartReducer(t, { kind: "select-plan", planId: "plan-1" });
    expect(p.activePlanId).toBe("plan-1");
    expect(p.draft).toEqual(s.draft);
  });

  it("keeps one entry per treatment on a tooth, so two treatments on one tooth do not overwrite each other", () => {
    const filling = chart(ready(), 16, ["mesial", "occlusal"]);
    const crowned = chartReducer(filling, {
      kind: "select-treatment",
      code: "0000",
      name: "Bridge Abutment",
    });
    const both = chart(crowned, 16, ["buccal"]);
    expect(both.draft[draftKey(16, "121")].surfaces).toEqual(["mesial", "occlusal"]);
    expect(both.draft[draftKey(16, "0000")].surfaces).toEqual(["buccal"]);
  });

  it("stamps each entry with the dentition it was charted on, so a hydrate can restore the right arch", () => {
    const s = chart(ready(), 16, ["mesial"]);
    expect(s.draft[draftKey(16, "121")]).toEqual({
      tooth: 16,
      surfaces: ["mesial"],
      treatmentCode: "121",
      treatmentName: "NHS Urgent Filling",
      dentition: "permanent",
    });
  });
});
