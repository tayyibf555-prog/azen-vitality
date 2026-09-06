// ===========================================================================
// THE CHARTER IS A DELIVERABLE TOO, AND ONE OF ITS SENTENCES HAD ROTTED.
//
// docs/superpowers/plans/2026-09-03-dental-os-program.md is, in its own words,
// "the single spec every lane reads first and the checklist the final audit is
// scored against", and "if a lane's brief and this file disagree, this file
// wins". That makes a stale line in it more dangerous than a stale line in any
// other document in the tree: it does not merely mislead a reader, it instructs
// the next lane.
//
// ---------------------------------------------------------------------------
// WHAT WENT WRONG, AND WHY NOTHING WENT RED.
// ---------------------------------------------------------------------------
// The W1-C brief asked for the pre-visit link "sent with the medical-history
// link". The module deliberately did the opposite and ruling W3/9 (5 Sep 2026)
// made the opposite law — "copy matches code, never the reverse": two links do
// not fit in one SMS credit, so `previsitBody` composes ONE standalone message
// with one short database-id link and the handover to the medical-history form
// moved into the journey (the `/pv` completion screen). Every DERIVED surface
// was then corrected and pinned — the roster's `firstTick` (roster.test.ts), the
// nav note, the control panel, the runbook (runbook.test.ts §3). The SPEC the
// four of them are derived from was not, because it was the one copy of the
// sentence no test read. A wave-4 audit scoring §2 line by line would have
// recorded W1-C's delivery as NOT MET against working code; a later lane, told
// the charter wins over its own brief, could have "fixed" the shipped behaviour
// back to two links.
//
// So this file closes the loop the other three tests leave open, and it closes
// it against the CODE rather than against another sentence: the charter's claim
// is read out of the file and measured against what `previsitBody` actually
// composes. Prose and behaviour go red together or not at all.
//
// The precedent for keeping the charter itself in step is §0 item 7, reworded in
// place by ruling W3/36 with an explicit "do not fix this again" note. This
// bullet now carries the same treatment.
// ===========================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { previsitBody } from "@/lib/triage/copy";
import { SRC_ROOT } from "@/lib/test-support/walk-src";

const REPO_ROOT = join(SRC_ROOT, "..");
const CHARTER = "docs/superpowers/plans/2026-09-03-dental-os-program.md";

const md = readFileSync(join(REPO_ROOT, CHARTER), "utf8");

/**
 * One numbered lane's section of §2, from its heading to the next one. The
 * charter is prose that gets re-wrapped, so callers flatten before matching a
 * phrase: where an author broke a line is not a fact about the programme.
 */
function laneSection(heading: string): string {
  const start = md.indexOf(`### ${heading}`);
  expect(start, `the charter no longer has a section headed: ${heading}`).toBeGreaterThan(-1);
  const next = md.indexOf("\n### ", start + 1);
  return md.slice(start, next === -1 ? md.length : next);
}

/** The one bullet under W1-C that describes how the invite reaches the patient. */
function deliveryBullet(): string {
  const section = laneSection("W1-C Triage + interest forms");
  const start = section.indexOf("- Delivery:");
  expect(start, "the charter's W1-C section no longer has a Delivery bullet").toBeGreaterThan(-1);
  const next = section.indexOf("\n- ", start + 1);
  return section.slice(start, next === -1 ? section.length : next).replace(/\s+/g, " ");
}

describe("the charter's W1-C delivery bullet states what the module ships (W3/9)", () => {
  it("describes the invite as its own text, separate from the medical-history link", () => {
    const bullet = deliveryBullet();

    // The two positive claims, in the words the roster and the runbook use, so
    // that a reader comparing the four surfaces reads one sentence four times.
    expect(bullet).toContain("its own text");
    expect(bullet).toMatch(/separate from the medical-history\s+link/i);
  });

  it("does not tell the next lane to send the invite with the medical-history link", () => {
    // THE ORIGINAL DEFECT, in the exact shape it had. The charter said "a link
    // sent with the medical-history link"; the negative has to survive a rewrap,
    // hence the flattened bullet, and it has to survive a synonym, hence the
    // alternation — roster.test.ts guards its own sentence the same way.
    //
    // QUOTED HISTORY IS NOT AN INSTRUCTION. The bullet names the wording W3/9
    // replaced, in quotation marks, exactly as §0 item 7 names the phrase W3/36
    // replaced — that is how a reader knows which sentence was retired and why
    // not to write it again. Only unquoted prose instructs, so quoted spans are
    // blanked before the match; anything outside them still trips it.
    const bullet = deliveryBullet();
    const asInstruction = bullet.replace(/"[^"]*"/g, '""');
    const instruction = /\b(sent with|alongside|along with|together with|riding on)\b[^.]{0,60}medical-history/i;
    expect(
      instruction.test(asInstruction),
      `ruling W3/9 forbids the charter from describing the pre-visit invite as travelling with ` +
        `the medical-history link; the bullet reads: ${bullet}`,
    ).toBe(false);
  });

  it("cites the ruling that reworded it, so a later lane restores the brief instead of the code", () => {
    // Without the citation the bullet is just one lane's opinion against the
    // brief, and the brief is what a fresh reader trusts. §0 item 7 carries its
    // W3/36 citation for exactly this reason.
    expect(deliveryBullet()).toContain("W3/9");
  });

  it("agrees with the message the code actually composes: one link, and no second form named", () => {
    // THE POINT OF THE WHOLE FILE. The charter is measured against `previsitBody`
    // rather than against another document, so the day the module starts sending
    // two links this test fails on the prose as well as the behaviour.
    const body = previsitBody({
      firstName: "Ayesha",
      practiceName: "Vitality Dental",
      link: "https://azen-vitality.vercel.app/pv/aBcDeFgHiJkLmNoPqRsTuV",
    });

    expect(body.match(/https?:\/\//g) ?? []).toHaveLength(1);
    expect(body).not.toMatch(/medical/i);
    expect(body).not.toMatch(/history/i);
  });
});
