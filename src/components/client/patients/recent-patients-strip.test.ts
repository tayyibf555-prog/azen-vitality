import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import type { RecentPatientRow } from "@/lib/patient-recents/cap";
import { RecentPatientsStrip } from "./recent-patients-strip";

// ===========================================================================
// THE STRIP, PROVEN BY RENDERING IT.
//
// vitest collects only src/**/*.test.ts, so a .tsx file cannot BE a test — but a
// .ts test can import one and react-dom/server will render it, which is the
// arrangement tab-correspondence.test.ts already uses on the record.
//
// WHY THE FAILED READ IS THE CASE WORTH A TEST. The dangerous version of this
// feature is not one that shows the wrong eight names; it is one that answers a
// question it was never asked. "You have not opened any patients yet" is a claim
// about a user's own history, and a database read that threw has no standing to
// make it. The `ok` flag exists to carry that difference all the way from the
// repository to this component, and the check below is what stops it being
// optimised away by somebody who notices that both branches return null today.
// ===========================================================================

const ROW: RecentPatientRow = {
  patientId: "pat-1",
  name: "Sarah Ahmed",
  siteId: "site-cc",
  viewedAt: "2026-08-31T09:00:00.000Z",
};

function render(props: Parameters<typeof RecentPatientsStrip>[0]): string {
  return renderToStaticMarkup(createElement(RecentPatientsStrip, props));
}

describe("a failed read never speaks for the user", () => {
  it("renders nothing when the recents read FAILED, even with rows in hand", () => {
    // The rows are present ON PURPOSE. A failed read from the repository carries
    // an empty list, so testing `ok:false` with no rows would pass just as well
    // against a component that had lost its ok check entirely — the emptiness
    // alone would hide the strip. Rows present is what makes THIS test the one
    // that goes red if the `!read.ok` guard is deleted.
    const out = render({ read: { ok: false, patients: [ROW] }, basePath: "/c/vitality" });
    expect(out).toBe("");
    expect(out).not.toContain("Sarah Ahmed");
  });

  it("makes no claim about the user's history when the read failed", () => {
    // The specific sentence this feature must never print off the back of an
    // outage, spelled out rather than referenced, so the assertion cannot be
    // satisfied by a constant that changed.
    const out = render({ read: { ok: false, patients: [] }, basePath: "/c/vitality" });
    expect(out).not.toContain("Recently opened");
    expect(out.toLowerCase()).not.toContain("not opened any patients");
  });
});

describe("an honestly empty list is silent too", () => {
  it("renders nothing when the read succeeded and found no patients", () => {
    // A first-time user, or one scoped to a site they have opened nobody at. An
    // empty labelled strip would be furniture teaching the reader to ignore that
    // part of the screen before it ever has anything in it.
    expect(render({ read: { ok: true, patients: [] }, basePath: "/c/vitality" })).toBe("");
  });
});

describe("a good read renders real links", () => {
  it("links each recent patient into the basePath tree it was given", () => {
    // An owner clicking a recent patient must stay in the owner tree, exactly as
    // the patients table below the strip already guarantees.
    const out = render({ read: { ok: true, patients: [ROW] }, basePath: "/owner/vitality" });
    expect(out).toContain("Recently opened");
    expect(out).toContain("Sarah Ahmed");
    expect(out).toContain('href="/owner/vitality/patients/pat-1"');
    expect(out).not.toContain('href="/c/vitality/patients/pat-1"');
  });

  it("url-encodes a patient id rather than pasting it into the path", () => {
    const out = render({
      read: { ok: true, patients: [{ ...ROW, patientId: "pat 1/2" }] },
      basePath: "/c/vitality",
    });
    expect(out).toContain('href="/c/vitality/patients/pat%201%2F2"');
  });
});
