import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireSiteAccess } from "@/lib/auth/guard";
import { getPatientById } from "@/lib/dentally/read";
import { isChartDraftEnabled } from "@/lib/charting/write-gate";
import { isInArch } from "@/lib/charting/fdi";
import { parseSurfaces } from "@/lib/charting/surfaces";
import { CHART_COPY } from "@/lib/patient/tabs";
import {
  listDraft,
  upsertDraftEntry,
  deleteDraftEntry,
  clearDraft,
} from "@/lib/patient-chart/draft-repository";
import type { DraftEntry } from "@/lib/charting/types";

/**
 * The chart DRAFT: a clinician's in-progress selection, stored in OUR table.
 *
 * THIS ROUTE MUST NOT CONSULT canWriteChartToDentally(), and the omission is
 * deliberate rather than forgotten. That gate answers "may we write to Dentally",
 * whose answer is no, forever, because Dentally publishes no create route on any
 * charting resource. This route writes to public.chart_draft and never speaks to
 * Dentally at all. Wiring it to the wrong gate is the single confusion this build
 * is most exposed to, which is why both gates are named and separated in
 * src/lib/charting/write-gate.ts and why this comment exists.
 *
 * GET + POST with an action discriminator, NOT DELETE-with-a-body:
 * /api/patient-notes uses exactly this shape because DELETE bodies are handled
 * inconsistently across fetch and proxy layers, and deviating here would be a
 * deviation with no reason behind it.
 *
 * THE FEATURE IS OFF BY DEFAULT. With CHART_DRAFT_ENABLED unset every action
 * answers 503 with a sentence the screen can print, rather than a 500 or a
 * silent success that loses a clinician's work.
 */
export const dynamic = "force-dynamic";

/** The shape every handler needs before it can do anything, or a Response to return. */
interface Scope {
  siteId: string;
  patientId: string;
}

// Confirm (when enforcement is on) that the named patient actually belongs to the
// named site, so a caller holding site A cannot reach a site-B patient's draft by
// pairing site A with a foreign patient id. Fail closed. Identical to the guard on
// /api/patient-notes.
async function patientBelongsToSite(auth: unknown, patientId: string, siteId: string): Promise<boolean> {
  if (!auth) return true; // unenforced pilot: the detail route behaves the same
  const patient = await getPatientById(patientId);
  return Boolean(patient && patient.siteId === siteId);
}

/** getClient -> requireUser -> requireClientAccess -> requireSiteAccess ->
 *  patientBelongsToSite, in that order, failing closed at every step. */
async function authorise(
  clientSlug: string,
  siteId: string,
  patientId: string,
): Promise<Scope | Response> {
  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 404 });

  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const deniedClient = requireClientAccess(auth, client.id);
  if (deniedClient) return deniedClient;

  if (!siteId || !patientId) {
    return Response.json({ ok: false, error: "siteId and patientId are required" }, { status: 400 });
  }
  const deniedSite = requireSiteAccess(auth, siteId);
  if (deniedSite) return deniedSite;
  // A patient in another site does not exist as far as this caller is concerned:
  // the same 404 as a missing one, so a probe learns nothing from the difference.
  if (!(await patientBelongsToSite(auth, patientId, siteId))) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return { siteId, patientId };
}

/** The one 503, with the one sentence, from the tested copy module. */
function disabled(): Response {
  return Response.json({ ok: false, error: CHART_COPY.draftDisabled }, { status: 503 });
}

// GET /api/charting/draft?client=&siteId=&patientId=  -> this patient's draft
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const scope = await authorise(
    url.searchParams.get("client") ?? "",
    url.searchParams.get("siteId") ?? "",
    url.searchParams.get("patientId") ?? "",
  );
  if (scope instanceof Response) return scope;

  if (!isChartDraftEnabled()) return disabled();

  try {
    const draft = await listDraft(scope);
    return Response.json({ ok: true, draft });
  } catch {
    // ok:false, NEVER an empty draft. An empty list renders as "this clinician has
    // planned nothing", which is a claim about the clinician rather than about the
    // database, and it is the claim this whole build exists to avoid making.
    return Response.json({ ok: false, error: "could not read the chart draft" }, { status: 500 });
  }
}

interface Payload {
  client?: string;
  siteId?: string;
  patientId?: string;
  action?: string;
  tooth?: unknown;
  surfaces?: unknown;
  treatmentCode?: unknown;
  treatmentName?: unknown;
  dentition?: unknown;
}

/**
 * Validate the entry fields the caller supplied.
 *
 * A tooth outside the arch and an unknown surface letter are both REFUSED with a
 * 400 rather than stored. Storing them would put a value in a clinical-adjacent
 * table that no renderer can draw, which is how a draft silently loses a surface a
 * clinician believes is recorded.
 */
function readEntry(p: Payload): DraftEntry | string {
  const dentition = p.dentition === "deciduous" ? "deciduous" : "permanent";
  const tooth = typeof p.tooth === "number" ? p.tooth : Number(p.tooth);
  if (!Number.isInteger(tooth) || !isInArch(tooth, dentition)) {
    return "that tooth is not in the selected arch";
  }
  const treatmentCode = String(p.treatmentCode ?? "").trim();
  if (!treatmentCode) return "a treatment must be selected";

  // AN INDEX IS REFUSED HERE TOO, and that is not pedantry. parseSurfaces routes
  // integers into `indices` and letters into `surfaces`; DraftEntry stores letters
  // only. Checking `unrecognised` alone therefore ACCEPTED a numeric surface, wrote
  // the row without it, and returned 200 — a clinician told their plan was saved
  // while the surface they charted was silently dropped. Refusing is the safe half:
  // nothing in this application sends an index to the draft, because the draft is
  // ours and speaks in surface letters.
  const { surfaces, indices, unrecognised } = parseSurfaces(p.surfaces);
  if (unrecognised.length > 0 || indices.length > 0) {
    return "one of those surfaces is not recognised";
  }

  return {
    tooth,
    surfaces,
    treatmentCode,
    treatmentName: String(p.treatmentName ?? "").trim(),
    dentition,
  };
}

// POST /api/charting/draft  { client, siteId, patientId, action, ... }
//   action: "upsert" | "delete" | "clear"
export async function POST(request: Request): Promise<Response> {
  let payload: Payload;
  try {
    payload = (await request.json()) as Payload;
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const scope = await authorise(payload.client ?? "", payload.siteId ?? "", payload.patientId ?? "");
  if (scope instanceof Response) return scope;

  // Checked AFTER authorisation and BEFORE any work, so an unauthorised caller
  // cannot learn the feature flag's state from the response.
  if (!isChartDraftEnabled()) return disabled();

  const action = payload.action ?? "";
  try {
    if (action === "clear") {
      await clearDraft(scope);
      return Response.json({ ok: true, draft: await listDraft(scope) });
    }

    if (action === "delete") {
      const tooth = typeof payload.tooth === "number" ? payload.tooth : Number(payload.tooth);
      const treatmentCode = String(payload.treatmentCode ?? "").trim();
      if (!Number.isInteger(tooth) || !treatmentCode) {
        return Response.json({ ok: false, error: "tooth and treatmentCode are required" }, { status: 400 });
      }
      await deleteDraftEntry(scope, { tooth, treatmentCode });
      return Response.json({ ok: true, draft: await listDraft(scope) });
    }

    if (action === "upsert") {
      const entry = readEntry(payload);
      if (typeof entry === "string") return Response.json({ ok: false, error: entry }, { status: 400 });
      await upsertDraftEntry(scope, entry, null);
      return Response.json({ ok: true, draft: await listDraft(scope) });
    }

    return Response.json({ ok: false, error: "unknown action" }, { status: 400 });
  } catch {
    // ok:false with a status, so the client renders a FAILED state rather than an
    // empty one: a draft the clinician believes was saved and was not is exactly
    // the failure this build guards against.
    return Response.json({ ok: false, error: "could not save the chart draft" }, { status: 500 });
  }
}
