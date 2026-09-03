import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { CopilotConversation } from "./copilot-conversation";
import {
  COPILOT_PAGE_COPY,
  CopilotEmptyState,
  CopilotPageChat,
  CopilotThreadView,
  copilotPageCopyFor,
} from "./copilot-page-chat";
import {
  COPILOT_FAILED_REPLY,
  COPILOT_STARTERS,
  COPILOT_UNREACHABLE_REPLY,
  copilotStartersFor,
} from "@/components/platform/copilot-thread";
import { COPILOT_TOOL_NAMES } from "@/lib/copilot/clearance";
import {
  postCopilotTurn,
  type CopilotMessage,
} from "./copilot-thread";

// ===========================================================================
// THE CO-PILOT PAGE IS A PAGE, AND THE POP-UP IS STILL A POP-UP.
//
// THE DEFECT. /c/[client]/co-pilot rendered the SHARED CopilotConversation
// inside a card. That component is the bottom-docked overlay the keyboard
// shortcut opens: a floating card above a slim ask-bar, a 48vh cap on the
// message area, a one-line <input>. On a full page it did not become a page, it
// became a pop-up with white space around it, and the owner's report was exactly
// that - "the page looks like the quick pop up".
//
// SO THIS FILE PINS BOTH HALVES OF THE FIX, and the second half is the one that
// is easy to lose. It is not enough that the page now looks right; the pop-up
// must still be docked, still be capped, and still be driven by its own markup,
// or the next person to "unify the co-pilot components" reintroduces the bug
// from the other direction.
//
// vitest collects only src/-star-star/*.test.ts in the node environment, so no
// .tsx can BE a test. A .ts test can import one and render it with
// react-dom/server, which is what happens below: these are assertions about
// MARKUP, not about a component's intentions. Effects do not run in a static
// render, so nothing here depends on a browser.
// ===========================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(resolve(HERE, file), "utf8");

const PRACTICE = "Vitality Dental";
const CLIENT = "vitality";

const renderPage = () =>
  renderToStaticMarkup(createElement(CopilotPageChat, { clientSlug: CLIENT, practiceName: PRACTICE }));

const renderThread = (messages: CopilotMessage[], busy = false, elapsed = 0) =>
  renderToStaticMarkup(
    createElement(CopilotThreadView, {
      messages,
      busy,
      elapsed,
      practiceName: PRACTICE,
      copiedIndex: null,
      onCopy: () => {},
    }),
  );

/** Count non-overlapping occurrences of a literal. */
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/**
 * A literal as React will have written it into the markup.
 *
 * Needed because every starter label here contains an apostrophe ("What's in
 * today's diary?"), which React escapes to &#x27;. Asserting on the raw string
 * would fail on correct output, and the tempting "fix" - dropping the
 * apostrophes from the copy - would be a test dictating the product's English.
 */
const asRendered = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

// ---------------------------------------------------------------------------
// THE EMPTY STATE: what the owner sees before they have asked anything.
// ---------------------------------------------------------------------------
describe("the empty state introduces the co-pilot", () => {
  const html = renderToStaticMarkup(
    createElement(CopilotEmptyState, { practiceName: PRACTICE, onStart: () => {} }),
  );

  it("carries the Vitality mark", () => {
    // The owner asked for the logo by name. It is the same asset /book and the
    // landing pages use, so the co-pilot reads as the same product.
    expect(html).toContain('src="/copilot-logo.png"');
  });

  it("offers every starter prompt as a card, with its hint", () => {
    expect(COPILOT_STARTERS.length).toBeGreaterThanOrEqual(4);
    for (const starter of COPILOT_STARTERS) {
      expect(html, `the "${starter.label}" starter is missing`).toContain(asRendered(starter.label));
      expect(html, `the "${starter.label}" starter lost its hint`).toContain(asRendered(starter.hint));
    }
    // Cards, not a list: each starter is its own button.
    expect(count(html, "<button")).toBe(COPILOT_STARTERS.length);
  });

  it("uses the app's own status tokens for the card tints, not raw palette classes", () => {
    // House rule: new components draw from globals.css tokens. The pop-up's
    // emerald/amber/violet literals stay where they are, in the pop-up.
    for (const starter of COPILOT_STARTERS) {
      expect(html).toContain(starter.pageTint);
      expect(html, "a raw palette class reached the page").not.toContain(starter.popupTint);
    }
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
});

// ---------------------------------------------------------------------------
// THE THREAD: two turns that cannot be mistaken for one another.
// ---------------------------------------------------------------------------
describe("a thread renders the owner's turn and the co-pilot's turn distinctly", () => {
  const THREAD: CopilotMessage[] = [
    { role: "user", content: "Which patients owe money?" },
    { role: "assistant", content: "Two plans are outstanding:\n- Sarah Jones, **£320**\n- Tom Ali, **£145**" },
  ];
  const html = renderThread(THREAD);

  it("marks each turn with its role", () => {
    expect(html).toContain('data-turn="user"');
    expect(html).toContain('data-turn="assistant"');
  });

  it("gives the owner a tinted right-aligned block and the co-pilot the full column", () => {
    // THE ASYMMETRY IS THE DESIGN. Boxing a long structured answer in a bubble
    // costs it two gutters for nothing; a short thing you typed reads better in
    // one. So only the user's turn is a bubble, and only it is right-aligned.
    const user = html.slice(html.indexOf('data-turn="user"'), html.indexOf('data-turn="assistant"'));
    const assistant = html.slice(html.indexOf('data-turn="assistant"'));
    expect(user).toContain("justify-end");
    expect(user).toContain("bg-card-muted");
    expect(assistant).not.toContain("justify-end");
    expect(assistant).not.toContain("bg-card-muted");
  });

  it("puts the Vitality mark beside the co-pilot's answer and never beside the owner's", () => {
    const user = html.slice(html.indexOf('data-turn="user"'), html.indexOf('data-turn="assistant"'));
    expect(user).not.toContain("copilot-logo.png");
    expect(html.slice(html.indexOf('data-turn="assistant"'))).toContain('src="/copilot-logo.png"');
  });

  it("typesets the answer but leaves what the owner typed exactly as typed", () => {
    // The reply's markdown is read (a real <ul>, real <strong>); the question is
    // not, because a person writing "**" means asterisks.
    expect(html).toContain("<ul");
    expect(html).toContain("<strong");
    const literal = renderThread([{ role: "user", content: "show me **everything**" }]);
    expect(literal).toContain("**everything**");
    expect(literal).not.toContain("<strong");
    expect(literal).toContain("whitespace-pre-wrap");
  });

  it("offers a copy button on the co-pilot's answers only", () => {
    expect(html).toContain(COPILOT_PAGE_COPY.copy);
    expect(count(html, COPILOT_PAGE_COPY.copy)).toBe(1);
  });

  it("shows an honest working state, with no fake stream", () => {
    const working = renderThread(THREAD, true, 0);
    expect(working).toContain(COPILOT_PAGE_COPY.thinking);
    expect(working).toContain('data-turn="thinking"');
    expect(working).toContain('aria-busy="true"');
    // The seconds only appear once the wait is long enough to be worth counting.
    expect(working).not.toContain("0s");
    expect(renderThread(THREAD, true, 9)).toContain("9s");
    // And it is gone the moment the answer is in.
    expect(renderThread(THREAD, false)).not.toContain(COPILOT_PAGE_COPY.thinking);
  });
});

// ---------------------------------------------------------------------------
// THE PAGE FRAME: reading column, composer, height, honesty.
// ---------------------------------------------------------------------------
describe("the page frame", () => {
  const html = renderPage();

  it("opens on the empty state with the mark and the starters", () => {
    expect(html).toContain(COPILOT_PAGE_COPY.emptyHeading);
    expect(html).toContain('src="/copilot-logo.png"');
    expect(html).toContain(asRendered(COPILOT_STARTERS[0].label));
  });

  it("has a composer that takes multiple lines, not the pop-up's single-line input", () => {
    // THE VISIBLE DIFFERENCE the owner asked for. A <textarea> that grows is
    // what makes this a chat interface rather than a search box.
    expect(html).toContain("<textarea");
    expect(html).toContain('placeholder="Ask the co-pilot anything"');
    expect(html).toContain("resize-none");
    expect(html).toContain(COPILOT_PAGE_COPY.keys);
  });

  it("caps the reading column and does not cap the surface", () => {
    // ~48rem of measure for prose, on a panel that still fills the working area.
    expect(html).toContain("max-w-3xl");
    expect(count(html, "max-w-3xl")).toBeGreaterThanOrEqual(2); // messages AND composer
  });

  it("takes its height from the shell rather than guessing at the chrome", () => {
    expect(html).toContain("data-chat");
    expect(html).toContain("h-full");
    // MUTATION GUARD: the previous page subtracted a hardcoded 10rem of chrome
    // from the viewport. Both app shells now carry the lg:h-full hatch instead.
    expect(html).not.toContain("100vh-10rem");
    for (const shell of ["../../app/c/[client]/layout.tsx", "../../app/owner/[client]/layout.tsx"]) {
      expect(read(shell), `${shell} does not open the height hatch`).toContain(
        "lg:has-[[data-chat]]:h-full",
      );
    }
  });

  it("says plainly that nothing is saved, and promises no history it does not have", () => {
    // THE HONESTY RULE. The thread is in memory only: no table, no thread id, no
    // history endpoint. So the page must not imply otherwise anywhere.
    expect(html).toContain(COPILOT_PAGE_COPY.ephemeral);
    // The sentence has to actually make both claims, or a future rewording
    // could satisfy the assertion above while saying nothing.
    expect(COPILOT_PAGE_COPY.ephemeral.toLowerCase()).toMatch(/\bis saved\b|\bnot saved\b/);
    expect(COPILOT_PAGE_COPY.ephemeral.toLowerCase()).toContain("clears the conversation");
    const source = read("copilot-page-chat.tsx");
    for (const forbidden of ["Recent chats", "History", "Saved conversations", "Your conversations"]) {
      expect(source, `the page offers "${forbidden}", which does not exist`).not.toContain(forbidden);
    }
  });

  it("has a reset, disabled until there is something to reset", () => {
    expect(html).toContain(COPILOT_PAGE_COPY.newThread);
    // Nothing said yet, so BOTH the reset and the send button start disabled
    // rather than looking live. Counted, so losing one of them fails here.
    expect(count(html, 'disabled=""')).toBe(2);
  });

  it("names every control for the assistive layer", () => {
    expect(html).toContain('aria-label="Conversation"');
    expect(html).toContain(`aria-label="${COPILOT_PAGE_COPY.send}"`);
    expect(html).toContain(`aria-label="${COPILOT_PAGE_COPY.newThread}"`);
  });

  it("draws from tokens, with no raw hex anywhere in the page's own source", () => {
    // The dashboard's hex ban, applied to the new component.
    const source = read("copilot-page-chat.tsx");
    expect(source).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    expect(source).not.toMatch(/\b(?:rgb|hsl)a?\(/);
  });
});

// ---------------------------------------------------------------------------
// THE POP-UP IS UNCHANGED. This is the half that is easy to lose.
// ---------------------------------------------------------------------------
describe("the pop-up keeps its own bottom-docked layout", () => {
  const html = renderToStaticMarkup(createElement(CopilotConversation, { clientSlug: CLIENT }));
  const source = read("copilot-conversation.tsx");

  it("is still docked: a floating card above a slim ask-bar", () => {
    // The construction the shortcut opens. copilot-chat.tsx positions this at
    // justify-end of the viewport, and these are the pieces that belong to that.
    expect(html).toContain("rounded-card border border-line bg-card");
    expect(html).toContain("shadow-[0_20px_55px_rgba(11,32,73,0.30)]");
    expect(source).toContain("max-h-[48vh]");
  });

  it("still uses a single-line input, not the page's growing textarea", () => {
    // THE CENTRAL PIN. If this ever renders a <textarea>, the two surfaces have
    // been merged again and the page's layout has leaked into the overlay.
    expect(html).toContain("<input");
    expect(html).not.toContain("<textarea");
  });

  it("does not render the page's chrome", () => {
    for (const pageOnly of [
      COPILOT_PAGE_COPY.emptyHeading,
      COPILOT_PAGE_COPY.newThread,
      COPILOT_PAGE_COPY.ephemeral,
      "data-chat",
      "max-w-3xl",
    ]) {
      expect(html, `the pop-up has grown the page's "${pageOnly}"`).not.toContain(pageOnly);
    }
  });

  it("keeps its own starter palette, and its own compact starter row", () => {
    for (const starter of COPILOT_STARTERS) {
      expect(html).toContain(starter.popupTint);
      expect(html, "the page's tints leaked into the pop-up").not.toContain(starter.pageTint);
      // The pop-up shows labels only; the hints are the page's larger cards.
      expect(html).toContain(asRendered(starter.label));
      expect(html, "the pop-up grew the page's starter hints").not.toContain(asRendered(starter.hint));
    }
  });

  it("imports the transport and NOT the page", () => {
    // The whole point of the split: one request path, two layouts.
    // Matched on the IMPORT SPECIFIER, not on the whole file: the pop-up's
    // header comment names the page component to explain the split, and banning
    // the word would ban the explanation.
    expect(source).toMatch(/from "[^"]*copilot-thread"/);
    expect(source, "the pop-up imports the page").not.toMatch(/from "[^"]*copilot-page-chat"/);
    expect(source, "the pop-up imports the page's typesetter").not.toMatch(/from "[^"]*copilot-prose"/);
    // And it no longer builds the request itself, which is how the two used to
    // drift: two fetches, two sets of error copy.
    expect(source).not.toContain("/api/copilot");
  });
});

// ---------------------------------------------------------------------------
// THE SHARED TRANSPORT. One request path, every response shape the route makes.
// ---------------------------------------------------------------------------
describe("the transport both surfaces send through", () => {
  const stub = (init: { status: number; body: unknown }) =>
    (async () =>
      ({
        status: init.status,
        ok: init.status >= 200 && init.status < 300,
        json: async () => init.body,
      }) as unknown as Response) as unknown as typeof fetch;

  const send = (fetchImpl: typeof fetch) =>
    postCopilotTurn(CLIENT, [{ role: "user", content: "hello" }], fetchImpl);

  it("returns the reply on a normal answer", async () => {
    await expect(send(stub({ status: 200, body: { ok: true, reply: "Two plans are outstanding." } }))).resolves.toBe(
      "Two plans are outstanding.",
    );
  });

  it("surfaces the 403 sentence, which is written for the owner to read", async () => {
    // /api/copilot is owner-only. Swallowing this into the generic apology is
    // how a permissions problem gets mistaken for a broken feature.
    await expect(
      send(stub({ status: 403, body: { ok: false, error: "The co-pilot is available to the practice owner." } })),
    ).resolves.toBe("The co-pilot is available to the practice owner.");
  });

  it("does not surface a 500's log line as an answer", async () => {
    await expect(send(stub({ status: 500, body: { ok: false, error: "copilot unavailable" } }))).resolves.toBe(
      COPILOT_FAILED_REPLY,
    );
  });

  it("never rejects, whatever the network does", async () => {
    // A throw here would leave the thread stuck on "working" for ever, with the
    // owner's own message the last thing on screen.
    const throwing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(send(throwing)).resolves.toBe(COPILOT_UNREACHABLE_REPLY);

    const notJson = (async () =>
      ({ status: 502, ok: false, json: async () => JSON.parse("<html>") }) as unknown as Response) as unknown as typeof fetch;
    await expect(send(notJson)).resolves.toBe(COPILOT_UNREACHABLE_REPLY);
  });

  it("falls back to a sentence when the body carries no usable reply", async () => {
    for (const body of [{}, { reply: "" }, { reply: "   " }, { reply: 42 }, null]) {
      await expect(send(stub({ status: 200, body }))).resolves.toBe(COPILOT_FAILED_REPLY);
    }
  });

  it("posts the whole thread and the client, which is what scopes the answer", async () => {
    // The route resolves the practice's sites from `client` and honours the top
    // bar's site switcher. Dropping either turns the co-pilot into a 400.
    let sent: RequestInit | undefined;
    const capture = (async (_url: string, init: RequestInit) => {
      sent = init;
      return { status: 200, ok: true, json: async () => ({ reply: "ok" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await postCopilotTurn(CLIENT, [{ role: "user", content: "hello" }], capture);
    expect(JSON.parse(String(sent?.body))).toEqual({
      messages: [{ role: "user", content: "hello" }],
      client: CLIENT,
    });
  });
});

// ---------------------------------------------------------------------------
// THE MANAGER'S SURFACE — the same page, offering only what it can answer.
//
// The practice manager's co-pilot has six tools and no money tool, no report
// tool and no send tool (src/lib/copilot/scope.ts). The page above was written
// for the owner, and two of its four starter buttons run tools the manager does
// not have, while its own copy promises "full visibility", "money owed" and "I
// can draft and send a message".
//
// None of that is a data leak — the server refuses each of those tools three
// separate ways. It is the OTHER failure: an interface that offers what the
// server will refuse. A dead button is also an advertisement for what somebody
// cannot have, which is a smaller leak of the same kind as a refusal that
// enumerates the owner's toolbox.
// ---------------------------------------------------------------------------
describe("the co-pilot page, scoped to the practice manager", () => {
  const managerHtml = renderToStaticMarkup(
    createElement(CopilotEmptyState, { practiceName: PRACTICE, onStart: () => {}, access: "manager" }),
  );
  const ownerHtml = renderToStaticMarkup(
    createElement(CopilotEmptyState, { practiceName: PRACTICE, onStart: () => {} }),
  );

  it("offers no starter that runs a tool she does not have", () => {
    const managerSafe = copilotStartersFor("manager");
    // Not vacuous in either direction: some are dropped, some survive.
    expect(managerSafe.length).toBeGreaterThan(0);
    expect(managerSafe.length).toBeLessThan(COPILOT_STARTERS.length);
    expect(count(managerHtml, "<button")).toBe(managerSafe.length);
    for (const starter of COPILOT_STARTERS) {
      const shown = managerSafe.includes(starter);
      expect(managerHtml.includes(asRendered(starter.label)), `"${starter.label}" for a manager`).toBe(shown);
    }
  });

  it("drops exactly the money and overview starters, by name", () => {
    const dropped = COPILOT_STARTERS.filter((s) => !copilotStartersFor("manager").includes(s));
    expect(dropped.map((s) => s.id).sort()).toEqual(["outstanding", "overview"]);
  });

  it("does not promise money, reports or sending in its opening copy", () => {
    const copy = copilotPageCopyFor("manager");
    expect(copy.emptyBody).not.toMatch(/money owed/i);
    expect(copy.emptyBody).not.toMatch(/send a message/i);
    expect(copy.subtitle).not.toMatch(/full visibility/i);
    // ...and says where those things actually live, rather than going quiet.
    expect(copy.emptyBody).toMatch(/sit with the practice owner/i);
    expect(copy.emptyBody).toMatch(/cannot message anyone/i);
    expect(managerHtml).toContain(asRendered(copy.emptyBody));
  });

  it("leaves the owner's page exactly as it was", () => {
    // The default IS the owner's, so every caller that passes no access — and
    // every test above — renders what it always rendered.
    expect(ownerHtml).toEqual(
      renderToStaticMarkup(
        createElement(CopilotEmptyState, { practiceName: PRACTICE, onStart: () => {}, access: "full" }),
      ),
    );
    expect(copilotPageCopyFor()).toEqual(COPILOT_PAGE_COPY);
    expect(copilotPageCopyFor("full")).toEqual(COPILOT_PAGE_COPY);
    expect(copilotStartersFor()).toEqual(COPILOT_STARTERS);
    expect(count(ownerHtml, "<button")).toBe(COPILOT_STARTERS.length);
  });

  it("every starter names a REAL tool, so the button and the server cannot drift", () => {
    // Guards the guard, and it now guards a stronger thing than it did. A starter
    // used to carry a hand-kept `minAccess` RANK, which could be right on the day
    // it was written and wrong the day a tool moved. It now names the tool it
    // runs, and the offer is derived from the clearance model — so this only has
    // to check that the name is real.
    for (const starter of COPILOT_STARTERS) {
      expect(COPILOT_TOOL_NAMES, `${starter.id} names no real tool`).toContain(starter.needsTool);
    }
  });

  it("the pop-up surface is scoped by the same selector, not a second list", () => {
    const popup = renderToStaticMarkup(
      createElement(CopilotConversation, { clientSlug: CLIENT, access: "manager" }),
    );
    for (const starter of COPILOT_STARTERS) {
      const shown = copilotStartersFor("manager").includes(starter);
      expect(popup.includes(asRendered(starter.label)), `pop-up "${starter.label}"`).toBe(shown);
    }
  });
});

describe("the narrower co-pilots are offered only what they can answer", () => {
  it("a login with no co-pilot at all is offered NOTHING by the Cmd-J panel", () => {
    // It used to fall to the manager's two, on the reasoning that the narrower
    // list is the harmless direction. Deriving the offer from the clearance model
    // makes it narrower still and exactly right: `none` holds no tool, so it is
    // shown no button, on the one surface it can reach (the shell mounts the
    // Cmd-J panel for every role).
    expect(copilotStartersFor("none")).toEqual([]);
  });

  it("a member of staff is never shown the diary, which is not theirs to read", () => {
    // The regression the derivation exists to prevent: under the old `minAccess`
    // rank, "everything except full" would have handed a receptionist the diary
    // button on the day the staff level was added, and it would have fetched a
    // refusal.
    expect(copilotStartersFor("staff")).toEqual([]);
  });

  it("a clinician is shown the diary starters and neither money one", () => {
    const shown = copilotStartersFor("clinician").map((s) => s.id);
    expect(shown).toEqual(["diary", "noshow"]);
    expect(shown).not.toContain("outstanding");
    expect(shown).not.toContain("overview");
  });

  it("the manager's two are unchanged by the derivation", () => {
    expect(copilotStartersFor("manager").map((s) => s.id)).toEqual(["diary", "noshow"]);
  });
});
