import { describe, it, expect } from "vitest";
import { accountsCaveats, leadCaveat } from "./caveats";
import type { AccountsPanel } from "@/lib/dashboard/view";

// ---------------------------------------------------------------------------
// F2 — A PERMANENT STRUCTURAL FACT SHIPPED AS A WARNING ON EVERY SCREEN.
//
// The unpaid reconciliation counts the gap between what the three site-scoped reads
// brought back and what `paid=false` says exists across the whole Dentally account.
// It shipped as `material: true` — warning glyph, and the entry `leadCaveat` puts
// against the headline figure — on the tacit assumption that a non-zero gap is an
// incident.
//
// ON THIS KEY IT IS THE RESTING STATE. The key reads an umbrella of five practices
// of which this client runs three, so the gap is dominated, permanently, by two
// practices' entire unpaid books: a large stable N that fires on every scope, on
// every assembly, for ever. A warning that is always on is a warning nobody reads,
// and it was crowding out the caveats that ARE events — a dropped balance row, a
// period that could not be read.
//
// AND THE SENTENCE NAMED TWO CAUSES AS IF THEY WERE EXHAUSTIVE. "filed under no
// site, or under a practice outside this group" is the whole story for the ALL-SITES
// scope. On a single practice it is not: that balance also excludes the sibling
// practices IN this group, and N was never measured against one site's book at all.
//
// The reconciliation maths and the null = "not checked" semantics are untouched.
// This is about what the screen SAYS about the number.
// ---------------------------------------------------------------------------

const panel = (over: Partial<AccountsPanel>): AccountsPanel => ({
  netBalancePence: { value: 1_000_00, reason: null },
  totalOwedPence: { value: 1_000_00, reason: null },
  patientsInDebt: { value: 3, reason: null },
  top: [],
  dropped: 0,
  unattributedUnpaid: null,
  siteId: null,
  ...over,
});

const find = (p: AccountsPanel) =>
  accountsCaveats(p).find((c) => c.id === "accounts-unattributed");

describe("F2: the unattributed-unpaid caveat is a standing footnote, not an alarm", () => {
  it("is INFORMATIONAL on the group scope, however large the gap", () => {
    const c = find(panel({ unattributedUnpaid: 3_800 }));
    expect(c).toBeTruthy();
    expect(
      c!.material,
      "a permanent structural gap is back to raising the warning glyph on every load",
    ).toBe(false);
  });

  it("is INFORMATIONAL on a single-practice scope too", () => {
    const c = find(panel({ unattributedUnpaid: 3_800, siteId: "site-cc" }));
    expect(c!.material).toBe(false);
  });

  it("never takes the mark beside the headline away from a caveat that IS an event", () => {
    // leadCaveat opens the first `material` entry. With this one demoted, a real
    // omission — balance rows the grammar refused — is what the reader is shown.
    const caveats = accountsCaveats(
      panel({ unattributedUnpaid: 3_800, dropped: 2 }),
    );
    expect(leadCaveat(caveats)?.id).toBe("accounts-dropped");
  });
});

describe("F2: the wording claims only what the read can stand behind", () => {
  it("on the group scope, names both causes without ranking or exhausting them", () => {
    const c = find(panel({ unattributedUnpaid: 3 }))!;
    expect(c.text).toContain("3 unpaid invoices");
    expect(c.text).toContain("umbrella of practices");
    expect(c.text).toContain("part of that gap is debt this group does not own");
    expect(c.text).toContain("part may be invoices filed under no site");
    // It is a standing fact, and the sentence says so rather than implying an event.
    expect(c.text).toContain("standing gap");
    expect(c.text).toContain("changes no figure");
  });

  it("on a single practice, says MORE than the counted rows is left out — the siblings included", () => {
    const c = find(panel({ unattributedUnpaid: 3, siteId: "site-cc" }))!;

    // The group-level count is still stated, but never as "what this balance excludes".
    expect(c.text).toContain("3 unpaid invoices");
    expect(
      c.text,
      "a single-site scope was told the group-level gap is everything it is missing",
    ).toContain("more than that is left out");
    expect(
      c.text,
      "the in-group siblings — invisible to a single practice's balance — went unsaid",
    ).toContain("the other practices in this group are excluded here by design too");

    // AND IT MUST NOT REPEAT THE TWO-CAUSE SENTENCE, which is only exhaustive for the
    // all-sites scope.
    expect(c.text).not.toContain("filed under no site");
  });

  it("says nothing at all when the reconciliation found no gap", () => {
    expect(find(panel({ unattributedUnpaid: 0 }))).toBeUndefined();
    expect(find(panel({ unattributedUnpaid: 0, siteId: "site-cc" }))).toBeUndefined();
  });

  it("CONTROL: null is 'not checked' and stays silent, on every scope", () => {
    expect(find(panel({ unattributedUnpaid: null }))).toBeUndefined();
    expect(find(panel({ unattributedUnpaid: null, siteId: "site-cc" }))).toBeUndefined();
  });

  it("CONTROL: it still changes no figure on the panel", () => {
    const p = panel({ unattributedUnpaid: 3_800 });
    const before = { ...p };
    accountsCaveats(p);
    expect(p).toEqual(before);
  });
});
