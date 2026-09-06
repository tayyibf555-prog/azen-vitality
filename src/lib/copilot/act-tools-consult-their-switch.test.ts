import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { ACT_DOMAINS, TOOL_DOMAIN } from "./clearance";
import type { CopilotToolName } from "./scope";
import { SYSTEM_BY_SLUG } from "@/lib/systems/catalog";

// ===========================================================================
// EVERY CO-PILOT ACT ANSWERS TO A SWITCH, OR SAYS IN WRITING WHY IT HAS NONE.
//
// The co-pilot is deliberately absent from the systems catalog and is
// NAV_SWITCH_EXEMPT: switching a module off hides its workspace and leaves the
// conversation reachable. That is the right shape — an owner still wants to ask
// about a system they have paused — but it means the ONLY thing standing between
// "Meta Ads is off" and "publish the implant campaign" is whether the tool's own
// case remembered to read the toggle. Ruling W3/2 settled the principle for the
// diary ("a co-pilot Dentally write carries the PER-MODULE slug of the module it
// acts in") and W3/19 applied it to creating a patient; this sweep is what makes
// the principle checkable for the whole act catalog rather than for the two
// tools somebody happened to look at.
//
// IT WAS NOT CHECKABLE BEFORE, AND THAT COST A REAL GAP. clearance.ts's
// kill-switch bullet named three acting tools — nudge_lead,
// launch_outreach_campaign, publish_meta_campaign — as tools that "consult the
// system's switch inside tools.ts and refuse when its system is off". Two of the
// three did. The third read no toggle at all, and the sentence naming it is
// exactly what stopped the next reader looking. clearance.test.ts had already
// had to correct that same paragraph once, for nudge_lead, which is how much
// warning there was.
//
// THREE OUTCOMES PER ACT TOOL, and every act tool must be in exactly one of
// them, so a tool added to the catalog without a decision cannot compile past
// this file:
//
//   READS_SLUG     the case body names the catalog slug it acts under.
//   THROUGH_GATE   the case makes a Dentally write, so the slug is resolved by
//                  the write gate from the write registry (writeSlugFor) rather
//                  than typed here — W3/2's own mechanism.
//   NO_SLUG        a NAMED, CITED exemption: there is no system in the catalog
//                  for what this tool does. Each entry states why, and the
//                  reasons are load-bearing rather than decorative.
//
// A SOURCE CRAWL, on purpose. The alternative — driving all fourteen acts with
// every switch off — needs fourteen fixtures of mocked repositories and proves
// the same thing about the same lines, while going green the moment a new tool
// is added without a fixture. The behavioural half is pinned per tool where it
// belongs (landing-meta-tools.test.ts for the Meta publish, outreach-tools.
// test.ts for the campaign launch, nudge-fail-direction.test.ts for the lead
// nudge, w2a-tools.test.ts and diary-write-preview.test.ts for the diary); what
// no per-tool test can do is notice the tool nobody wrote a test for.
// ===========================================================================

const SOURCE = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");

/** Which catalog slug each acting tool must be seen to read. */
const READS_SLUG: Partial<Record<CopilotToolName, string>> = {
  // The lead nudge puts a message in front of a person: the SEND door's reader,
  // which fails CLOSED once messaging is live (ruling W1-B/1-5).
  nudge_lead: "speed-to-lead",
  // Launching a segment campaign starts a queue of patient messages.
  launch_outreach_campaign: "outreach",
  // Publishing creates a campaign, an ad set, a creative and an ad in the
  // practice's real Meta account. The STRICT reader, matching the module's other
  // spending surface (POST /api/meta-ads/recreate).
  publish_meta_campaign: "meta-ads",
};

/** Acting tools whose slug is resolved by the write gate, from the registry. */
const THROUGH_GATE: Partial<Record<CopilotToolName, string>> = {
  // W3/19: creating a patient IS the onboarding module's job, whichever door
  // asks. The slug comes off DENTALLY_WRITE_SOURCES.copilot.slugByKind.
  create_patient: "the write gate resolves `onboarding` for patient.create (W3/19)",
  // W3/2: the three diary kinds resolve `calendar-writes`, and the case reads it
  // explicitly for its own preview sentence as well.
  diary_write: "writeSlugFor('copilot', kind) -> calendar-writes (W3/2)",
};

/**
 * Acting tools with NO system of their own — each with the reason, because an
 * unexplained exemption is how a gap gets normalised.
 */
const NO_SLUG: Partial<Record<CopilotToolName, string>> = {
  send_sms:
    "There is no 'manual send' system in the catalog. The co-pilot is deliberately absent from it (write-vocabulary.ts's `copilot` entry states this in full): it is an owner in a session behind a two-step confirm, not a sweep with a queue to halt. The locks are the module guard, the `system.copilot.ask` capability on /api/copilot, the clearance act domain `patient-send`, the same-turn confirm floor in run.ts, suppression, the daily cap and MESSAGING_DRY_RUN.",
  send_email: "As send_sms: one owner-typed message behind a confirm, with no sweep to switch off.",
  create_outreach_campaign:
    "Builds a DRAFT campaign in this platform's own tables and sends nothing. Its launching sibling carries the `outreach` switch, which is the step that starts messages.",
  create_landing_page:
    "Landing pages have no slug in the systems catalog at all — there is no system to switch off, so there is nothing to read. It creates a draft; publishing is launch_landing_page.",
  launch_landing_page:
    "Same absence: no landing-page system exists in the catalog. Publishing a page of our own marketing is not an act on a practice system, and the act domain `marketing-publish` is the lock.",
  create_meta_campaign:
    "Assembles a DRAFT in this platform's own tables: nothing is created in the practice's Meta account and nothing is spent. The publishing door carries the `meta-ads` switch. LEDGER for a later round: a draft still costs a model call and lands in a workspace the switch hides, which is an argument for reading the switch here too — the same argument /api/meta-ads/recreate makes about its own model call. Not decided in a review round.",
};

/**
 * The body of one `case "<tool>":` block in the dispatch's switch.
 *
 * Stacked labels (`case "send_sms":` immediately followed by `case
 * "send_email": {`) share one body, so an empty span falls through to the next.
 */
function caseBody(tool: string): string {
  const labels = [...SOURCE.matchAll(/^ {8}case "([a-z_]+)":/gm)].map((m) => ({
    name: m[1],
    at: m.index ?? 0,
  }));
  const i = labels.findIndex((l) => l.name === tool);
  if (i < 0) return "";
  const start = labels[i].at;
  const end = i + 1 < labels.length ? labels[i + 1].at : SOURCE.length;
  const body = SOURCE.slice(start, end);
  // A stacked label: no body of its own, so the decision is made in the next one.
  if (body.replace(/^ {8}case "[a-z_]+":\s*/, "").trim().length === 0 && i + 1 < labels.length) {
    return caseBody(labels[i + 1].name);
  }
  return body;
}

const ACT_TOOLS = (Object.keys(TOOL_DOMAIN) as CopilotToolName[]).filter(
  (t) => TOOL_DOMAIN[t].kind === "act",
);

describe("every acting co-pilot tool answers to a kill switch, or is a named exemption", () => {
  it("EVERY act tool is classified — a new one cannot slip through unclassified", () => {
    const unclassified = ACT_TOOLS.filter(
      (t) => !(t in READS_SLUG) && !(t in THROUGH_GATE) && !(t in NO_SLUG),
    );
    expect(
      unclassified,
      "a new acting tool must be given a slug to read, a gate to go through, or a written reason it has neither",
    ).toEqual([]);
    // ...and nothing is classified twice, which would let one list's rule hide
    // the other's failure.
    for (const tool of ACT_TOOLS) {
      const lists = [tool in READS_SLUG, tool in THROUGH_GATE, tool in NO_SLUG].filter(Boolean);
      expect(lists.length, `${tool} is in more than one list`).toBe(1);
    }
    // The domain enumeration is the source of the list, so a new act domain with
    // no tool is visible here too.
    expect(ACT_DOMAINS.length).toBeGreaterThan(0);
    expect(ACT_TOOLS.length).toBeGreaterThan(5);
  });

  it("a tool that must read a slug READS IT, in its own case, and the slug is real", () => {
    for (const [tool, slug] of Object.entries(READS_SLUG)) {
      const body = caseBody(tool);
      expect(body.length, `no case body found for ${tool}`).toBeGreaterThan(0);
      expect(body, `${tool} never names the "${slug}" switch`).toContain(`"${slug}"`);
      expect(
        /isSystemEnabled(ForSend|Strict)?\(/.test(body),
        `${tool} names "${slug}" but never asks the systems layer about it`,
      ).toBe(true);
      // A slug nobody can see in System controls is a switch the owner cannot
      // flip, so the tool would refuse forever with no way back.
      expect(SYSTEM_BY_SLUG.has(slug), `"${slug}" is not a system in the catalog`).toBe(true);
    }
  });

  it("THE SPENDING DOOR READS IT STRICTLY: an unreadable toggle is OFF, not ON", () => {
    // `meta-ads` is a default-ON slug, so the fail-open reader would resolve a
    // failed toggle read to "enabled" and authorise objects in the practice's
    // real ad account. Same posture as POST /api/meta-ads/recreate, the module's
    // other spending surface.
    const body = caseBody("publish_meta_campaign");
    expect(body).toContain('isSystemEnabledStrict(clientId, "meta-ads")');
    expect(body).not.toContain('isSystemEnabled(clientId, "meta-ads")');
    // ...and the refusal happens before anything is created on Meta.
    expect(body.indexOf('isSystemEnabledStrict(clientId, "meta-ads")')).toBeLessThan(
      body.indexOf("await publishCampaign("),
    );
  });

  it("a tool that writes to Dentally lets THE GATE resolve its slug (W3/2, W3/19)", () => {
    // Typing the slug into the tool would be a second reading of the write
    // registry, and the two would disagree the day one of them was edited.
    for (const tool of Object.keys(THROUGH_GATE)) {
      const body = caseBody(tool);
      expect(body.length, `no case body found for ${tool}`).toBeGreaterThan(0);
      expect(
        /dentallyWrite|writeSlugFor|performMove/.test(body),
        `${tool} claims to write through the gate but names none of its entry points`,
      ).toBe(true);
    }
    // diary_write additionally reads the resolved slug itself, for the sentence
    // the owner confirms against.
    expect(caseBody("diary_write")).toContain('writeSlugFor("copilot"');
  });

  it("every exemption STATES ITS REASON, at length", () => {
    // A one-word exemption is how a gap gets normalised. These are the sentences
    // a future reviewer will read instead of re-deriving the answer.
    for (const [tool, why] of Object.entries(NO_SLUG)) {
      expect(why.length, `${tool}'s exemption is too short to be a reason`).toBeGreaterThan(80);
    }
    // And the two send doors are exempt for a REASON ABOUT SWEEPS, not because
    // sends are unimportant: the fail-closed send discipline lives on the
    // messaging layer they call, not on a per-tool toggle.
    expect(NO_SLUG.send_sms).toMatch(/two-step confirm/);
    expect(NO_SLUG.send_sms).toMatch(/MESSAGING_DRY_RUN/);
  });
});
