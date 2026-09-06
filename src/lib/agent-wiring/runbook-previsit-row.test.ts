// §4 OF THE RUNBOOK AND THE CONTROL PANEL SAY THE SAME THING ABOUT AN
// UNREGISTERED SWEEP — INCLUDING THE ONE ROW WHERE THEY DIFFER.
//
// WHY THIS EXISTS. Four slugs have a switch and no cron job: the closer, balance
// reminders, post-op and pre-visit. src/components/client/systems/systems-view.tsx
// prints one warning for three of them ("… until then this system is on in name
// only") and a DIFFERENT one for `pre-visit-triage`, because rulings W3/8, W3/21
// and W3/27 gave that switch a second job: while it is on, the owner-only
// "Build / refresh candidates" scan on the pre-visit page can be run by hand, and
// while it is off that button is disabled and POST /api/previsit/mining-run
// refuses. An owner who reads "on in name only" switches the module back off —
// into the one state where the control he came for cannot be pressed.
//
// §0 item 3 of docs/runbooks/agent-switch-on.md already carries that exception
// (pinned by runbook.test.ts). §4 — the table a person opens when an agent looks
// dead, which is a different reader in a different mood — did not, and quoted only
// the clause the four rows share. This guard holds §4 to the panel too, in the
// same direction ruling W3/9 settles: copy matches code, never the reverse.
//
// ASSERTED AGAINST THE SCREEN'S OWN STRINGS AND THE SCHEDULER, NOT AGAINST A
// LITERAL THIS FILE INVENTED. If the panel's per-slug sentence is deleted, or the
// pre-visit sweep is finally registered so the whole distinction stops existing,
// this goes red and the runbook is edited with it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { slugsWithNoScheduledJob } from "@/lib/agent-wiring/scheduler";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const RUNBOOK = readFileSync(join(REPO_ROOT, "docs", "runbooks", "agent-switch-on.md"), "utf8");
const PANEL_PATH = "src/components/client/systems/systems-view.tsx";
const PANEL = readFileSync(join(REPO_ROOT, PANEL_PATH), "utf8");

/** The single §4 table row about a system that is on with no job behind it. */
function deadAgentRow(): string {
  const section = RUNBOOK.slice(RUNBOOK.indexOf("## 4. Where to look when an agent seems dead"));
  const line = section.split("\n").find((l) => l.startsWith("| Switched on, nothing happens, ever"));
  expect(line, "§4 no longer has a row for a switched-on agent with no cron job").toBeTruthy();
  return line!.replace(/\s+/g, " ");
}

describe("§4's unregistered-sweep row matches what the control panel prints", () => {
  it("still applies to the pre-visit questionnaire, which still has no job", () => {
    // The premise. If this ever fails, the fix is to delete the exception from
    // both surfaces, not to loosen the assertions below.
    expect(
      slugsWithNoScheduledJob(),
      "pre-visit-triage has a scheduled job now — §4's tail and the panel's per-slug sentence both go with it",
    ).toContain("pre-visit-triage");
  });

  it("names the control the pre-visit switch still opens, because the panel names it", () => {
    expect(
      PANEL,
      `${PANEL_PATH} no longer tells the owner what switching pre-visit on is still worth`,
    ).toContain("Build / refresh candidates");
    expect(
      deadAgentRow(),
      "§4 tells the reader an unregistered sweep does nothing, without §0's exception: pre-visit's switch is " +
        "what enables the owner-only Build / refresh candidates scan (W3/8, W3/21)",
    ).toContain("Build / refresh candidates");
  });

  it("keeps 'on in name only' for the three rows it is actually true of", () => {
    // The panel's DEFAULT warning ends with that phrase and its per-slug pre-visit
    // warning deliberately does not. §4 may repeat it only where the panel does.
    expect(PANEL, `${PANEL_PATH} no longer carries the default warning's phrase`).toContain(
      "on in name only",
    );
    const row = deadAgentRow();
    if (row.includes("on in name only")) {
      for (const named of ["closer", "collection", "post-op"]) {
        expect(
          row.toLowerCase(),
          `§4 repeats "on in name only" without saying it is the ${named} row it belongs to`,
        ).toContain(named);
      }
      const beforePhrase = row.slice(0, row.indexOf("on in name only"));
      expect(
        beforePhrase.lastIndexOf("pre-visit") < beforePhrase.lastIndexOf("closer"),
        '§4 attaches "on in name only" to the pre-visit row, which is the claim the panel was corrected for',
      ).toBe(true);
    }
  });
});
