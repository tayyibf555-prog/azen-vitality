import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { BankPanel, draftToQuestion, dropReason } from "./bank-editor";
import { TRIAGE_BANK, defaultConfigFor } from "@/lib/triage/bank";
import { projectBank, usableCustom } from "@/lib/triage/project";
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

// ===========================================================================
// THE PRACTICE'S OWN QUESTIONS (wave-3 review, 4 September 2026).
//
// THE DEFECT this pins: `TriageCustomQuestion` is documented as "a question the
// practice wrote itself, IN THE OWNER EDITOR", and every layer under that
// sentence shipped — the ten-question cap and the per-question refusal in the
// PUT route, `usableCustom`, the W3/3 scan over custom option labels AND values,
// `resolveAnswerKind`'s custom index, `UNKNOWN_ANSWER_KIND` failing to
// restricted. The editor was the missing half: it rendered the shipped library
// as switches and posted `bank.config` straight back, so `config.custom` could
// only round-trip. The owner could not write one, could not remove one, and — the
// sharper half — a custom question already STORED was invisible here while being
// asked of patients, because the panel iterates the shipped library and custom
// questions do not live in it.
// ===========================================================================

const CUSTOM: TriageBankConfig["custom"][number] = {
  key: "custom-parking",
  label: "Do you know where to park?",
  type: "yesno",
  kind: "logistics",
  required: false,
};

describe("a question the practice wrote is visible, and can be written and removed", () => {
  it("shows a stored custom question, which the library-only list never did", () => {
    const config: TriageBankConfig = { ...defaultConfigFor("full"), custom: [CUSTOM] };
    const markup = text(render("full", config));
    expect(markup).toContain("Do you know where to park?");
    expect(markup).toContain("Yes / no");
    expect(markup).toContain("Getting to the appointment");
  });

  it("offers a way to remove it", () => {
    const config: TriageBankConfig = { ...defaultConfigFor("full"), custom: [CUSTOM] };
    expect(text(render("full", config))).toContain('Remove "Do you know where to park?"');
  });

  it("offers the form that writes one, with every answer type usableCustom accepts", () => {
    const markup = text(render("full", defaultConfigFor("full")));
    expect(markup).toContain("Your own questions");
    expect(markup).toContain("Add this question");
    for (const label of ["Short answer", "Longer answer", "Multiple choice", "Yes / no", "0 to 10"]) {
      expect(markup, `no ${label} option`).toContain(label);
    }
  });

  it("says what the classification costs, next to the picker rather than after a save", () => {
    const markup = text(render("full", defaultConfigFor("full")));
    expect(markup).toContain("only asked on the longer list");
    expect(markup).toContain("it is not asked");
  });

  it("counts what has been written against the cap", () => {
    const config: TriageBankConfig = { ...defaultConfigFor("full"), custom: [CUSTOM] };
    expect(text(render("full", config))).toContain("1 written so far");
  });

  it("warns about the fallback that would silently discard them", () => {
    // `usableConfig` falls back to the fork's shipped defaults whenever
    // `enabledKeys` is empty, and the fallback replaces the WHOLE config — the
    // stored `custom` array goes with it. Until that is fixed in the projection,
    // the editor says so rather than letting somebody find out from an empty form.
    const config: TriageBankConfig = { enabledKeys: [], required: {}, custom: [CUSTOM] };
    const markup = text(render("full", config));
    expect(markup).toContain("Keep at least one of the questions above switched on");
  });

  it("does not warn when a shipped question is still on", () => {
    const config: TriageBankConfig = { ...defaultConfigFor("full"), custom: [CUSTOM] };
    expect(text(render("full", config))).not.toContain("Keep at least one of the questions above");
  });

  it("survives a config with no custom array at all", () => {
    // Legacy rows predate the field. A panel that threw on one would take the
    // whole editor down for the practice that has never used it.
    const config = { ...defaultConfigFor("full"), custom: undefined } as unknown as TriageBankConfig;
    expect(text(render("full", config))).toContain("Your own questions");
  });
});

describe("a draft becomes a question, or says why it does not", () => {
  const draft = {
    label: "Do you know where to park?",
    type: "yesno" as const,
    kind: "logistics" as const,
    optionsText: "",
    required: false,
  };

  it("mints the custom- key usableCustom demands", () => {
    const out = draftToQuestion(draft, []);
    expect("question" in out && out.question.key).toBe("custom-do-you-know-where-to-park");
  });

  it("suffixes rather than colliding with a question already written", () => {
    const out = draftToQuestion(draft, ["custom-do-you-know-where-to-park"]);
    expect("question" in out && out.question.key).toBe("custom-do-you-know-where-to-park-2");
  });

  it("refuses a question with no words in it", () => {
    const out = draftToQuestion({ ...draft, label: "   " }, []);
    expect("error" in out && out.error).toMatch(/Write the question/);
  });

  it("refuses a multiple choice with nothing to choose between", () => {
    const out = draftToQuestion({ ...draft, type: "choice", optionsText: "Yes" }, []);
    expect("error" in out && out.error).toMatch(/at least two answers/);
  });

  it("gives every option a distinct value even when two read the same", () => {
    const out = draftToQuestion({ ...draft, type: "choice", optionsText: "Yes\nYes\nNo" }, []);
    const options = "question" in out ? out.question.options ?? [] : [];
    expect(options.map((o) => o.value)).toEqual(["yes", "yes-2", "no"]);
    expect(new Set(options.map((o) => o.value)).size).toBe(options.length);
  });

  it("produces a key the server's own validator accepts", () => {
    // The rule that matters is `usableCustom`'s, not this screen's: a key it
    // refuses is a save the owner cannot make, and the editor would be offering
    // a control that always fails.
    for (const label of ["Do you know where to park?", "Parking!!!", "Sí, ¿aparcamiento?"]) {
      const out = draftToQuestion({ ...draft, label }, []);
      expect("question" in out, label).toBe(true);
      if ("question" in out) {
        expect(usableCustom(out.question), `usableCustom refused "${label}"`).not.toBeNull();
      }
    }
  });

  it("produces a choice question the server's validator accepts", () => {
    const out = draftToQuestion({ ...draft, type: "choice", optionsText: "Yes\nNo\nNot sure" }, []);
    expect("question" in out).toBe(true);
    if ("question" in out) expect(usableCustom(out.question)).not.toBeNull();
  });
});

describe("the editor's cap is the route's cap", () => {
  it("MAX_CUSTOM matches src/app/api/previsit/bank/route.ts", () => {
    // The route slices the incoming array at its own figure, so a higher number
    // in the browser would drop the eleventh question after the owner typed it,
    // with no error anywhere.
    const source = readFileSync(join(process.cwd(), "src/app/api/previsit/bank/route.ts"), "utf8");
    const declared = source.match(/const MAX_CUSTOM\s*=\s*(\d+)/);
    expect(declared, "the MAX_CUSTOM scan went stale").toBeTruthy();
    const panel = readFileSync(join(process.cwd(), "src/components/client/previsit/bank-editor.tsx"), "utf8");
    const mine = panel.match(/const MAX_CUSTOM\s*=\s*(\d+)/);
    expect(mine, "the editor no longer declares a cap").toBeTruthy();
    expect(mine![1], "the editor's cap drifted from the route's").toBe(declared![1]);
  });

  it("the form is closed once the cap is reached", () => {
    const custom = Array.from({ length: Number(10) }, (_, i) => ({ ...CUSTOM, key: `custom-q${i}` }));
    const markup = render("full", { ...defaultConfigFor("full"), custom });
    // The add button is disabled, not hidden: an absent control reads as a
    // missing feature, a disabled one beside "Up to 10" reads as a limit.
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>\s*Add this question/);
  });
});
