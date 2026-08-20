// ===========================================================================
// A BOUNDED, ESCAPING-BY-DEFAULT READER FOR THE CO-PILOT'S PROSE.
//
// WHAT THIS IS NOT. It is not a markdown implementation, and it must never grow
// into one. CommonMark is a 600-page spec with nested containers, reference
// links, HTML passthrough and entity decoding, and every one of those features
// is an attack surface on a string that arrives from a language model with the
// practice's own data interpolated into it. This reads the SIX shapes the
// co-pilot actually produces and treats everything else as text.
//
// THE SECURITY PROPERTY, AND WHY IT IS STRUCTURAL RATHER THAN CAREFUL.
// This module returns DATA, never HTML. There is no string of markup anywhere in
// this file, so there is nothing for `dangerouslySetInnerHTML` to be handed and
// no sanitiser to get wrong. `<script>alert(1)</script>` arriving from the model
// becomes { kind: "text", text: "<script>alert(1)</script>" }, React renders it
// as a text child, and React escapes text children — that is the whole defence,
// and it cannot be bypassed by a parser bug here, because the worst a parser bug
// can do is put the angle brackets in the wrong NODE. markdown.test.ts feeds
// script tags, `<img onerror>`, `javascript:` and `data:` URLs through the real
// renderer and asserts on the produced markup.
//
// LINKS ARE THE ONE PLACE A STRING BECOMES AN ATTRIBUTE, so they are the one
// place that needs a rule rather than a structure. The rule: a link is only ever
// recognised by matching the literal prefix "http://" or "https://" at a word
// boundary, and the href is the matched span itself. A scheme that is not one of
// those two cannot be produced by this function — not "javascript:", not "data:",
// not "vbscript:" — because no code path here ever writes an href it did not
// first prove began with one of the two allowed prefixes.
//
// WHY IT IS BOUNDED. The co-pilot's answers are capped at 1800 output tokens
// (~8k characters), so every limit in COPILOT_MARKDOWN_LIMITS sits several times
// above anything a real answer reaches. They exist for the answer that is not
// real: a model that loops, a tool result pasted whole, a future prompt change
// that lifts the cap. A chat pane that locks the owner's browser parsing one
// reply is a worse failure than a reply that renders its tail as plain text.
//
// WHY THERE IS NO ITALIC. Single-asterisk emphasis is the one markdown shape
// that collides with this product's own content: the co-pilot writes money and
// arithmetic, and "*" appears in both. Bold is unambiguous (a doubled marker),
// inline code is unambiguous (backticks appear in no clinical string), and
// italic is not worth a false positive that turns a price list into italics.
// ===========================================================================

/** One run of text inside a line. `text` is always the literal to display. */
export type CopilotInline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; text: string };

export interface CopilotHeadingBlock {
  kind: "heading";
  /** 2 for "#"/"##", 3 for anything deeper. The page owns h1. */
  level: 2 | 3;
  inline: CopilotInline[];
}
export interface CopilotParagraphBlock {
  kind: "paragraph";
  /**
   * One entry per SOURCE LINE, rendered with a hard break between them.
   *
   * This is the shape that carries the co-pilot's actual house style. Its system
   * prompt tells it to "lay records and lists out clearly with short labelled
   * lines" and to avoid markdown symbols, so the overwhelmingly common reply is
   * a run of "Label: value" lines with no marker on them at all. Collapsing
   * those into one flowing paragraph — which is what a real markdown reader does
   * — would run a patient's status, last visit and recall together into a
   * sentence. Preserving the author's line breaks is not a fallback here; it is
   * the primary rendering path.
   */
  lines: CopilotInline[][];
}
export interface CopilotListBlock {
  kind: "list";
  ordered: boolean;
  items: CopilotInline[][];
}
export interface CopilotTableBlock {
  kind: "table";
  head: CopilotInline[][];
  rows: CopilotInline[][][];
}
export interface CopilotRuleBlock {
  kind: "rule";
}

export type CopilotBlock =
  | CopilotHeadingBlock
  | CopilotParagraphBlock
  | CopilotListBlock
  | CopilotTableBlock
  | CopilotRuleBlock;

/**
 * Every ceiling in one object so a reviewer can see the whole budget at once,
 * and so the tests can assert against the real numbers rather than copies.
 */
export const COPILOT_MARKDOWN_LIMITS = {
  /** Source characters read. The API caps a reply near 8k, so this is ~5x. */
  chars: 40_000,
  /** Source lines read. */
  lines: 800,
  /** Blocks emitted. */
  blocks: 400,
  /** Items in ONE list. */
  listItems: 200,
  /** Body rows in ONE table. */
  tableRows: 100,
  /** Cells in ONE table row. */
  tableColumns: 12,
  /** Inline runs produced from ONE line. */
  inlineSegments: 200,
  /** Characters read from ONE line. */
  inlineChars: 4_000,
} as const;

const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^ {0,8}[-*•]\s+(.+)$/;
/**
 * At most three digits, deliberately. Four digits is a YEAR, and "2026. That was
 * the busiest month" is a sentence the co-pilot writes, not a numbered item.
 */
const ORDERED = /^ {0,8}\d{1,3}[.)]\s+(.+)$/;
/** A divider CELL: "---", ":---", "---:", ":---:". Checked per cell, never as one
 *  nested repetition, so there is no pattern here that can backtrack. */
const DIVIDER_CELL = /^:?-{1,}:?$/;

const LINK_PREFIXES = ["https://", "http://"] as const;
/** Characters that can never be part of a bare URL as a human writes one.
 *  U+00A0 is in the set because a model told to write British copy emits
 *  non-breaking spaces, and one of those swallowed into an href is a 404. */
const URL_STOP = new Set([" ", "\t", "\u00a0", "<", ">", '"', "'", "`", "|"]);
/** Sentence punctuation that trails a URL rather than belonging to it. */
const URL_TRAIL = new Set([".", ",", ";", ":", "!", "?"]);

/** True when `index` starts a word (so "xhttps://…" is not a link). */
function atWordStart(source: string, index: number): boolean {
  if (index === 0) return true;
  const before = source.charCodeAt(index - 1);
  const isAlnum =
    (before >= 48 && before <= 57) || (before >= 65 && before <= 90) || (before >= 97 && before <= 122);
  return !isAlnum;
}

/**
 * The bare-URL scan.
 *
 * Returns the URL span starting at `index`, or null. Hand-scanned rather than
 * matched with a regex for two reasons: a regex would have to be re-run against
 * a fresh `slice` at every character (quadratic on a long line), and a bare-URL
 * pattern is exactly the shape that backtracks badly on a near-miss.
 *
 * THE SCHEME IS THE WHOLE SECURITY ARGUMENT. The only way out of this function
 * with a non-null result is through one of the two literal prefixes above, so
 * the href the caller stores always begins "http://" or "https://".
 */
function scanUrl(source: string, index: number): string | null {
  if (!atWordStart(source, index)) return null;
  const prefix = LINK_PREFIXES.find((p) => source.startsWith(p, index));
  if (!prefix) return null;
  let end = index + prefix.length;
  while (end < source.length && !URL_STOP.has(source[end])) end++;
  // Trailing sentence punctuation, and a closing bracket the URL never opened.
  while (end > index + prefix.length) {
    const last = source[end - 1];
    if (URL_TRAIL.has(last)) {
      end--;
      continue;
    }
    if ((last === ")" && !source.slice(index, end).includes("(")) || last === "]" || last === "}") {
      end--;
      continue;
    }
    break;
  }
  // "https://" and nothing after it is not a link, it is the word.
  if (end <= index + prefix.length) return null;
  return source.slice(index, end);
}

/**
 * Split one line into inline runs.
 *
 * A single left-to-right pass with no lookbehind and no backtracking: each
 * marker either closes on this line or is emitted as the literal characters it
 * is made of. An unclosed "**" is asterisks, not a bold run to the end of time.
 */
export function parseCopilotInline(line: string): CopilotInline[] {
  const source = line.length > COPILOT_MARKDOWN_LIMITS.inlineChars
    ? line.slice(0, COPILOT_MARKDOWN_LIMITS.inlineChars)
    : line;
  const out: CopilotInline[] = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer) {
      out.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };

  while (i < source.length) {
    if (out.length >= COPILOT_MARKDOWN_LIMITS.inlineSegments) {
      // Budget spent: the rest of the line is text, which is always safe.
      buffer += source.slice(i);
      break;
    }
    const char = source[i];

    if (char === "`") {
      const close = source.indexOf("`", i + 1);
      if (close > i + 1) {
        flush();
        out.push({ kind: "code", text: source.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    if (char === "*" && source[i + 1] === "*") {
      const close = source.indexOf("**", i + 2);
      if (close > i + 2) {
        const inner = source.slice(i + 2, close);
        // No padding inside the markers: "£2 ** 3" is arithmetic, "**Total**"
        // is emphasis, and the difference between them is exactly this test.
        if (inner === inner.trim() && inner.length > 0) {
          flush();
          out.push({ kind: "bold", text: inner });
          i = close + 2;
          continue;
        }
      }
    }

    if (char === "h" || char === "H") {
      const url = scanUrl(source, i);
      if (url) {
        flush();
        out.push({ kind: "link", href: url, text: url });
        i += url.length;
        continue;
      }
    }

    buffer += char;
    i += 1;
  }

  flush();
  return out;
}

/** Cells of a pipe row, outer pipes dropped, trimmed, capped. */
function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim()).slice(0, COPILOT_MARKDOWN_LIMITS.tableColumns);
}

function looksLikeRow(line: string): boolean {
  const text = line.trim();
  if (!text.includes("|")) return false;
  if (text.startsWith("|") && text.endsWith("|") && text.length > 1) return true;
  let pipes = 0;
  for (const char of text) if (char === "|") pipes++;
  return pipes >= 2;
}

/**
 * A table is recognised ONLY by its divider row, and that is a deliberate
 * tightening rather than an oversight.
 *
 * A pipe is ordinary punctuation in an operational answer — "Mon | Wed | Fri",
 * "NHS | private" — and a reader that promoted any two pipe-bearing lines to a
 * table would silently reformat prose into a grid with the wrong columns. The
 * divider row ("|---|---|") appears in real markdown tables and essentially
 * never in a sentence, so requiring it means a false positive needs the model to
 * have written a table on purpose.
 */
function isDivider(line: string): boolean {
  if (!line.includes("-") || !line.includes("|")) return false;
  const cells = splitRow(line);
  if (cells.length < 1) return false;
  return cells.every((cell) => DIVIDER_CELL.test(cell));
}

/**
 * Read the co-pilot's reply into blocks.
 *
 * Never throws and never returns undefined: a non-string, an empty string or a
 * string of whitespace all give back an empty array, and the caller renders
 * nothing rather than a broken turn.
 */
export function parseCopilotMarkdown(source: string): CopilotBlock[] {
  if (typeof source !== "string" || source.length === 0) return [];
  const capped = source.length > COPILOT_MARKDOWN_LIMITS.chars
    ? source.slice(0, COPILOT_MARKDOWN_LIMITS.chars)
    : source;
  const lines = capped.replace(/\r\n?/g, "\n").split("\n").slice(0, COPILOT_MARKDOWN_LIMITS.lines);

  const blocks: CopilotBlock[] = [];
  let paragraph: CopilotInline[][] | null = null;
  let list: CopilotListBlock | null = null;

  const closeParagraph = () => {
    if (paragraph) {
      blocks.push({ kind: "paragraph", lines: paragraph });
      paragraph = null;
    }
  };
  const closeList = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };
  const closeAll = () => {
    closeParagraph();
    closeList();
  };

  let i = 0;
  while (i < lines.length && blocks.length < COPILOT_MARKDOWN_LIMITS.blocks) {
    const line = lines[i];

    if (looksLikeRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      closeAll();
      const head = splitRow(line).map(parseCopilotInline);
      const rows: CopilotInline[][][] = [];
      let j = i + 2;
      while (j < lines.length && looksLikeRow(lines[j]) && rows.length < COPILOT_MARKDOWN_LIMITS.tableRows) {
        rows.push(splitRow(lines[j]).map(parseCopilotInline));
        j++;
      }
      blocks.push({ kind: "table", head, rows });
      i = j;
      continue;
    }

    if (line.trim() === "") {
      closeAll();
      i++;
      continue;
    }

    if (RULE.test(line)) {
      closeAll();
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      closeAll();
      const body = heading[2].trim();
      if (body) {
        blocks.push({
          kind: "heading",
          level: heading[1].length <= 2 ? 2 : 3,
          inline: parseCopilotInline(body),
        });
      }
      i++;
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    const item = bullet ?? ordered;
    if (item) {
      closeParagraph();
      const wantOrdered = ordered !== null;
      // A "-" run and a "1." run are two lists, not one with mixed markers.
      if (list && list.ordered !== wantOrdered) closeList();
      const open: CopilotListBlock = list ?? { kind: "list", ordered: wantOrdered, items: [] };
      if (open.items.length < COPILOT_MARKDOWN_LIMITS.listItems) {
        open.items.push(parseCopilotInline(item[1].trim()));
      }
      list = open;
      i++;
      continue;
    }

    closeList();
    if (!paragraph) paragraph = [];
    paragraph.push(parseCopilotInline(line.trim()));
    i++;
  }

  closeAll();
  return blocks.slice(0, COPILOT_MARKDOWN_LIMITS.blocks);
}
