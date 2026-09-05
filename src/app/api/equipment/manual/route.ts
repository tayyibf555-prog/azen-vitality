import { requireUser, requireClientAccess, requireModuleApiAccess, requireApproverRole } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import type { Client as PracticeClient } from "@/lib/types";
import { getClient } from "@/lib/mock/clients";
import { chunkManualPages } from "@/lib/equipment/chunk";
import { extractPdfText, PdfExtractionError, MAX_PDF_BYTES, MAX_PDF_SIZE_LABEL } from "@/lib/equipment/pdf-text";
import { deleteManualForAsset, getAsset, replaceManual } from "@/lib/equipment/repository";
import { MANUAL_CHUNK_READ_CAP } from "@/lib/equipment/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ===========================================================================
// MANUAL INGESTION: one PDF, one asset.
//
// A SEPARATE ROUTE FROM THE MODULE'S OTHER ACTIONS because this one is multipart
// and they are all JSON, and a handler that has to sniff which it was given is a
// handler with a parsing bug waiting in it.
//
// WHAT HAPPENS TO THE FILE. It is read, its text is extracted (see
// src/lib/equipment/pdf-text.ts for why `unpdf`), split into searchable passages,
// and the passages are stored against the asset. THE BYTES ARE NOT KEPT — see
// migration 0098 for the copyright and provisioning reasons. So this endpoint
// writes no file anywhere, needs no Storage bucket, and leaves nothing to clean
// up if it fails halfway.
//
// AUTHORISATION: signed in, belongs to this practice, holds the 'equipment'
// module (owner + agency + practice manager, per the nav entry). NOT gated on the
// system toggle, deliberately: the manuals have to be loadable BEFORE the agent
// is switched on, or the agent's first day is spent with nothing to read.
// ===========================================================================

function bad(error: string, status = 400): Response {
  return Response.json({ ok: false, error }, { status });
}

// ---------------------------------------------------------------------------
// THE ONE SENTENCE THE PRACTICE READS ABOUT SIZE, and it is interpolated from
// the module's own constant rather than typed out (ruling W3/13).
//
// It was typed out, twice, and said "larger than 25MB" while the code enforced
// 4 MB: the ceiling moved in `pdf-text.ts` and these two literals did not, so a
// practice manager refused a 4.2 MB manual was told the limit was six times
// what it is — and the one action that would have worked (split it under 4 MB)
// was the action the sentence ruled out. `equipment-workspace.tsx` prints
// `data.error` verbatim and nothing else in the UI states a size, so THIS
// STRING IS THE ADVERTISED CEILING. Deriving it from MAX_PDF_SIZE_LABEL is what
// makes "advertise and enforce the same number" true by construction instead of
// by everyone remembering.
// ---------------------------------------------------------------------------
const TOO_LARGE = `That PDF is larger than ${MAX_PDF_SIZE_LABEL}. Upload the operating and troubleshooting sections.`;

// The slack allowed on top of the file itself for multipart framing (the field
// boundaries, the `client` and `assetId` parts, the filename header) when the
// only thing we have to judge by is Content-Length.
//
// IT MUST STAY BELOW VERCEL'S REQUEST-BODY CEILING or the check is dead code:
// the platform refuses a body over 4.5 MB at the edge, before this handler runs
// at all, so a threshold of MAX_PDF_BYTES + 2 MB (6 MB, what this was) could
// never be reached in production and every oversized upload paid to be buffered
// first. A quarter of a megabyte is orders of magnitude more than multipart
// framing costs and still leaves the whole window reachable.
const MULTIPART_SLACK_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// WHAT WAS STORED IS NOT WHAT WILL BE SEARCHED, and the practice is told so at
// upload time rather than finding out inside an answer (§0/5 and ruling W3/11:
// a truncated read never wears a complete read's clothes).
//
// `listChunksForAsset` stops at MANUAL_CHUNK_READ_CAP passages in page order,
// so on a very long manual the desk never ranks the back of the book. The
// answer-time half of this is already honest — `tools.ts` swaps "the manual
// does not cover this" for a sentence naming the part it searched — but "Stored
// 1,240 searchable passages" told an owner the whole book was in, and the one
// action that would have fixed it (upload the operating and troubleshooting
// section on its own) is the action nobody takes when they believe it worked.
//
// Same advice `pdf-text.ts` gives for a PDF over MAX_PDF_PAGES, deliberately:
// two ways of hitting the same wall should not read like two different problems.
// ---------------------------------------------------------------------------
function overCapNote(passages: number): string {
  return ` This manual is longer than the desk reads in one go: only the first ${MANUAL_CHUNK_READ_CAP} of those ${passages} passages will be searched, in page order, so the later pages will not be looked at. Upload the operating and troubleshooting sections on their own to be sure the desk can see them.`;
}

/**
 * The tenancy + module gate. A DISCRIMINATED union rather than an optional
 * `denied`, so a caller that forgets the early return is a compile error rather
 * than a route carrying on with `client` undefined.
 */
type AuthGate =
  | { denied: Response; auth?: undefined; client?: undefined }
  | { denied?: undefined; auth: AuthedUser | null; client: PracticeClient };

async function authorise(clientSlug: string): Promise<AuthGate> {
  const auth = await requireUser();
  if (auth instanceof Response) return { denied: auth };
  const client = clientSlug ? getClient(clientSlug) : undefined;
  if (!client) return { denied: bad("unknown client") };
  const clientDenied = requireClientAccess(auth, client.id);
  if (clientDenied) return { denied: clientDenied };
  // THE SLUG IS A STRING LITERAL, not the module's own constant, and that is on
  // purpose: `client-api-module-guard-coverage.test.ts` reads this file as TEXT
  // to prove the lock exists and to record WHICH module it locks. A constant
  // compiles identically and is invisible to that sweep, which would leave the
  // route guarded in the code and unguarded in the proof — the worse of the two
  // failures, because it looks fine from both sides.
  const moduleDenied = requireModuleApiAccess(auth, "equipment");
  if (moduleDenied) return { denied: moduleDenied };
  // THE WRITE LOCK. On the ruling of 3 Sep 2026 (W2-A/1) the 'equipment' module
  // is reachable by every authenticated role, so the module gate above no longer
  // denies anybody and cannot be the lock on this file. EVERY method here is a
  // write — uploading a manual, deleting one — so the guard is unconditional
  // rather than per action, unlike the [action] route next door.
  //
  // `requireApproverRole` = agency admin + practice owner + practice manager.
  // A nurse may READ a manual (the desk answers her from it) and may not replace
  // the document the desk answers everybody from.
  const writeDenied = requireApproverRole(auth);
  if (writeDenied) return { denied: writeDenied };
  return { auth, client };
}

export async function POST(request: Request): Promise<Response> {
  // A cheap Content-Length rejection before the body is read at all, so an
  // oversized upload is refused rather than buffered. The post-parse check below
  // is the authoritative one — Content-Length can be absent or wrong.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_PDF_BYTES + MULTIPART_SLACK_BYTES) {
    return bad(TOO_LARGE, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad("Expected a file upload");
  }

  const clientSlug = typeof form.get("client") === "string" ? (form.get("client") as string).trim() : "";
  const gate = await authorise(clientSlug);
  if (gate.denied) return gate.denied;
  const { auth, client } = gate;

  const assetId = typeof form.get("assetId") === "string" ? (form.get("assetId") as string).trim() : "";
  if (!assetId) return bad("No asset was named");

  // TENANCY ON THE ASSET, read with client_id in its own WHERE clause. The asset
  // id arrives from the browser, and this read is the only thing that makes it
  // this practice's asset.
  const asset = await getAsset(client.id, assetId);
  if (!asset) return bad("That asset is not on this practice's register", 404);

  const file = form.get("file");
  if (!(file instanceof File)) return bad("No file provided");
  if (form.getAll("file").length !== 1) return bad("Upload one manual at a time");
  if (file.size <= 0) return bad("That file appears to be empty");
  // THE AUTHORITATIVE CHECK. It fires before `extractPdfText`, so the corrected
  // sentence that module throws is unreachable over HTTP and this one is what a
  // practice actually reads.
  if (file.size > MAX_PDF_BYTES) {
    return bad(TOO_LARGE, 413);
  }

  let pages: string[];
  let pageCount: number;
  let extractor: string;
  let totalChars: number;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const extracted = await extractPdfText(bytes);
    ({ pages, pageCount, extractor, totalChars } = extracted);
  } catch (err) {
    // PdfExtractionError carries a sentence written for the practice. Anything
    // else is ours and gets the generic one.
    if (err instanceof PdfExtractionError) return bad(err.message);
    console.error("[equipment] manual upload failed", err);
    return bad("We could not read that manual. Please try again.", 500);
  }

  const chunks = chunkManualPages(pages);
  // A SCAN. There is no text in an image-only PDF, and the honest thing is to
  // record that state and TELL the practice, not to store an empty manual and let
  // the agent behave as though it had one.
  const status = chunks.length === 0 ? "no_text" : "ready";

  const stored = await replaceManual(
    {
      clientId: client.id,
      assetId,
      filename: (file.name || "manual.pdf").slice(0, 200),
      byteSize: file.size,
      pageCount,
      extractor,
      extractedChars: totalChars,
      status,
      actor: auth?.id ?? "owner",
    },
    chunks,
  );
  if (!stored.ok) return bad(stored.reason, 500);

  const storedLine = `Stored ${chunks.length} searchable passage${chunks.length === 1 ? "" : "s"} from ${pageCount} page${pageCount === 1 ? "" : "s"}.`;
  return Response.json({
    ok: true,
    status,
    pageCount,
    passages: chunks.length,
    // The cap the desk reads to, returned alongside the count so a caller can
    // say the same thing without re-deriving it from a sentence.
    searchCap: MANUAL_CHUNK_READ_CAP,
    searchedInFull: chunks.length <= MANUAL_CHUNK_READ_CAP,
    message:
      status === "no_text"
        ? "That PDF is a scan — it holds pictures of pages rather than text, so there is nothing for the desk to read. A text PDF from the manufacturer's website will work."
        : chunks.length > MANUAL_CHUNK_READ_CAP
          ? `${storedLine}${overCapNote(chunks.length)}`
          : storedLine,
  });
}

export async function DELETE(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }
  const clientSlug = typeof body.client === "string" ? body.client : "";
  const gate = await authorise(clientSlug);
  if (gate.denied) return gate.denied;
  const { client } = gate;

  const assetId = typeof body.assetId === "string" ? body.assetId.trim() : "";
  if (!assetId) return bad("No asset was named");
  const asset = await getAsset(client.id, assetId);
  if (!asset) return bad("That asset is not on this practice's register", 404);

  const ok = await deleteManualForAsset(client.id, assetId);
  return ok ? Response.json({ ok: true }) : bad("We could not remove that manual", 500);
}
