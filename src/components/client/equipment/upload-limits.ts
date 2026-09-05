// ===========================================================================
// THE MANUAL UPLOAD, ON THE BROWSER'S SIDE OF THE WIRE.
//
// A PLAIN MODULE, NOT A "use client" ONE, and not part of the workspace file.
// Two reasons, and both are the reason this file exists at all:
//
//   1. `equipment-workspace.tsx` is a browser bundle, so it cannot import
//      `@/lib/equipment/pdf-text` — that module opens with `import "server-only"`
//      and pulling it into a client component is a build failure, by design.
//      The ceiling therefore has to exist a second time on this side, and a
//      number written twice is a number that drifts: `manual-upload-limit.test.ts`
//      reads `pdf-text.ts` as TEXT and fails the moment the two disagree.
//   2. Everything here is a decision with a right and a wrong answer, and a
//      decision inside a React event handler cannot be tested in this suite
//      (node env, `renderToStaticMarkup`, no DOM, no click). Out here it is
//      ordinary code with ordinary tests.
//
// WHAT WENT WRONG BEFORE IT (ruling W3/13, and the wave-3 handoff that named it).
// `uploadManual` did no size check and called `response.json()` unconditionally.
// Vercel refuses a request body over 4.5 MB AT THE EDGE — before the route, before
// its guards, before its own 413 — and answers with a non-JSON body. So the parse
// threw, the generic catch fired, and a practice manager uploading a 6 MB manual
// was told "We could not upload that manual. Please try again." — advice that can
// never work, for the one failure whose remedy (split it, or upload the operating
// and troubleshooting sections) we know exactly. That generic sentence was the
// precise outcome W3/13 was written to eliminate.
//
// The bytes never leave the browser now: an oversized file is refused here, and a
// 413 that arrives anyway — from the edge or from the route — still names the size.
// ===========================================================================

// ---------------------------------------------------------------------------
// THE CEILING. Keep in step with src/lib/equipment/pdf-text.ts, which owns it and
// enforces it; the test pins both halves (the figure AND the label) against that
// file's source. See its header for why the number is 4 MB and not 25.
// ---------------------------------------------------------------------------
/** The advertised ceiling, in the words the practice reads. */
export const MAX_PDF_SIZE_LABEL = "4MB";
/** The same ceiling as a number of bytes. */
export const MAX_PDF_BYTES = 4 * 1024 * 1024;

/**
 * The refusal sentence, word for word what `/api/equipment/manual` sends for its
 * own 413 (`TOO_LARGE` in that route). Identical on purpose: a practice that hits
 * the ceiling from the browser and a practice that hits it from the edge are told
 * the same thing and given the same next step. The test pins the two strings.
 */
export const OVERSIZE_MESSAGE = `That PDF is larger than ${MAX_PDF_SIZE_LABEL}. Upload the operating and troubleshooting sections.`;

/** Only for a failure we cannot name. Never for one we can — that was the bug. */
export const UPLOAD_FAILED = "We could not upload that manual. Please try again.";

/**
 * The upload went through and the answer did not. Neither "Uploaded." nor "we
 * could not upload" is true here, and saying either is how somebody re-uploads a
 * manual that is already stored, or gives up on one that is.
 */
export const UPLOAD_UNCONFIRMED =
  "That upload finished, but the server's answer could not be read, so this page cannot say whether the manual was stored. Reload the page to check.";

/** HTTP's own name for this, and the status both our route and Vercel's edge use. */
const PAYLOAD_TOO_LARGE = 413;

/**
 * The browser-side size check, run BEFORE the fetch.
 *
 * Returns the sentence to show, or null when the file is within the ceiling. The
 * server check stays exactly where it is and remains the authoritative one — this
 * one exists so the refusal is instant, costs no upload, and (above 4.5 MB) is the
 * only refusal the application is ever given the chance to write.
 */
export function oversizeRefusal(byteSize: number): string | null {
  return byteSize > MAX_PDF_BYTES ? OVERSIZE_MESSAGE : null;
}

/** The little of `Response` this needs, so a test can hand it a plain object. */
export interface ManualUploadReply {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export interface ManualUploadOutcome {
  /** True only when the server said so. Drives `router.refresh()`. */
  ok: boolean;
  /** What the practice reads. Always a sentence, never an empty string. */
  message: string;
}

function sentence(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Turn the route's answer — or the platform's — into one sentence and one boolean.
 *
 * THE CONTENT TYPE IS CHECKED BEFORE THE PARSE, because the bodies that matter
 * most here are not JSON: Vercel's FUNCTION_PAYLOAD_TOO_LARGE page, a gateway's
 * HTML 502. `response.json()` on one of those throws, and a throw at this point in
 * the old code was indistinguishable from the network being down.
 *
 * THE STATUS IS READ BEFORE THE BODY, so a 413 names the size whatever arrived
 * with it. That is the whole point: the one refusal we can explain is the one the
 * platform is most likely to hand us with nothing in it.
 */
export async function readManualUploadReply(response: ManualUploadReply): Promise<ManualUploadOutcome> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  let body: Record<string, unknown> | null = null;
  if (contentType.includes("application/json")) {
    try {
      const parsed = (await response.json()) as unknown;
      body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
  }
  // The route puts its own words in `message` on success and `error` on refusal;
  // prefer them, so a sentence written next to the rule that produced it is what
  // the practice reads rather than anything guessed out here.
  const said = body ? sentence(body.message) ?? sentence(body.error) : null;

  if (response.status === PAYLOAD_TOO_LARGE) return { ok: false, message: said ?? OVERSIZE_MESSAGE };
  if (!response.ok) return { ok: false, message: said ?? UPLOAD_FAILED };
  if (!body) return { ok: false, message: UPLOAD_UNCONFIRMED };
  // FAIL CLOSED on the flag: only an explicit `ok: true` refreshes the page.
  if (body.ok !== true) return { ok: false, message: said ?? UPLOAD_FAILED };
  return { ok: true, message: said ?? "Uploaded." };
}
