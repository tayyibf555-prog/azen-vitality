// ===========================================================================
// CHUNKING AND SEARCHING A MANUAL.
//
// WHY CHUNKS RATHER THAN THE WHOLE DOCUMENT. A 90-page autoclave manual is far
// more text than belongs in a prompt, and most of it is irrelevant to "what does
// E04 mean". So the manual is split once, at upload, into passages of roughly a
// screenful, and the agent's `search_manual` tool retrieves the handful that
// match. The alternative — hand the model the whole manual — costs a fortune per
// question, blows the context on long manuals, and answers worse.
//
// WHY THE RANKER LOOKS LIKE THE PRACTICE BRAIN'S. `rankManualChunks` is
// deliberately the same shape as `rankNodes` in src/lib/practice-brain/retrieval.ts:
// tokenise, drop stop-words, score title/heading matches above body matches, cap
// the per-term contribution so one repeated word cannot dominate. A second
// ranking philosophy in one product is a second thing to tune and a second thing
// to be wrong about. It is keyword-only: there is no embedding call in the
// ingestion path, so uploading a manual costs nothing but the PDF parse, and the
// module works with no VOYAGE_API_KEY set (which is the state prod is in).
//
// WHY IT IS PURE. No database, no model, no clock — so `chunk.test.ts` drives the
// real chunker over the real fixture PDF and the real ranker over the result.
// ===========================================================================

/** A chunk before it has an id — what ingestion inserts. */
export interface ManualChunkDraft {
  pageFrom: number;
  pageTo: number;
  ordinal: number;
  body: string;
}

/**
 * Target size of one chunk, in characters.
 *
 * ~1,100 characters is a long paragraph or a short procedure: big enough that a
 * numbered troubleshooting step keeps its "what to do" attached to its "when",
 * small enough that six of them fit a prompt comfortably.
 */
const TARGET_CHARS = 1_100;
/** A chunk is never allowed past this, even if a page has no break in it. */
const HARD_MAX_CHARS = 1_800;
/**
 * Characters of the previous chunk repeated at the start of the next.
 *
 * The reason is specific: manuals put the fault code on one line and its remedy
 * on the next, and a split that lands between them produces one chunk that names
 * E07 without saying what to do and one that says what to do without naming E07.
 * Neither answers the question. The overlap costs a little storage and removes
 * the class.
 */
const OVERLAP_CHARS = 160;
/** Below this a "chunk" is a page number or a running header, not content. */
const MIN_CHUNK_CHARS = 40;

/**
 * Split one page into pieces no larger than HARD_MAX_CHARS, preferring to break
 * at a blank line, then at a line end, and only then mid-line.
 */
function splitLongPage(text: string): string[] {
  if (text.length <= HARD_MAX_CHARS) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > HARD_MAX_CHARS) {
    const window = rest.slice(0, HARD_MAX_CHARS);
    const atBlank = window.lastIndexOf("\n\n");
    const atLine = window.lastIndexOf("\n");
    const atSpace = window.lastIndexOf(" ");
    const cut =
      atBlank > TARGET_CHARS / 2 ? atBlank : atLine > TARGET_CHARS / 2 ? atLine : atSpace > 0 ? atSpace : HARD_MAX_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/**
 * Turn extracted pages into chunks, each remembering the page span it came from.
 *
 * Pages are ACCUMULATED, not chunked one-to-one: a manual whose pages are 300
 * characters each would otherwise produce a chunk per page, and a fault table
 * that runs across three of them would be split into three answers none of which
 * is complete.
 */
export function chunkManualPages(pages: string[]): ManualChunkDraft[] {
  const chunks: ManualChunkDraft[] = [];
  let buffer = "";
  let bufferFrom = 1;
  let bufferTo = 1;

  const flush = () => {
    const body = buffer.trim();
    buffer = "";
    if (body.length < MIN_CHUNK_CHARS) return;
    const previous = chunks[chunks.length - 1];
    const overlap = previous ? previous.body.slice(-OVERLAP_CHARS) : "";
    chunks.push({
      pageFrom: bufferFrom,
      pageTo: bufferTo,
      ordinal: chunks.length,
      // The overlap is prefixed rather than stored as a separate field: the chunk
      // IS what the model reads, so the continuity has to be inside it.
      body: overlap ? `${overlap.trim()}\n${body}` : body,
    });
  };

  pages.forEach((raw, index) => {
    const pageNumber = index + 1;
    const page = raw.trim();
    if (page.length === 0) return;

    for (const piece of splitLongPage(page)) {
      if (buffer.length === 0) {
        bufferFrom = pageNumber;
      }
      bufferTo = pageNumber;
      buffer = buffer.length === 0 ? piece : `${buffer}\n${piece}`;
      if (buffer.length >= TARGET_CHARS) flush();
    }
  });
  flush();

  return chunks;
}

// ---------------------------------------------------------------------------
// RETRIEVAL.
// ---------------------------------------------------------------------------

const STOP = new Set([
  "the", "a", "an", "of", "to", "and", "or", "is", "are", "in", "on", "for", "with", "it", "its",
  "how", "do", "does", "what", "when", "where", "why", "my", "our", "we", "you", "i", "can", "should",
  "this", "that", "there", "be", "been", "has", "have", "not", "no", "if", "at", "as", "from", "by",
]);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

export interface RankedChunk<T extends ManualChunkDraft = ManualChunkDraft> {
  chunk: T;
  score: number;
}

/**
 * Rank chunks against a question.
 *
 * FAULT CODES ARE WEIGHTED HARDEST, and that is the one departure from the
 * practice brain's ranker. "E04" is the single most useful token a person can
 * type at this agent, it is short, and a plain frequency score buries it under a
 * chunk that happens to say "error" eight times. A token that looks like a fault
 * code (a letter and digits, or a bare number of two or more digits) scores
 * heavily on an exact hit and nothing at all otherwise.
 */
export function rankManualChunks<T extends ManualChunkDraft>(
  query: string,
  chunks: T[],
  limit = 5,
): RankedChunk<T>[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const codes = terms.filter((t) => /^[a-z]{0,2}\d{2,4}$/.test(t));

  return chunks
    .map((chunk) => {
      const body = chunk.body.toLowerCase();
      let score = 0;
      for (const term of terms) {
        const hits = body.split(term).length - 1;
        if (hits === 0) continue;
        score += Math.min(hits, 3);
        // A term in the first line of a chunk is usually its heading.
        if (body.slice(0, 80).includes(term)) score += 2;
      }
      for (const code of codes) {
        if (new RegExp(`(^|[^a-z0-9])${code}([^a-z0-9]|$)`).test(body)) score += 8;
      }
      return { chunk, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.ordinal - b.chunk.ordinal)
    .slice(0, limit);
}
