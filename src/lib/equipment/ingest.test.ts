import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { chunkManualPages, rankManualChunks } from "./chunk";
import { extractPdfText, PdfExtractionError, MAX_PDF_BYTES } from "./pdf-text";

vi.mock("server-only", () => ({}));

// ===========================================================================
// INGESTION, DRIVEN OVER A REAL MULTI-PAGE PDF.
//
// The fixture beside this file (`fixtures/steripro-22b-manual.pdf`) is a real,
// three-page, standards-conformant PDF: catalog, page tree, font resource, xref
// table, content streams with actual text-showing operators. It is a genuine
// autoclave operator manual in miniature — intended use, a safety section, daily
// operation, a fault-code table and a service section — because those are the
// five things a practice's manual has and the four questions this agent will be
// asked about it.
//
// It is checked in rather than generated at test time on purpose: a generator is
// a second implementation to keep correct, and the whole value of this test is
// that the extractor meets bytes it did not produce.
//
// WHAT THIS PROVES: that the real dependency, in the real node environment the
// suite runs in, turns a real PDF into per-page text; that the chunker preserves
// the page spans an answer cites; and that the ranker finds a fault code. If the
// dependency is ever swapped, this file is what says whether the swap worked.
// ===========================================================================

const FIXTURE = fileURLToPath(new URL("./fixtures/steripro-22b-manual.pdf", import.meta.url));
const bytes = new Uint8Array(readFileSync(FIXTURE));

describe("1. a real multi-page PDF is extracted, page by page", () => {
  it("reads all three pages and reports the page count", async () => {
    const result = await extractPdfText(bytes);
    expect(result.pageCount).toBe(3);
    expect(result.pages).toHaveLength(3);
    expect(result.extractor).toBe("unpdf");
    expect(result.totalChars).toBeGreaterThan(1000);
  });

  it("puts each page's own content on that page, and keeps the order", async () => {
    const { pages } = await extractPdfText(bytes);
    expect(pages[0]).toContain("SteriPro 22B Vacuum Autoclave");
    expect(pages[0]).toContain("INTENDED USE");
    expect(pages[1]).toContain("DAILY OPERATION");
    expect(pages[1]).toContain("distilled");
    expect(pages[2]).toContain("TROUBLESHOOTING");
    expect(pages[2]).toContain("E07");
    // Page 3's fault table must NOT have leaked onto page 1: a citation is only
    // worth anything if the page number is the page the text was on.
    expect(pages[0]).not.toContain("E07");
  });

  it("does not consume the caller's bytes (pdf.js detaches what it is handed)", async () => {
    // Pinned because the failure mode is invisible and confusing: the SECOND
    // extraction of the same buffer reports "that file was empty".
    const before = bytes.byteLength;
    await extractPdfText(bytes);
    expect(bytes.byteLength).toBe(before);
    await expect(extractPdfText(bytes)).resolves.toMatchObject({ pageCount: 3 });
  });

  it("recovers the manufacturer's own safety wording verbatim", async () => {
    // Load-bearing for the agent's refusals: when it declines to help defeat an
    // interlock it should be able to say the manual agrees, and it can only do
    // that if the warning survived extraction.
    const { pages } = await extractPdfText(bytes);
    expect(pages[0]).toMatch(/interlock must never be defeated/i);
  });
});

describe("2. the extractor refuses what it cannot read, with a sentence", () => {
  it("refuses an empty file", async () => {
    await expect(extractPdfText(new Uint8Array(0))).rejects.toBeInstanceOf(PdfExtractionError);
  });

  it("refuses a file that is not a PDF, on the magic number, before parsing", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    await expect(extractPdfText(jpeg)).rejects.toThrow(/not a PDF/i);
  });

  it("refuses an oversized file rather than truncating it", async () => {
    const huge = new Uint8Array(MAX_PDF_BYTES + 1);
    huge.set(new TextEncoder().encode("%PDF-"), 0);
    await expect(extractPdfText(huge)).rejects.toThrow(/larger than 25MB/i);
  });

  it("a damaged PDF fails with an owner-readable sentence, not a stack trace", async () => {
    const broken = new Uint8Array(new TextEncoder().encode("%PDF-1.4\nnot really a pdf at all\n"));
    await expect(extractPdfText(broken)).rejects.toBeInstanceOf(PdfExtractionError);
  });
});

describe("3. the manual becomes searchable chunks", () => {
  it("chunks the extracted pages, each carrying the page span it came from", async () => {
    const { pages } = await extractPdfText(bytes);
    const chunks = chunkManualPages(pages);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.pageFrom).toBeGreaterThanOrEqual(1);
      expect(chunk.pageTo).toBeLessThanOrEqual(3);
      expect(chunk.pageFrom).toBeLessThanOrEqual(chunk.pageTo);
      expect(chunk.body.length).toBeGreaterThan(0);
    }
    // Ordinals are dense and in order, which is what the "read the next passage"
    // path depends on.
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it("finds the fault code a nurse would actually type", async () => {
    const { pages } = await extractPdfText(bytes);
    const chunks = chunkManualPages(pages);

    const e07 = rankManualChunks("what does E07 mean", chunks);
    expect(e07.length).toBeGreaterThan(0);
    expect(e07[0].chunk.body).toContain("E07");
    expect(e07[0].chunk.body).toMatch(/vacuum test failed/i);
    // And the remedy is attached to the code, which is the whole reason chunks
    // overlap: a split between "E07 -" and "call the service engineer" would
    // produce a top hit that answers nothing.
    expect(e07[0].chunk.body).toMatch(/service engineer/i);

    const water = rankManualChunks("what water goes in the reservoir", chunks);
    expect(water[0].chunk.body).toMatch(/distilled/i);
  });

  it("returns nothing rather than a weak guess when the manual does not cover it", async () => {
    // The honest empty result is what lets the agent say "the manual does not
    // cover that, ring the engineer" instead of paraphrasing an unrelated page.
    const { pages } = await extractPdfText(bytes);
    const chunks = chunkManualPages(pages);
    expect(rankManualChunks("wifi password", chunks)).toEqual([]);
    expect(rankManualChunks("", chunks)).toEqual([]);
  });
});

describe("4. the chunker's own behaviour, independent of any PDF", () => {
  it("accumulates short pages instead of making a chunk per page", () => {
    const chunks = chunkManualPages(["Short page one text.", "Short page two text.", "Short page three."]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].pageFrom).toBe(1);
    expect(chunks[0].pageTo).toBe(3);
  });

  it("splits a page that is far too long, and keeps every character", () => {
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} about the sterilisation cycle and its timings.`).join("\n\n");
    const chunks = chunkManualPages([long]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.pageFrom === 1 && c.pageTo === 1)).toBe(true);
    // Nothing is lost in the split: the last paragraph is still findable.
    expect(rankManualChunks("Paragraph 59", chunks).length).toBeGreaterThan(0);
  });

  it("drops a page that holds nothing but whitespace, without shifting page numbers", () => {
    const chunks = chunkManualPages(["First page content here.", "   ", "Third page content here."]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].pageTo).toBe(3); // the blank page 2 did not renumber page 3
  });

  it("a manual with no text at all produces no chunks (a scan)", () => {
    // This is the state that must become `no_text` on the manual row, not a
    // manual the agent thinks it can read.
    expect(chunkManualPages(["", "  ", ""])).toEqual([]);
  });
});
