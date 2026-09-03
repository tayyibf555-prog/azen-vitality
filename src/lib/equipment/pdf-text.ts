// ===========================================================================
// PDF TEXT EXTRACTION — the one new dependency this lane adds.
//
// WHY A DEPENDENCY AT ALL. There was no PDF reader anywhere in this tree (the
// only PDFs the platform touches today are bytes it stores and hands back
// through a signed URL — the HR document vault — and it never looks inside one).
// Extracting text from a PDF is not a small job you write yourself: the text is
// in compressed content streams, positioned glyph by glyph, in fonts whose
// character codes mean nothing without the font's own ToUnicode map. A hand-
// rolled reader handles the simple files and silently returns gibberish for the
// rest, which for a MANUAL is the worst possible failure — the agent would then
// answer confidently from nonsense.
//
// WHY `unpdf` AND NOT THE OBVIOUS ALTERNATIVES.
//
// APPROVED AS THE TREE'S PDF TEXT EXTRACTOR (programme ruling, W1-D, 3 Sep 2026).
// The decision is settled; this note exists so the next lane that needs to read a
// PDF reaches for this module rather than re-running the comparison below.
//
//   unpdf (chosen)  MIT, unjs, ~2.5 MB installed, ZERO runtime dependencies. It
//                   is a serverless-targeted build of Mozilla's pdf.js — the same
//                   engine Firefox renders PDFs with, so the hard parts (fonts,
//                   encodings, encrypted-but-readable files) are the industry's
//                   implementation rather than ours. Works in plain Node, which
//                   is what both this app and vitest run in.
//   pdf-parse       depends on `pdfjs-dist` AND `@napi-rs/canvas`, a NATIVE
//                   binary. A native module in a Vercel serverless bundle is a
//                   platform-specific build artefact and a deployment hazard, and
//                   we need text, not rendering.
//   pdfjs-dist raw  the same engine, ~4x the install size, and we would be
//                   writing the serverless glue unpdf already is.
//
// WHAT IT CANNOT DO, AND WHAT WE DO ABOUT IT. A SCANNED manual is an image; there
// is no text in it to extract and no amount of library choice changes that. This
// module returns zero characters for one, `ingest.ts` records the manual as
// `no_text`, and the practice is told plainly that the file was a scan and the
// agent cannot read it. It does NOT quietly store an empty manual and let the
// agent behave as though it had one. OCR is a different product decision (a paid
// API, patient-free but still a third party) and is deliberately not made here.
// ===========================================================================

import "server-only";

/** Recorded on every manual row, so a future extractor swap is visible in the data. */
export const EXTRACTOR = "unpdf";

/** Hard ceilings. A manual outside these is refused with a sentence, never truncated silently. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_PDF_PAGES = 400;

export class PdfExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfExtractionError";
  }
}

export interface ExtractedPdf {
  /** One entry per page, in order. Empty string for a page with no text. */
  pages: string[];
  pageCount: number;
  extractor: string;
  /** Characters of text recovered across every page. Zero means a scan. */
  totalChars: number;
}

/**
 * Normalise what pdf.js hands back.
 *
 * Two things matter and both bite in real manuals: soft hyphens and the
 * non-breaking spaces that fill justified lines, which make "steri­liser" and
 * "steri liser" fail a keyword search that a person would expect to succeed; and
 * the run of blank lines a two-column layout leaves behind, which otherwise eat
 * a chunk's character budget with nothing in it.
 */
function tidy(raw: string): string {
  return raw
    .replace(/­/g, "") // soft hyphen
    .replace(/ /g, " ") // non-breaking space
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract per-page text from a PDF.
 *
 * Per PAGE rather than merged, because a chunk that can say "page 14" is a chunk
 * the agent can cite, and "the manual says, on page 14" is the difference between
 * an answer a nurse can check and an answer she has to trust.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<ExtractedPdf> {
  if (bytes.byteLength === 0) throw new PdfExtractionError("That file was empty.");
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new PdfExtractionError("That PDF is larger than 25MB. Split it, or upload the section that covers use and troubleshooting.");
  }
  // The magic number, checked before handing anything to the parser: a JPEG
  // renamed to .pdf should fail here with a sentence, not deep inside pdf.js.
  const header = new TextDecoder().decode(bytes.slice(0, 5));
  if (!header.startsWith("%PDF-")) throw new PdfExtractionError("That file is not a PDF.");

  // Imported lazily so the (2.5MB) parser is not pulled into every server bundle
  // that happens to touch this module's types.
  const { extractText, getDocumentProxy } = await import("unpdf");

  // A COPY, and this line is load-bearing. pdf.js takes OWNERSHIP of the typed
  // array it is handed and detaches the underlying ArrayBuffer, so the caller's
  // `bytes` becomes zero-length the moment extraction starts. The upload route
  // reads `file.size` before this and would be fine, but anything that extracted
  // twice — a retry, a test asserting two things about one fixture — would get
  // "that file was empty" on the second call and have no way to see why. Owning
  // the copy here means this function has no side effect on its argument.
  const owned = new Uint8Array(bytes);

  let pages: string[];
  let pageCount: number;
  try {
    const pdf = await getDocumentProxy(owned);
    pageCount = pdf.numPages;
    if (pageCount > MAX_PDF_PAGES) {
      throw new PdfExtractionError(`That PDF has ${pageCount} pages, which is more than we index (${MAX_PDF_PAGES}). Upload the operating and troubleshooting sections.`);
    }
    const result = await extractText(pdf, { mergePages: false });
    pages = (result.text as string[]).map(tidy);
  } catch (err) {
    if (err instanceof PdfExtractionError) throw err;
    // A password-protected or damaged file lands here. The practice gets a
    // sentence they can act on; the detail goes to the log, not to the screen.
    console.error("[equipment] PDF extraction failed", err);
    throw new PdfExtractionError("We could not read that PDF. If it is password protected, save an unprotected copy and try again.");
  }

  const totalChars = pages.reduce((sum, page) => sum + page.length, 0);
  return { pages, pageCount, extractor: EXTRACTOR, totalChars };
}
