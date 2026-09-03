import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import type { Client as PracticeClient } from "@/lib/types";
import { getClient } from "@/lib/mock/clients";
import { chunkManualPages } from "@/lib/equipment/chunk";
import { extractPdfText, PdfExtractionError, MAX_PDF_BYTES } from "@/lib/equipment/pdf-text";
import { deleteManualForAsset, getAsset, replaceManual } from "@/lib/equipment/repository";

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
  return { auth, client };
}

export async function POST(request: Request): Promise<Response> {
  // A cheap Content-Length rejection before the body is read at all, so an
  // oversized upload is refused rather than buffered. The post-parse check below
  // is the authoritative one — Content-Length can be absent or wrong.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_PDF_BYTES + 2_000_000) {
    return bad("That PDF is larger than 25MB. Upload the operating and troubleshooting sections.", 413);
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
  if (file.size > MAX_PDF_BYTES) {
    return bad("That PDF is larger than 25MB. Upload the operating and troubleshooting sections.", 413);
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

  return Response.json({
    ok: true,
    status,
    pageCount,
    passages: chunks.length,
    message:
      status === "no_text"
        ? "That PDF is a scan — it holds pictures of pages rather than text, so there is nothing for the desk to read. A text PDF from the manufacturer's website will work."
        : `Stored ${chunks.length} searchable passage${chunks.length === 1 ? "" : "s"} from ${pageCount} page${pageCount === 1 ? "" : "s"}.`,
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
