import { describe, it, expect } from "vitest";
import { PLAYBOOKS, playbooksByArea, rankPlaybooks } from "./playbooks";
import { PLAYBOOK_AREAS } from "./types";

// ===========================================================================
// THE PLAYBOOKS ARE THE IT DESK'S KNOWLEDGE, SO THEY ARE TESTED LIKE KNOWLEDGE.
//
// Three things matter and the third is the one a normal test would skip:
//   1. all five areas the brief names are covered;
//   2. the ranker finds the right one from what a receptionist actually types;
//   3. NO STEP ANYWHERE CROSSES A LINE THIS MODULE HAS DRAWN. The gate refuses
//      credential and remote-access REQUESTS; it says nothing about what our own
//      shipped content offers, and content that suggested installing a remote
//      tool would put the parked decision in the product's own mouth.
// ===========================================================================

describe("1. coverage", () => {
  it("covers the five areas the module promises", () => {
    const areas = new Set(PLAYBOOKS.map((p) => p.area));
    expect([...PLAYBOOK_AREAS].filter((a) => !areas.has(a))).toEqual([]);
  });

  it("every playbook has a unique id, steps, symptoms and an escalation", () => {
    expect(new Set(PLAYBOOKS.map((p) => p.id)).size).toBe(PLAYBOOKS.length);
    for (const p of PLAYBOOKS) {
      expect(p.steps.length, p.id).toBeGreaterThanOrEqual(4);
      expect(p.symptoms.length, p.id).toBeGreaterThanOrEqual(3);
      // An agent that walks somebody to the end of a list and then stops is what
      // makes people give up on the tool and ring the engineer anyway.
      expect(p.escalation.length, p.id).toBeGreaterThan(40);
      expect(p.escalation, p.id).toMatch(/IT contact/i);
    }
  });

  it("groups by area for the page, in a stable order", () => {
    const grouped = playbooksByArea();
    expect(grouped.flatMap((g) => g.playbooks).length).toBe(PLAYBOOKS.length);
    expect(grouped.map((g) => g.area)).toEqual([...new Set(PLAYBOOKS.map((p) => p.area))]);
  });
});

describe("2. the ranker finds the right playbook from a receptionist's own words", () => {
  const CASES: [query: string, id: string][] = [
    ["the internet is down", "connectivity.no-internet"],
    ["wifi not working at reception", "connectivity.no-internet"],
    ["nothing comes out of the printer", "printing.wont-print"],
    ["there is a paper jam", "printing.wont-print"],
    ["printer says offline", "printing.wont-print"],
    ["I am locked out of my account", "accounts.locked-out"],
    ["my password does not work", "accounts.locked-out"],
    ["Dentally will not load", "dentally.cannot-access"],
    ["the diary will not open in Dentally", "dentally.cannot-access"],
    ["the iPad for the form is frozen", "devices.ipad-kiosk"],
    ["the check-in tablet is stuck", "devices.ipad-kiosk"],
  ];

  it.each(CASES)("%j finds %s", (query, id) => {
    const ranked = rankPlaybooks(query);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].playbook.id).toBe(id);
  });

  it("returns nothing for something no playbook covers, rather than a weak guess", () => {
    // The honest empty result is what lets the agent say what it can and cannot
    // help with instead of improvising a procedure for unknown hardware.
    expect(rankPlaybooks("the autoclave is showing E04")).toEqual([]);
    expect(rankPlaybooks("")).toEqual([]);
  });
});

describe("3. no shipped step crosses this module's own lines", () => {
  const allText = PLAYBOOKS.map((p) => [p.title, ...p.symptoms, ...p.steps, p.escalation].join(" "))
    .join(" ")
    .toLowerCase();

  it("never offers remote access or endpoint software", () => {
    // PARKED BY DECISION (charter §4). The gate refuses a REQUEST for it; this
    // asserts we do not OFFER it, which the gate cannot check.
    for (const banned of ["teamviewer", "anydesk", "logmein", "remote into", "remote control", "screen share", "install our"]) {
      expect(allText, banned).not.toContain(banned);
    }
  });

  it("never tells anyone to weaken a protection", () => {
    for (const banned of [
      "turn off the antivirus",
      "disable the firewall",
      "disable antivirus",
      "turn off two-factor",
      "disable two-factor",
      "skip the update",
    ]) {
      expect(allText, banned).not.toContain(banned);
    }
  });

  it("never asks for or hands over a credential, and says so where it matters", () => {
    expect(allText).not.toMatch(/tell (me|us) (your|the) password/);
    expect(allText).not.toMatch(/what is your password/);
    const accounts = PLAYBOOKS.find((p) => p.id === "accounts.locked-out");
    expect(accounts?.escalation).toMatch(/never ask you for a password/i);
    // And it heads off the workaround that actually happens in practices.
    expect(accounts?.steps.join(" ")).toMatch(/shared login breaks the audit trail/i);
  });

  it("says plainly that this platform cannot fix a Dentally outage", () => {
    const dentally = PLAYBOOKS.find((p) => p.id === "dentally.cannot-access");
    expect(dentally?.escalation).toMatch(/cannot fix a Dentally outage/i);
    expect(dentally?.escalation).toMatch(/nothing here changes anything in Dentally/i);
  });

  it("warns before a step that interrupts other people", () => {
    // Restarting the router mid-payment is a bigger problem than the one being
    // fixed, and the person following the steps cannot know that unless told.
    const connectivity = PLAYBOOKS.find((p) => p.id === "connectivity.no-internet");
    expect(connectivity?.steps.join(" ")).toMatch(/not do this mid-treatment|taking a payment/i);
  });
});
