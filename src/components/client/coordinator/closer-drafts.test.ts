import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import {
  CADENCE_LENGTH,
  CloserDraftCard,
  CloserDraftForm,
  CloserDraftsPanel,
  INITIAL_CARD_STATE,
  approveLabel,
  runApprove,
  runDiscard,
  type CloserCardBusy,
} from "./closer-drafts";
import { CoordinatorTabs } from "./coordinator-tabs";
import {
  CLOSER_DISCARD_EFFECT,
  CLOSER_DISCARD_LABEL,
  CLOSER_DISCARD_REASONS,
  discardOutcome,
  type CloserDiscardReason,
} from "@/lib/closer/discard";
import { CLOSER_CADENCE } from "@/lib/closer/cadence";
import type { CloserDraftView } from "@/lib/closer/types";

// ===========================================================================
// A PERSON CANNOT APPROVE WHAT THEY CANNOT READ.
//
// This screen is the only thing between the closer's drafts and a real patient's
// phone, so the failure that matters is not a crash — it is a screen that LOOKS
// like an approval step and is really a rubber stamp: a truncated message, a
// summary line with a "view" link, a Discard button that needs no reason.
//
// vitest collects only src/**/*.test.ts in the node environment, so no .tsx can BE
// a test. A .ts test can import one and render it with react-dom/server, which is
// what happens here: these are assertions about MARKUP. Effects do not run in a
// static render, which is exactly why the card is split into a presentational
// `CloserDraftForm` (every piece of state arrives as a prop) and a thin stateful
// wrapper — each state of the card is renderable and readable rather than
// reachable only by clicking.
// ===========================================================================

const NOW = "2026-08-21T10:00:00.000Z";

/** Deliberately long, multi-line, and carrying the plan's own figure: the three
 *  things a lazy renderer would clamp, collapse or hide. */
const LONG_BODY = [
  "Hi Sarah,",
  "",
  "Just checking in again about the composite bonding on your upper six, which comes to £780.",
  "",
  "I know we touched on ways to spread the cost before, but if you would like to go through the options again or ask any questions, I am happy to help.",
  "",
  "We are open seven days and have free parking on site, so it is easy to pop in whenever suits you.",
  "",
  "When you are ready, you can book here: https://example.test/book",
  "",
  "N15 Vitality Dental",
].join("\n");

const DRAFT: CloserDraftView = {
  touchId: "t-1",
  opportunityId: "site-ng:p1:pl1",
  patientName: "Sarah Ahmed",
  treatment: "Composite bonding, upper six",
  amountOutstanding: 780,
  step: 2,
  channel: "email",
  body: LONG_BODY,
  createdAt: "2026-08-20T09:00:00.000Z",
};

const NOOP = () => {};

function form(
  overrides: Partial<Parameters<typeof CloserDraftForm>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(CloserDraftForm, {
      draft: DRAFT,
      nowIso: NOW,
      body: DRAFT.body,
      busy: null,
      error: null,
      choosingReason: false,
      reason: null,
      onBodyChange: NOOP,
      onRevert: NOOP,
      onApprove: NOOP,
      onOpenDiscard: NOOP,
      onCancelDiscard: NOOP,
      onPickReason: NOOP,
      onConfirmDiscard: NOOP,
      ...overrides,
    }),
  );
}

/** The rendered <textarea>'s contents, which is where the message actually lives. */
function textareaBody(html: string): string {
  const m = /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html);
  return m ? m[1] : "";
}

/**
 * Whether an element carries the `disabled` ATTRIBUTE.
 *
 * Not `includes("disabled")`: every Tailwind control on this page carries
 * `disabled:opacity-60` / `disabled:pointer-events-none` in its class list, so the
 * naive check passes on a live control and would have made "Confirm is dead until
 * a reason is chosen" a test that could never fail. The class attribute is stripped
 * first, then the attribute is looked for on its own.
 */
function isDisabled(tag: string): boolean {
  const withoutClasses = tag.replace(/class="[^"]*"/g, "");
  return /\sdisabled(=|\s|>|$)/.test(withoutClasses);
}

function decode(s: string): string {
  return s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#xA3;/g, "£");
}

// ---------------------------------------------------------------------------
// 1. The message is fully shown, and it is editable.
// ---------------------------------------------------------------------------

describe("the whole message is on the screen, in full, and can be changed there", () => {
  it("renders every line of the draft, not a preview of it", () => {
    const html = form();
    const rendered = decode(textareaBody(html));
    expect(rendered).toBe(LONG_BODY);
    // Line by line, so a future "first paragraph only" cannot pass by accident.
    for (const line of LONG_BODY.split("\n").filter(Boolean)) {
      expect(rendered, `missing line: ${line}`).toContain(line);
    }
    // Including the last line, which is the one a clamp would eat.
    expect(rendered.trimEnd().endsWith("N15 Vitality Dental")).toBe(true);
  });

  it("never truncates or clamps the message", () => {
    const html = form();
    expect(html).not.toContain("line-clamp");
    expect(html).not.toContain("truncate\"");
    expect(html).not.toContain("…");
    expect(html).not.toContain("Read more");
    expect(html).not.toContain("View message");
  });

  it("the message box is EDITABLE at rest: edit-then-approve is one click, not a mode", () => {
    const html = form();
    const tag = /<textarea[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toBeTruthy();
    expect(isDisabled(tag)).toBe(false);
    // React emits the attribute as `readOnly=""`, camel-cased, so a lowercase
    // substring check would silently pass on a read-only box.
    expect(tag).not.toMatch(/readonly/i);
    // Labelled, so the box is reachable and announced.
    expect(tag).toContain("aria-label");
    expect(tag).toContain("Sarah Ahmed");
  });

  it("disables the box only while a request is in flight", () => {
    const tag = (busy: "approving" | "discarding") =>
      /<textarea[^>]*>/.exec(form({ busy }))?.[0] ?? "";
    expect(isDisabled(tag("approving"))).toBe(true);
    expect(isDisabled(tag("discarding"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Everything needed to judge the message.
// ---------------------------------------------------------------------------

describe("the card carries what a person needs in order to judge it", () => {
  it("names the patient, the treatment, the channel and where it is in the cadence", () => {
    const html = form();
    expect(html).toContain("Sarah Ahmed");
    expect(html).toContain("Composite bonding, upper six");
    expect(html).toContain("Email");
    expect(html).toContain(`Follow-up 2 of ${CADENCE_LENGTH}`);
  });

  it("the cadence length on the screen IS the engine's cadence length", () => {
    // "Follow-up 2 of 3" is a promise to the patient's practice about how many
    // messages this can ever become. It must come from the cadence, not from a
    // number somebody typed into a component.
    expect(CADENCE_LENGTH).toBe(CLOSER_CADENCE.length);
  });

  it("shows the figure, and labels it as treatment left rather than as a debt", () => {
    const html = decode(form());
    expect(html).toContain("£780");
    expect(html).toContain("of treatment left");
    // The drafter refuses any wording that says the patient owes money, because the
    // figure is the cost of treatment still to be done and Dentally exposes no
    // balance at all. The screen must not quietly say what the message may not.
    for (const word of ["outstanding balance", "owes", "owed", "debt", "unpaid", "arrears", "overdue"]) {
      expect(html.toLowerCase(), `the card must not say "${word}"`).not.toContain(word);
    }
  });

  it("uses no funding or treatment-category wording anywhere", () => {
    const html = form().toLowerCase();
    for (const word of [">nhs<", "nhs ", "private treatment", "band 2"]) {
      expect(html, `the card must not say "${word}"`).not.toContain(word);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The three actions.
// ---------------------------------------------------------------------------

describe("approve, edit-then-approve and discard are all present, and distinguishable", () => {
  it("at rest it offers Approve and Discard, and no undo (there is nothing to undo)", () => {
    const html = form();
    expect(html).toContain("Approve");
    expect(html).toContain("Discard");
    expect(html).not.toContain("Undo my edit");
  });

  it("an edited message says so, and the button says what it is about to send", () => {
    const html = form({ body: `${LONG_BODY} Softened by a human.` });
    expect(html).toContain("Approve edited message");
    expect(html).toContain("Undo my edit");
    // ...and it warns that the edit is checked, so a refusal is not a surprise.
    expect(html).toContain("checked against the patient-messaging rules");
  });

  it("whitespace alone is not an edit", () => {
    // Otherwise every stray newline turns a plain approval into an "edited message"
    // that goes back through the scan for no reason.
    const html = form({ body: `  ${LONG_BODY}\n` });
    expect(html).toContain(">Approve<");
    expect(html).not.toContain("Approve edited message");
  });

  it("approveLabel is the rule, and it is exhaustive", () => {
    expect(approveLabel(false)).toBe("Approve");
    expect(approveLabel(true)).toBe("Approve edited message");
    expect(approveLabel(true)).not.toBe(approveLabel(false));
  });

  it("shows a refusal in words a receptionist can act on, and KEEPS the edit", () => {
    const edited = `${LONG_BODY} Last chance.`;
    const html = form({
      body: edited,
      error:
        "Take out the urgency, the deadline or the limited availability. This is a follow-up, not an offer.",
    });
    expect(html).toContain("Take out the urgency");
    expect(html).toContain('role="alert"');
    // THE POINT: the edit survives the refusal, so the person changes the one thing
    // that was wrong instead of starting again.
    expect(decode(textareaBody(html))).toContain("Last chance.");
    // And no machine vocabulary reaches the screen.
    expect(html).not.toContain("invented_figure");
    expect(html).not.toContain("harm_from_delay");
  });
});

// ---------------------------------------------------------------------------
// 4. Discard needs a reason, and the reason's effect is stated before the click.
// ---------------------------------------------------------------------------

describe("a discard is never unreasoned", () => {
  it("the reason chooser is closed until Discard is pressed", () => {
    const html = form();
    expect(html).not.toContain("Why is this not going out?");
    expect(html).not.toContain("Confirm discard");
    for (const r of CLOSER_DISCARD_REASONS) {
      expect(html).not.toContain(CLOSER_DISCARD_LABEL[r]);
    }
  });

  it("offers every reason, each with what it will do", () => {
    const html = form({ choosingReason: true });
    expect(html).toContain("Why is this not going out?");
    for (const r of CLOSER_DISCARD_REASONS) {
      expect(html, `missing reason ${r}`).toContain(CLOSER_DISCARD_LABEL[r]);
      expect(html, `missing effect for ${r}`).toContain(CLOSER_DISCARD_EFFECT[r]);
    }
    // No machine key on the screen.
    for (const r of CLOSER_DISCARD_REASONS) expect(html).not.toContain(`>${r}<`);
  });

  it("EVERY reason that stops the follow-up for good says so before it is chosen", () => {
    // Three of the five are terminal. A person about to retire somebody's follow-up
    // must be told that is what the button does, in the same glance as the choice.
    const html = form({ choosingReason: true });
    const terminal = CLOSER_DISCARD_REASONS.filter(
      (r) => discardOutcome(r, { cooldownHours: 24 }).kind === "stop",
    );
    expect(terminal.length).toBeGreaterThan(0);
    for (const r of terminal) {
      expect(CLOSER_DISCARD_EFFECT[r], `${r} must warn that it is final`).toMatch(/for good/i);
      expect(html).toContain(CLOSER_DISCARD_EFFECT[r]);
    }
  });

  it("nothing is preselected, so a stray click cannot retire a patient's follow-up", () => {
    const html = form({ choosingReason: true });
    expect(html).not.toContain('aria-pressed="true"');
    // ...and Confirm is dead until a reason is chosen.
    const confirm = /<button[^>]*>(?:(?!<\/button>)[\s\S])*Confirm discard/.exec(html)?.[0] ?? "";
    expect(confirm).toBeTruthy();
    expect(isDisabled(confirm)).toBe(true);
  });

  it("with a reason chosen, that reason is marked and Confirm is live", () => {
    const reason: CloserDiscardReason = "do_not_contact";
    const html = form({ choosingReason: true, reason });
    expect(html).toContain('aria-pressed="true"');
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
    const confirm = /<button[^>]*>(?:(?!<\/button>)[\s\S])*Confirm discard/.exec(html)?.[0] ?? "";
    expect(isDisabled(confirm)).toBe(false);
  });

  it("offers a way out of the chooser that is not a discard", () => {
    const html = form({ choosingReason: true });
    expect(html).toContain("Keep it");
  });
});

// ---------------------------------------------------------------------------
// 5. The panel and its status strip.
// ---------------------------------------------------------------------------

function panel(drafts: CloserDraftView[], counts = { awaiting: 4, sent: 128, replies: 9 }): string {
  return renderToStaticMarkup(
    createElement(CloserDraftsPanel, { drafts, counts, nowIso: NOW }),
  );
}

describe("the status strip says what is waiting, what has gone, and what came back", () => {
  it("shows all three numbers", () => {
    const html = panel([DRAFT]);
    expect(html).toContain("Awaiting approval");
    expect(html).toContain("Sent");
    expect(html).toContain("Replies");
    expect(html).toContain(">4<");
    expect(html).toContain(">128<");
    expect(html).toContain(">9<");
  });

  it("says where replies are answered, because it is NOT here", () => {
    // Replies are handled by the existing shared inbound path: the reply stops this
    // follow-up and the conversation goes to Conversations. Nothing on this screen
    // answers a patient, and the screen should not imply that it does.
    const html = panel([DRAFT]);
    expect(html).toContain("Answered in Conversations, not here.");
    expect(html).not.toContain("Reply");
  });

  it("renders one card per draft, each carrying its own message in full", () => {
    const second: CloserDraftView = {
      ...DRAFT,
      touchId: "t-2",
      patientName: "Marcus Bell",
      treatment: "Upper acrylic denture",
      amountOutstanding: 0,
      step: 3,
      channel: "sms",
      body: "Hi Marcus, this is our last message about your planned upper acrylic denture. N17 Dental",
    };
    const html = panel([DRAFT, second]);
    expect(html).toContain("Sarah Ahmed");
    expect(html).toContain("Marcus Bell");
    expect(html).toContain("last message about your planned upper acrylic denture");
    expect((html.match(/<textarea/g) ?? []).length).toBe(2);
  });

  it("an empty queue explains what the closer does, without pretending it is broken", () => {
    const html = panel([]);
    expect(html).toContain("No drafts waiting");
    expect(html).toContain("three weeks");
    expect(html).toContain("before anything is sent");
    expect(html).not.toContain("<textarea");
  });

  it("says plainly that nothing is sent without approval", () => {
    // The module's one promise, on the screen where it is kept.
    expect(panel([DRAFT])).toContain("Nothing is sent until it is approved here.");
  });

  it("a freshly rendered card is NOT already asking why the message is being discarded", () => {
    // This one goes through the stateful CloserDraftCard, not the presentational
    // form, so it is the initial state of the real card that is under test.
    const html = panel([DRAFT]);
    expect(html).not.toContain("Why is this not going out?");
    expect(html).not.toContain("Confirm discard");
    expect(html).toContain(">Approve<");
  });
});

// ---------------------------------------------------------------------------
// 5b. The card's initial state, and what a submit does.
//
// A static render cannot click, so the two safety properties that live in the
// card's state — the chooser starts closed, nothing is preselected — are asserted
// against the named constant the card initialises from. The submit behaviour is
// asserted against the exported functions the card calls, with the network
// injected.
// ---------------------------------------------------------------------------

describe("the card starts with nothing chosen and nothing open", () => {
  it("no discard reason is preselected, ever", () => {
    // Three of the five reasons stop a patient's follow-up for good. A preselected
    // one would turn a stray double-click into a silent, permanent decision.
    expect(INITIAL_CARD_STATE.reason).toBeNull();
  });

  it("the reason chooser starts closed, so Discard is always two deliberate acts", () => {
    expect(INITIAL_CARD_STATE.choosingReason).toBe(false);
  });

  it("nothing is in flight and nothing has failed yet", () => {
    expect(INITIAL_CARD_STATE.busy).toBeNull();
    expect(INITIAL_CARD_STATE.error).toBeNull();
  });

  it("the REAL card, with its chooser opened, has nothing pressed and a dead Confirm", () => {
    // The constant above says what the card should start with; this renders the
    // card itself with the chooser opened and checks it obeys. The two halves are
    // on opposite sides of a click, which is what the `initialState` seam exists
    // for: without it the preselection could only be seen in a browser.
    const html = renderToStaticMarkup(
      createElement(CloserDraftCard, {
        draft: DRAFT,
        nowIso: NOW,
        onDone: NOOP,
        initialState: { ...INITIAL_CARD_STATE, choosingReason: true },
      }),
    );
    expect(html).toContain("Why is this not going out?");
    expect(html).not.toContain('aria-pressed="true"');
    const confirm = /<button[^>]*>(?:(?!<\/button>)[\s\S])*Confirm discard/.exec(html)?.[0] ?? "";
    expect(confirm).toBeTruthy();
    expect(isDisabled(confirm)).toBe(true);
  });
});

describe("what a submit actually sends, and what a refusal leaves behind", () => {
  function spies() {
    const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
    const busy: CloserCardBusy[] = [];
    const errors: Array<string | null> = [];
    const done: string[] = [];
    return {
      calls,
      busy,
      errors,
      done,
      setBusy: (b: CloserCardBusy) => busy.push(b),
      setError: (e: string | null) => errors.push(e),
      onDone: (id: string) => done.push(id),
    };
  }

  it("an UNCHANGED approval posts no body, so the queued text is the text that was scanned", async () => {
    const s = spies();
    await runApprove({
      touchId: "t-1",
      body: DRAFT.body,
      edited: false,
      post: async (action, payload) => {
        s.calls.push({ action, payload });
        return { ok: true };
      },
      setBusy: s.setBusy,
      setError: s.setError,
      onDone: s.onDone,
    });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].action).toBe("approve");
    expect(Object.keys(s.calls[0].payload)).toEqual(["touchId"]);
    expect(s.done).toEqual(["t-1"]);
  });

  it("an EDITED approval posts the edited text, trimmed", async () => {
    const s = spies();
    await runApprove({
      touchId: "t-1",
      body: "  Hi Sarah, softened by a human.  ",
      edited: true,
      post: async (action, payload) => {
        s.calls.push({ action, payload });
        return { ok: true };
      },
      setBusy: s.setBusy,
      setError: s.setError,
      onDone: s.onDone,
    });
    expect(s.calls[0].payload).toEqual({ touchId: "t-1", body: "Hi Sarah, softened by a human." });
  });

  it("a refusal surfaces the server's own sentence and CANNOT clear the edit", async () => {
    const s = spies();
    const refusal = "Take out the urgency, the deadline or the limited availability. This is a follow-up, not an offer.";
    await runApprove({
      touchId: "t-1",
      body: "Hi Sarah, last chance.",
      edited: true,
      post: async () => {
        throw new Error(refusal);
      },
      setBusy: s.setBusy,
      setError: s.setError,
      onDone: s.onDone,
    });
    expect(s.errors).toContain(refusal);
    // The card is put back into a workable state rather than left spinning...
    expect(s.busy[s.busy.length - 1]).toBeNull();
    // ...and the draft stays in the queue, because it is still a draft.
    expect(s.done).toEqual([]);
    // THE STRUCTURAL GUARANTEE, and the reason these are functions with injected
    // dependencies at all: `setBody` is not among them, so the failure path has no
    // way to throw away what the person typed. It is not a catch block that
    // remembers to be careful, it is a function that cannot be careless.
    expect(Object.keys({
      touchId: 1, body: 1, edited: 1, post: 1, setBusy: 1, setError: 1, onDone: 1,
    })).not.toContain("setBody");
    expect(runApprove.length).toBe(1);
  });

  it("a discard with no reason chosen sends NOTHING", async () => {
    const s = spies();
    await runDiscard({
      touchId: "t-1",
      reason: null,
      post: async (action, payload) => {
        s.calls.push({ action, payload });
        return { ok: true };
      },
      setBusy: s.setBusy,
      setError: s.setError,
      onDone: s.onDone,
    });
    expect(s.calls).toEqual([]);
    expect(s.busy).toEqual([]);
    expect(s.done).toEqual([]);
  });

  it("a discard with a reason sends the touch id and that reason, and nothing else", async () => {
    const s = spies();
    await runDiscard({
      touchId: "t-1",
      reason: "plan_not_live",
      post: async (action, payload) => {
        s.calls.push({ action, payload });
        return { ok: true };
      },
      setBusy: s.setBusy,
      setError: s.setError,
      onDone: s.onDone,
    });
    expect(s.calls).toEqual([
      { action: "discard", payload: { touchId: "t-1", reason: "plan_not_live" } },
    ]);
    expect(s.done).toEqual(["t-1"]);
  });
});

// ---------------------------------------------------------------------------
// 6. The tab it lives in.
// ---------------------------------------------------------------------------

describe("the drafts are a tab of the coordinator's own worklist", () => {
  const tabs = (
    counts: { awaiting: number; sent: number; replies: number },
    defaultKey: "worklist" | "closer" = "worklist",
  ) =>
    renderToStaticMarkup(
      createElement(CoordinatorTabs, {
        opportunities: [],
        drafts: [DRAFT],
        counts,
        nowIso: NOW,
        defaultKey,
      }),
    );

  it("offers both tabs, and lands on the worklist", () => {
    const html = tabs({ awaiting: 4, sent: 0, replies: 0 });
    expect(html).toContain("Worklist");
    expect(html).toContain("Closer drafts");
    // The worklist is the default panel: the closer is the newer, quieter half.
    expect(html).toContain('aria-selected="true"');
    const active = /<button[^>]*aria-selected="true"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
    expect(active).toContain("Worklist");
  });

  it("badges the tab with the number waiting, because a queue nobody sees is a queue nobody works", () => {
    expect(tabs({ awaiting: 4, sent: 0, replies: 0 })).toContain(">4<");
  });

  it("shows no badge when nothing is waiting", () => {
    const html = tabs({ awaiting: 0, sent: 12, replies: 3 });
    // The zero must not be rendered as a badge; an empty queue should look empty.
    expect(html).toContain("Closer drafts");
    expect(html).not.toContain(">0<");
  });

  it("the closer tab really carries the drafts panel, not an empty panel", () => {
    // Only the ACTIVE panel is mounted, so the worklist-first default hides whether
    // the second tab has any content at all. Opening on it is the only way to see.
    const html = tabs({ awaiting: 1, sent: 0, replies: 0 }, "closer");
    expect(html).toContain("Closer drafts");
    expect(html).toContain("Nothing is sent until it is approved here.");
    expect(html).toContain("Awaiting approval");
    expect(html).toContain("Sarah Ahmed");
    expect(html).toContain("<textarea");
  });
});
