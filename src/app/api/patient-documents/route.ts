import { getClient } from "@/lib/mock/clients";
import {
  requireUser,
  requireClientAccess,
  requireSiteAccess,
  requireModuleApiAccess,
} from "@/lib/auth/guard";
import { getPatientById } from "@/lib/dentally/read";
import { readDocumentUrl } from "@/lib/dentally/documents";

/**
 * Open ONE of a patient's Dentally documents, by fetching a LIVE link at click time.
 *
 * WHY THIS ROUTE EXISTS AT ALL, WHICH IS THE ONLY INTERESTING THING ABOUT IT.
 * /v1/patient_documents returns a `url` that is a presigned Amazon S3 link. Measured on
 * 2026-08-31, it carries X-Amz-Expires of 42033 and 42001 seconds — about eleven and a
 * half hours — with X-Amz-Date stamped at the instant of the read. So the link is
 * minted fresh per read and dies the same working day.
 *
 * Rendering that URL straight into the page would give links that work this afternoon
 * and fail tomorrow morning, and on a consent record a dead link does not read as "this
 * link expired", it reads as "the document is gone". So the record links HERE, and this
 * re-reads Dentally at the moment somebody clicks and redirects to whatever URL
 * Dentally mints then.
 *
 * IT IS A READ AND ONLY A READ. GET only — there is no POST/PUT/DELETE export here and
 * none may be added. These are signed clinical consent records; Dentally publishes no
 * write route for them and this platform has no business having one.
 *
 * THE KILL SWITCH IS NOT APPLIED, on the same reasoning src/app/api/patient-notes
 * records for notes: the owner switch gates the paths that SEND things to patients, so
 * that a halt stops something leaving the building. Nothing leaves here. What gates this
 * route instead is DENTALLY_DOCUMENTS_READ_ENABLED — readDocumentUrl returns null when
 * the documents read is off, so with the feature switched off this route can only 404,
 * and the record renders no link to it in the first place.
 *
 * IT FAILS CLOSED AT EVERY STEP, and the ORDER matters:
 *   1. unknown client                          -> 404
 *   2. no session (when enforcement is on)     -> the guard's own response
 *   3. wrong practice                          -> 403
 *   4. a role that may not reach the record    -> 403   (requireModuleApiAccess)
 *   5. a site the caller does not hold         -> 403
 *   6. a patient that is not on that site      -> 404
 *   7. a document id not on THAT patient's list-> 404   (inside readDocumentUrl)
 *
 * Step 7 is the one that closes the IDOR, and it is closed by CONSTRUCTION rather than
 * by a check somebody has to remember: readDocumentUrl takes a patientId, reads that
 * patient's own document list, and looks the id up inside it. There is no code path
 * that fetches a document by id alone, so a caller cannot pair their own patient with
 * somebody else's document id and be handed a signed link to a stranger's consent form.
 *
 * A 404 rather than a 403 on steps 6 and 7 is deliberate and mirrors the record's own
 * posture: a 403 would confirm that the patient, or the document, exists.
 */

export const dynamic = "force-dynamic";

// Confirm (when enforcement is on) that the named patient actually belongs to the named
// site, so a caller holding site A cannot reach a site-B patient's documents by pairing
// site A with a foreign patient id. Fail closed. Mirrors the IDOR guard on
// /api/patient-notes and on /api/dentally/patients/[id].
async function patientBelongsToSite(auth: unknown, patientId: string, siteId: string): Promise<boolean> {
  if (!auth) return true; // unenforced pilot: the sibling routes behave the same
  const patient = await getPatientById(patientId);
  return Boolean(patient && patient.siteId === siteId);
}

// GET /api/patient-documents?client=&siteId=&patientId=&documentId=
//   -> 302 to a freshly minted Dentally/S3 link
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const client = getClient(url.searchParams.get("client") ?? "");
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 404 });

  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const deniedClient = requireClientAccess(auth, client.id);
  if (deniedClient) return deniedClient;
  // THE MODULE LOCK. requireClientAccess admits every role attached to this practice,
  // so this line is the only one that asks whether the caller's ROLE may reach the
  // patient record at all. "patients" is the same slug the record's pages and the
  // practice-notes route gate on, so a document is exactly as reachable as the record
  // it is filed against and no more.
  const moduleDenied = requireModuleApiAccess(auth, "patients");
  if (moduleDenied) return moduleDenied;

  const siteId = url.searchParams.get("siteId") ?? "";
  const patientId = url.searchParams.get("patientId") ?? "";
  const documentId = url.searchParams.get("documentId") ?? "";
  if (!siteId || !patientId || !documentId) {
    return Response.json(
      { ok: false, error: "siteId, patientId and documentId are required" },
      { status: 400 },
    );
  }
  const deniedSite = requireSiteAccess(auth, siteId);
  if (deniedSite) return deniedSite;
  if (!(await patientBelongsToSite(auth, patientId, siteId))) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }

  let target: string | null = null;
  try {
    target = await readDocumentUrl(patientId, documentId);
  } catch (err) {
    // readDocumentUrl does not throw today (it degrades through readPatientDentallyDocuments,
    // which catches). Guarded anyway so a future change there cannot turn a clicked link
    // into an unhandled 500 on a clinical record.
    console.warn(`patient-documents: failed to resolve document ${documentId}`, err);
    target = null;
  }
  if (!target) {
    // Covers all three of: the read is switched off, the read failed just now, and the
    // document is not on this patient's list. They are deliberately NOT distinguished in
    // the response — telling an out-of-scope caller which one applies is what turns a
    // 404 into an oracle.
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }

  // 302, not 301. The link this redirects to expires within the day, so it must never
  // be cached by a browser or a proxy as the permanent home of this document — the next
  // click a month later has to come back through here for a fresh one. `no-store` says
  // the same thing to anything that ignores the status code.
  return new Response(null, {
    status: 302,
    headers: { Location: target, "Cache-Control": "no-store" },
  });
}
