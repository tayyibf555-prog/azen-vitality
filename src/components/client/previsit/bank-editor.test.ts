import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { BankPanel, dropReason } from "./bank-editor";
import { TRIAGE_BANK, defaultConfigFor } from "@/lib/triage/bank";
import { projectBank } from "@/lib/triage/project";
import type { TriageBankConfig, TriageFork } from "@/lib/triage/types";

// ===========================================================================
// THE OWNER EDITOR'S ONE JOB BEYOND SWITCHES: telling the owner when a question
// they have switched on is NOT being asked, and which word stopped it.
//
// A silent drop would be intolerable. The owner would switch a symptom question
// onto the short list, see it in their own list, and never learn that no patient
// was ever asked it — and the first person to notice would report the guard as a
// bug. So the refusal explains itself, and this file proves the explanation
// reaches the screen.
//
// BankPanel is the presentational half: every piece of state arrives as a prop,
// so each screen is renderable rather than reachable only by clicking.
// ===========================================================================

function bankState(fork: TriageFork, config: TriageBankConfig) {
  const projected = projectBank(fork, config);
  return {
    fork,
    isDefault: false,
    config,
    updatedAt: null,
    updatedBy: null,
    questions: projected.questions,
    dropped: projected.dropped,
  };
}

function render(
  fork: TriageFork,
  config: TriageBankConfig,
  over: Partial<Parameters<typeof BankPanel>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(BankPanel, {
      bank: bankState(fork, config),
      library: [...TRIAGE_BANK],
      busy: false,
      saved: false,
      error: null,
      onChange: () => {},
      onSave: () => {},
      ...over,
    }),
  );
}

function text(markup: string): string {
  return markup.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

describe("the editor renders both banks", () => {
  it.each(["full", "brief"] as const)("renders the %s bank with a switch per question", (fork) => {
    const markup = render(fork, defaultConfigFor(fork));
    // One switch per non-grid question in the whole catalogue, because the owner
    // can switch ANY of them on for EITHER bank; what stops a symptom question
    // reaching the short list is the projection, not a hidden control.
    const switches = markup.split('role="switch"').length - 1;
    expect(switches).toBeGreaterThanOrEqual(TRIAGE_BANK.filter((q) => q.type !== "interest").length);
    expect(markup).toContain("Are you still able to come to your appointment?");
  });

  it("says the treatment questions are always asked and always refusable", () => {
    const markup = text(render("brief", defaultConfigFor("brief")));
    expect(markup).toContain("cannot be switched off here");
    expect(markup).toContain("Not right now");
  });

  it("says when a bank has never been edited, so a default reads as a default", () => {
    const markup = render("brief", defaultConfigFor("brief"), {
      bank: { ...bankState("brief", defaultConfigFor("brief")), isDefault: true },
    });
    expect(text(markup)).toContain("never been edited");
  });
});

describe("the owner-facing note on the anxiety question", () => {
  it("is shown to the OWNER in the editor, on both banks", () => {
    for (const fork of ["full", "brief"] as const) {
      const markup = text(render(fork, defaultConfigFor(fork)));
      expect(markup, `the note is missing from the ${fork} editor`).toContain("contract adviser");
      // Owner-facing, so naming the funding regime here is correct and required:
      // the owner has to know which patients the decision affects.
      expect(markup).toContain("NHS-plan patients");
    }
  });

  it("the question it belongs to is switchable for the short bank", () => {
    // The note would be pointless if the owner could not act on it. Asserted on the
    // RAW markup, not the de-entitied text: the aria-label embeds &quot; around the
    // question, and un-escaping it first would break the match for the wrong reason.
    const raw = render("brief", defaultConfigFor("brief"));
    expect(text(raw)).toContain("How do you feel about coming to the dentist?");
    expect(raw).toContain('aria-label="Ask &quot;How do you feel about coming to the dentist?&quot;"');
    // ...and it ships OFF for this bank, which is the default half of the ruling.
    expect(raw).toMatch(
      /aria-checked="false" aria-label="Ask &quot;How do you feel about coming to the dentist\?&quot;"/,
    );
  });
});

describe("a refused question explains itself, ON SCREEN", () => {
  const withSymptom: TriageBankConfig = {
    enabledKeys: [...defaultConfigFor("brief").enabledKeys, "pain-now"],
    required: {},
    custom: [],
  };

  it("names the count, so a refusal cannot be scrolled past as decoration", () => {
    const markup = text(render("brief", withSymptom));
    expect(markup).toContain("One question on this list is not being asked");
  });

  it("names the QUESTION that was refused", () => {
    const markup = text(render("brief", withSymptom));
    expect(markup).toContain("Right now, how uncomfortable is it?");
  });

  it("names the exact word that stopped a mis-classified custom question", () => {
    const config: TriageBankConfig = {
      enabledKeys: defaultConfigFor("brief").enabledKeys,
      required: {},
      custom: [
        {
          key: "custom-hurting",
          label: "Is anything hurting before you come in?",
          type: "yesno",
          kind: "logistics",
          required: false,
        },
      ],
    };
    const markup = text(render("brief", config));
    expect(markup).toContain('it uses the word "hurting"');
    expect(markup).toContain("this list does not ask about symptoms");
  });

  it("says nothing at all when nothing was refused", () => {
    const markup = text(render("brief", defaultConfigFor("brief")));
    expect(markup).not.toContain("not being asked");
  });

  it("the FULL bank refuses none of the symptom questions, so the panel stays quiet", () => {
    const markup = text(render("full", defaultConfigFor("full")));
    expect(markup).not.toContain("not being asked");
  });
});

describe("dropReason", () => {
  it("distinguishes the classification from the word", () => {
    expect(dropReason({ key: "k", label: "l", reason: "symptom-on-brief", matched: "symptom" })).toMatch(
      /asks about a symptom/i,
    );
    expect(dropReason({ key: "k", label: "l", reason: "symptom-on-brief", matched: "bleeding" })).toContain(
      '"bleeding"',
    );
  });

  it("has plain words for a funding refusal and for an unknown key", () => {
    expect(dropReason({ key: "k", label: "l", reason: "funding-word", matched: "NHS" })).toMatch(
      /patients must never be shown/i,
    );
    expect(dropReason({ key: "k", label: "l", reason: "unknown-key", matched: null })).toMatch(
      /not a question this platform knows about/i,
    );
  });
});

describe("the save states are all renderable", () => {
  const config = defaultConfigFor("brief");

  it("busy disables the button and says so", () => {
    const markup = render("brief", config, { busy: true });
    expect(markup).toContain("Saving");
    expect(markup).toMatch(/<button[^>]*disabled/);
  });

  it("saved shows a confirmation", () => {
    expect(render("brief", config, { saved: true })).toContain("Saved");
  });

  it("an error is announced to assistive technology, not just coloured red", () => {
    const markup = render("brief", config, { error: "Those settings were not saved." });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Those settings were not saved.");
  });
});
