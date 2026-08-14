import { getClient } from "@/lib/mock/clients";
import {
  requireUser,
  requireClientAccess,
  requireSiteAccess,
  requireModuleApiAccess,
  requireClinicalWriteRole,
} from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import type { Capability } from "@/lib/capabilities/keys";
import { getPatientById } from "@/lib/dentally/read";
import { isPerioEnabled, PERIO_COPY } from "@/lib/perio/gate";
// bpe.ts owns the sextant vocabulary for the whole module — SEXTANTS, its
// labels and sextantOfTooth all come from there, never from a second table.
import {
  SEXTANTS,
  SEXTANT_LABEL,
  DEFAULT_PROBE,
  isBpeCode,
  parseBpeScore,
  scoreBpeExam,
  sextantOfTooth,
} from "@/lib/perio/bpe";
import { validatePocketChart } from "@/lib/perio/pocket-chart";
import type { PocketChartInput, SiteMeasurementInput, ToothRecordInput } from "@/lib/perio/pocket-chart";
import {
  saveBpeExam,
  listBpeExams,
  latestBpeExam,
  retractBpeExam,
  savePerioChart,
  listPerioChartHeaders,
  getPerioChart,
  latestPerioCharts,
  retractPerioChart,
  PerioDisabledError,
  PerioRefusedError,
  type PerioScope,
  type NewBpeExam,
  type NewPerioChart,
  type PerioChartTrigger,
  type RecordedDiagnosis,
} from "@/lib/perio/repository";
import type {
  BpeCode,
  BpeObservation,
  BpeScore,
  ClinicianRef,
  PerioAttribution,
  PerioGrade,
  PerioProbe,
  PerioStage,
  SextantId,
  SextantStatus,
} from "@/lib/perio/types";
import type { PerioExtent } from "@/lib/perio/diagnosis";

/**
 * PERIODONTAL RECORDS. The one part of this platform that is not a mirror.
 *
 * Dentally's API exposes no periodontal resource at all, so nothing here reads
 * from or writes to Dentally: every row this route stores is AUTHORED in this
 * platform, which makes it the system of record for that data the moment
 * PERIO_ENABLED is set. That is why the feature ships off, why every write is
 * attributed to a named clinician, and why every successful response carries the
 * FP17 double-entry notice rather than letting the screen forget it.
 *
 * THE 503 IS THE POINT OF THE DISABLED PATH. Not a 404, which says the feature
 * does not exist, and above all not an empty 200, which a caller renders as
 * "this patient has no periodontal findings" -- indistinguishable from a healthy
 * BPE 0, and the exact false completeness CHARTING.md 6.3 is written about.
 *
 * THE CLINICAL RULES ARE NOT RE-IMPLEMENTED HERE. Sextant membership, code
 * validity, the highest-code roll-up, implant and monitoring refusals and every
 * chart-level rule come from src/lib/perio/bpe.ts and pocket-chart.ts, which are
 * pure and tested. This file does the job a route actually owns: turning an
 * untrusted body into those modules' input types, refusing what they refuse, and
 * scoping every read and write to one patient in one site.
 *
 * GET  /api/perio/bpe?client=&siteId=&patientId=      -> history + the standing BPE
 * GET  /api/perio/charts?...                          -> 6-point chart history (headers)
 * GET  /api/perio/chart?...&id=                       -> one chart in full
 * GET  /api/perio/comparison?...                      -> this chart and the last, in full
 * POST /api/perio/bpe        { ...scope, scores | observations, ... }
 * POST /api/perio/chart      { ...scope, sextants, teeth, ... }
 * POST /api/perio/retract    { ...scope, kind, id, reason }
 */
export const dynamic = "force-dynamic";

const MAX_NOTES = 5000;
const MAX_REASON = 1000;
/** Five minutes of clock skew. Beyond that, a future examination is a typo. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const PROBES: readonly PerioProbe[] = ["who-621", "who-cpi", "other"];
const UNSCORABLE: readonly SextantStatus[] = ["insufficient-teeth", "no-teeth"];
const TRIGGERS: readonly PerioChartTrigger[] = ["bpe-3", "bpe-4", "maintenance-annual", "other"];
const STAGES: readonly PerioStage[] = ["I", "II", "III", "IV"];
const GRADES: readonly PerioGrade[] = ["A", "B", "C"];
const EXTENTS: readonly PerioExtent[] = ["localised", "generalised", "molar-incisor"];

type Payload = Record<string, unknown>;
type Failed = { error: string };

function failed(value: unknown): value is Failed {
  return Boolean(value) && typeof value === "object" && "error" in (value as object);
}
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function isSextantId(v: unknown): v is SextantId {
  return typeof v === "string" && (SEXTANTS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Authorisation. Identical in shape and in order to /api/charting/draft and
// /api/patient-notes, failing closed at every step.
// ---------------------------------------------------------------------------

interface Authorised {
  scope: PerioScope;
  /** null when auth enforcement is off (no service-role key). Reads still work. */
  clinician: ClinicianRef | null;
}

async function patientBelongsToSite(auth: unknown, patientId: string, siteId: string): Promise<boolean> {
  if (!auth) return true; // unenforced pilot: the detail route behaves the same
  const patient = await getPatientById(patientId);
  return Boolean(patient && patient.siteId === siteId);
}

async function authorise(
  clientSlug: string,
  siteId: string,
  patientId: string,
  opts?: { write?: boolean; capability?: Capability },
): Promise<Authorised | Response> {
  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 404 });

  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const deniedClient = requireClientAccess(auth, client.id);
  if (deniedClient) return deniedClient;

  // THE MODULE LOCK. The perio chart is a tab of the patient record, so it belongs
  // to the "patients" module; the checks around it are TENANCY checks and admit
  // every role attached to this practice. Without this line a `client_staff`
  // login — a nurse or a receptionist — could read and write it.
  const moduleDenied = requireModuleApiAccess(auth, "patients");
  if (moduleDenied) return moduleDenied;

  // THE CLINICAL-WRITE LOCK, on writes only. Recording a periodontal finding, or retracting one, is a clinical
  // act: it becomes part of the patient's clinical record and is attributed to
  // whoever made it (GDC 4.1.4). So writes are clinician + owner + agency. The
  // coordinator keeps the READ and loses the write — a deliberate narrowing of
  // what this route accepted before, not an oversight.
  if (opts?.write) {
    const writeDenied = requireClinicalWriteRole(auth);
    if (writeDenied) return writeDenied;
    // AND THE PER-PERSON GATE. The role list says a clinician may author here;
    // this says which clinician may, and which of the two acts on this route they
    // may perform — recording an exam and RETRACTING one are different keys.
    if (opts.capability) {
      const capabilityDenied = await requireCapability(auth, opts.capability);
      if (capabilityDenied) return capabilityDenied;
    }
  }

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
  return {
    scope: { siteId, patientId },
    // gdcNumber is null because app_user does not hold one. ClinicianRef says a
    // null is allowed and a fabricated one is not, so nothing is invented here.
    clinician: auth ? { id: auth.id, name: auth.name, gdcNumber: null } : null,
  };
}

/** The one 503 for a switched-off feature, naming the variable that switches it on. */
function disabled(): Response {
  return Response.json({ ok: false, error: PERIO_COPY.disabled }, { status: 503 });
}

function badRequest(message: string): Response {
  return Response.json({ ok: false, error: message }, { status: 400 });
}

/** Several sentences at once, because a hygienist fixing a chart should see
 *  everything wrong with it rather than one problem per round trip. */
function refused(issues: string[]): Response {
  return Response.json({ ok: false, error: issues[0], issues }, { status: 400 });
}

/** Every successful response carries the FP17 consequence. Not decoration:
 *  while claims go out of Dentally, a score recorded here is entered twice. */
function ok(body: Record<string, unknown>): Response {
  return Response.json({ ok: true, notice: PERIO_COPY.doubleEntry, ...body });
}

/** Turns a repository throw into the right status, so a refused amendment reads
 *  as a 400 the clinician can act on rather than a 500 they cannot. */
function writeFailure(error: unknown): Response {
  if (error instanceof PerioDisabledError) return disabled();
  if (error instanceof PerioRefusedError) {
    return Response.json({ ok: false, error: error.message }, { status: 400 });
  }
  return Response.json({ ok: false, error: PERIO_COPY.saveFailed }, { status: 500 });
}

// ---------------------------------------------------------------------------
// Shared field parsing
// ---------------------------------------------------------------------------

/**
 * GDC 4.1.4 puts the treating clinician on the record, so a write with no
 * identifiable clinician is REFUSED rather than attributed to 'Team'. Reads are
 * unaffected: nobody is harmed by reading a record anonymously.
 *
 * `at` is when the EXAMINATION happened, which is not always when it was typed.
 */
function readAttribution(p: Payload, clinician: ClinicianRef | null): PerioAttribution | Failed | Response {
  if (!clinician) {
    return Response.json({ ok: false, error: PERIO_COPY.noAuthor }, { status: 503 });
  }
  const raw = p.recordedAt;
  if (raw === undefined || raw === null || raw === "") {
    return { clinician, at: new Date().toISOString() };
  }
  if (typeof raw !== "string") return { error: "recordedAt must be an ISO date and time" };
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return { error: "recordedAt must be an ISO date and time" };
  if (ms > Date.now() + FUTURE_TOLERANCE_MS) {
    return { error: "an examination cannot be recorded as having happened in the future" };
  }
  return { clinician, at: new Date(ms).toISOString() };
}

interface ProbeChoice {
  probe: PerioProbe;
  probeNote: string | null;
}

/**
 * The probe, because the reading means nothing without it: the 3.5-5.5mm black
 * band that separates code 3 from code 4 is a property of the WHO 621, not of
 * the mouth. "other" with no note names nothing, so it is refused.
 */
function readProbe(p: Payload): ProbeChoice | Failed {
  const raw = p.probe ?? DEFAULT_PROBE;
  if (!PROBES.includes(raw as PerioProbe)) {
    return { error: `"${String(raw)}" is not a probe this record knows (${PROBES.join(", ")})` };
  }
  const probe = raw as PerioProbe;
  const note = typeof p.probeNote === "string" ? p.probeNote.trim() : "";
  if (probe === "other" && !note) {
    return { error: 'a probe of "other" has to say which probe was used' };
  }
  if (note.length > 200) return { error: "that probe note is too long" };
  return { probe, probeNote: note || null };
}

function readNotes(p: Payload): string | null | Failed {
  const raw = p.notes;
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return { error: "notes must be text" };
  if (raw.length > MAX_NOTES) return { error: "those notes are too long" };
  return raw.trim() || null;
}

/**
 * The amendment pair. GDC 4.1.5 requires an amendment to be clearly MARKED, and
 * a mark with no reason is not a mark -- so an amendment without a reason is
 * refused rather than stored as an unexplained new version.
 */
function readAmendment(p: Payload): { supersedesId: string | null; amendmentReason: string | null } | Failed {
  const rawId = p.supersedesId;
  const rawReason = p.amendmentReason;
  if (rawId === undefined || rawId === null || rawId === "") {
    if (typeof rawReason === "string" && rawReason.trim()) {
      return { error: "an amendment reason needs the supersedesId of the record being amended" };
    }
    return { supersedesId: null, amendmentReason: null };
  }
  if (typeof rawId !== "string") return { error: "supersedesId must be an id" };
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (!reason) {
    return { error: "an amendment must say why it was made, and that reason is kept on the record" };
  }
  if (reason.length > MAX_REASON) return { error: "that amendment reason is too long" };
  return { supersedesId: rawId, amendmentReason: reason };
}

// ---------------------------------------------------------------------------
// BPE
// ---------------------------------------------------------------------------

interface SextantResults {
  scores: Record<SextantId, BpeScore | null>;
  statuses: Record<SextantId, SextantStatus>;
}

/**
 * THE GRID PATH: six boxes, which is how a BPE is actually typed.
 *
 * Every code goes through parseBpeScore, so "3*" and 3 and "4" all mean what
 * bpe.ts says they mean and nothing else parses. A sextant with no score must
 * SAY WHY -- "insufficient-teeth" or "no-teeth" -- because an unrecorded sextant
 * defaulted to 0 is a healthy reading nobody took, and defaulted to unscorable is
 * a claim about the patient's dentition nobody made.
 */
function readSextantGrid(p: Payload): SextantResults | Failed {
  const rawScores = asRecord(p.scores);
  if (!rawScores) return { error: "a BPE records all six sextants" };
  const rawStatuses = asRecord(p.statuses) ?? {};

  const scores = {} as Record<SextantId, BpeScore | null>;
  const statuses = {} as Record<SextantId, SextantStatus>;

  for (const sextant of SEXTANTS) {
    const label = SEXTANT_LABEL[sextant];
    const rawStatus = rawStatuses[sextant];
    const rawScore = rawScores[sextant];
    const hasScore = rawScore !== undefined && rawScore !== null && rawScore !== "";

    if (!hasScore) {
      if (!UNSCORABLE.includes(rawStatus as SextantStatus)) {
        return {
          error:
            `The ${label} sextant has no score. Say why it could not be scored ` +
            `(${UNSCORABLE.join(" or ")}); an unscored sextant must never read as a 0.`,
        };
      }
      scores[sextant] = null;
      statuses[sextant] = rawStatus as SextantStatus;
      continue;
    }

    if (typeof rawScore !== "string" && typeof rawScore !== "number") {
      return { error: `The ${label} sextant: "${String(rawScore)}" is not a BPE code.` };
    }
    const score = parseBpeScore(rawScore);
    if (!score) {
      return {
        error:
          `The ${label} sextant: "${String(rawScore)}" is not a BPE code. ` +
          `Codes run 0 to 4, with * added for furcation, as in "3*".`,
      };
    }
    if (rawStatus !== undefined && rawStatus !== "scorable") {
      return { error: `The ${label} sextant carries a score, so it cannot also be ${String(rawStatus)}.` };
    }
    scores[sextant] = score;
    statuses[sextant] = "scorable";
  }
  return { scores, statuses };
}

/** One reading, as it comes off the wire, for the observation path. */
function readObservation(raw: unknown, index: number): BpeObservation | Failed {
  const obj = asRecord(raw);
  if (!obj) return { error: `reading ${index + 1} is not a reading` };
  const code = obj.code;
  if (typeof code !== "number" || !isBpeCode(code)) {
    return { error: `reading ${index + 1}: "${String(code)}" is not a BPE code (0 to 4)` };
  }
  const tooth = obj.tooth;
  const sextant = obj.sextant;
  if (tooth !== undefined && tooth !== null && typeof tooth !== "number") {
    return { error: `reading ${index + 1}: tooth must be an FDI number` };
  }
  if (sextant !== undefined && sextant !== null && !isSextantId(sextant)) {
    return { error: `reading ${index + 1}: "${String(sextant)}" is not a sextant` };
  }
  if ((tooth === undefined || tooth === null) && !isSextantId(sextant)) {
    return { error: `reading ${index + 1} names neither a tooth nor a sextant` };
  }
  return {
    tooth: typeof tooth === "number" ? tooth : null,
    sextant: isSextantId(sextant) ? sextant : null,
    code: code as BpeCode,
    furcation: obj.furcation === true,
  };
}

function readNumbers(raw: unknown): number[] {
  return Array.isArray(raw) ? raw.filter((v): v is number => typeof v === "number") : [];
}

// ---------------------------------------------------------------------------
// The 6-point chart
// ---------------------------------------------------------------------------

/**
 * Build the input pocket-chart.ts validates, WITHOUT sanitising it first.
 *
 * The raw site object is spread through on purpose. validatePocketChart refuses
 * a typed attachment loss by checking for a `cal` / `attachmentLoss` /
 * `clinicalAttachmentLevel` key, and it can only do that if the key survives the
 * journey. Rebuilding a clean object here would silently drop the very field the
 * clinician needs to be told about -- and a 200 whose stored CAL disagrees with
 * what was sent is how a clinician comes to trust a number nobody wrote.
 */
function readChartInput(
  p: Payload,
  recorded: PerioAttribution,
  probe: ProbeChoice,
  amendment: { supersedesId: string | null; amendmentReason: string | null },
): PocketChartInput | Failed {
  const rawSextants = Array.isArray(p.sextants) ? p.sextants : null;
  if (!rawSextants) return { error: "a chart must say which sextants it covers" };

  const rawTeeth = Array.isArray(p.teeth) ? p.teeth : null;
  if (!rawTeeth || rawTeeth.length === 0) return { error: "a chart records at least one tooth" };

  const teeth: ToothRecordInput[] = [];
  for (const rawTooth of rawTeeth) {
    const obj = asRecord(rawTooth);
    if (!obj) return { error: "each tooth needs a number and its sites" };
    const rawSites = Array.isArray(obj.sites) ? obj.sites : [];
    const sites: SiteMeasurementInput[] = [];
    for (const rawSite of rawSites) {
      const site = asRecord(rawSite);
      if (!site) return { error: `tooth ${String(obj.tooth)}: each site needs a reading` };
      // Cast rather than construct: see the note above. SiteMeasurementInput bans
      // a CAL at the type level, which is exactly why an object that carries one
      // cannot be built here -- but it still has to REACH the validator.
      sites.push(site as unknown as SiteMeasurementInput);
    }
    teeth.push({
      tooth: typeof obj.tooth === "number" ? obj.tooth : Number(obj.tooth),
      mobility: (obj.mobility ?? null) as ToothRecordInput["mobility"],
      furcation: (obj.furcation ?? null) as ToothRecordInput["furcation"],
      sites,
    });
  }

  return {
    sextants: rawSextants as SextantId[],
    teeth,
    recorded,
    probe: probe.probe,
    supersedesId: amendment.supersedesId,
    amendmentReason: amendment.amendmentReason,
  };
}

/**
 * The one chart rule validatePocketChart does not cover, and the dangerous
 * direction.
 *
 * It already refuses a tooth charted OUTSIDE the declared sextants. The reverse
 * -- a sextant declared and then charted in no tooth -- is what reads to the next
 * clinician as "the upper left was examined and was fine". Where a sextant is
 * edentulous or was not examined, it is simply not declared.
 */
function unbackedSextants(input: PocketChartInput): string[] {
  const charted = new Set<SextantId>();
  for (const tooth of input.teeth) {
    const sextant = sextantOfTooth(tooth.tooth);
    if (sextant) charted.add(sextant);
  }
  return input.sextants
    .filter((sextant) => isSextantId(sextant) && !charted.has(sextant))
    .map(
      (sextant) =>
        `This chart says it covers the ${SEXTANT_LABEL[sextant]} sextant but records no teeth there. ` +
        `Chart those teeth, or do not declare the sextant.`,
    );
}

function readDiagnosis(raw: unknown): RecordedDiagnosis | null | Failed {
  const obj = asRecord(raw);
  if (!obj) return null;
  const stage = (obj.stage ?? null) as PerioStage | null;
  const grade = (obj.grade ?? null) as PerioGrade | null;
  const extent = (obj.extent ?? null) as PerioExtent | null;
  if (stage !== null && !STAGES.includes(stage)) {
    return { error: "a periodontitis stage is I, II, III or IV" };
  }
  if (grade !== null && !GRADES.includes(grade)) {
    return { error: "a periodontitis grade is A, B or C" };
  }
  if (extent !== null && !EXTENTS.includes(extent)) {
    return { error: `extent is ${EXTENTS.join(", ")}` };
  }
  if (stage === null && grade === null && extent === null) return null;
  return { stage, grade, extent };
}

// ===========================================================================
// GET
// ===========================================================================

const GET_ACTIONS = new Set(["bpe", "charts", "chart", "comparison"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await params;
  if (!GET_ACTIONS.has(action)) {
    return Response.json({ ok: false, error: "unknown action" }, { status: 404 });
  }

  const url = new URL(request.url);
  const auth = await authorise(
    url.searchParams.get("client") ?? "",
    url.searchParams.get("siteId") ?? "",
    url.searchParams.get("patientId") ?? "",
  );
  if (auth instanceof Response) return auth;

  // Checked AFTER authorisation and before any work, so an unauthorised caller
  // cannot learn the practice's feature state from the response.
  if (!isPerioEnabled()) return disabled();

  try {
    if (action === "bpe") {
      const [exams, latest] = await Promise.all([
        listBpeExams(auth.scope),
        latestBpeExam(auth.scope),
      ]);
      return ok({ exams, latest });
    }
    if (action === "charts") {
      return ok({ charts: await listPerioChartHeaders(auth.scope) });
    }
    if (action === "chart") {
      const id = url.searchParams.get("id") ?? "";
      if (!id) return badRequest("id is required");
      const chart = await getPerioChart(auth.scope, id);
      if (!chart) return Response.json({ ok: false, error: "not found" }, { status: 404 });
      return ok({ chart });
    }
    // comparison: this chart and the one before it, which is the whole clinical
    // point -- a single chart is nearly useless, the change is the finding.
    const charts = await latestPerioCharts(auth.scope, 2);
    return ok({ latest: charts[0] ?? null, previous: charts[1] ?? null });
  } catch (error) {
    if (error instanceof PerioDisabledError) return disabled();
    // ok:false, NEVER an empty list. An empty periodontal result renders as
    // "this patient has no periodontal findings", which is indistinguishable
    // from a healthy BPE 0 and is a claim about the patient rather than about
    // the database.
    return Response.json({ ok: false, error: PERIO_COPY.readFailed }, { status: 500 });
  }
}

// ===========================================================================
// POST
// ===========================================================================

const POST_ACTIONS = new Set(["bpe", "chart", "retract"]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await params;
  if (!POST_ACTIONS.has(action)) {
    return Response.json({ ok: false, error: "unknown action" }, { status: 404 });
  }

  let payload: Payload;
  try {
    payload = (await request.json()) as Payload;
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const auth = await authorise(
    String(payload.client ?? ""),
    String(payload.siteId ?? ""),
    String(payload.patientId ?? ""),
    {
      write: true,
      // Retraction is its OWN capability: withdrawing an entry from the clinical
      // record is the act an inspector asks about by name, and a practice may want
      // it held by fewer people than recording one.
      capability: action === "retract" ? "clinical.record.retract" : "clinical.perio.write",
    },
  );
  if (auth instanceof Response) return auth;

  if (!isPerioEnabled()) return disabled();

  const recorded = readAttribution(payload, auth.clinician);
  if (recorded instanceof Response) return recorded;
  if (failed(recorded)) return badRequest(recorded.error);

  try {
    if (action === "bpe") return await postBpe(payload, auth.scope, recorded);
    if (action === "chart") return await postChart(payload, auth.scope, recorded);
    return await postRetract(payload, auth.scope, recorded.clinician);
  } catch (error) {
    return writeFailure(error);
  }
}

async function postBpe(
  payload: Payload,
  scope: PerioScope,
  recorded: PerioAttribution,
): Promise<Response> {
  if (payload.version !== undefined) {
    return badRequest("versions are assigned when a record is written and cannot be set by a caller");
  }
  const probe = readProbe(payload);
  if (failed(probe)) return badRequest(probe.error);
  const notes = readNotes(payload);
  if (failed(notes)) return badRequest(notes.error);
  const amendment = readAmendment(payload);
  if (failed(amendment)) return badRequest(amendment.error);

  let results: SextantResults | Failed;
  let requirement: unknown = null;
  let notices: { severity: string; message: string }[] = [];

  if (Array.isArray(payload.observations)) {
    // THE READING PATH: individual probings, rolled up by bpe.ts. This is the
    // path that can refuse -- probing an implant, or using a BPE to monitor a
    // patient already under periodontal care -- because only here does the
    // platform know which tooth each reading came from.
    const observations: BpeObservation[] = [];
    for (const [index, raw] of payload.observations.entries()) {
      const observation = readObservation(raw, index);
      if (failed(observation)) return badRequest(observation.error);
      observations.push(observation);
    }
    const context = asRecord(payload.context) ?? {};
    const result = scoreBpeExam({
      context: {
        presentTeeth: readNumbers(context.presentTeeth),
        implantTeeth: readNumbers(context.implantTeeth),
        underPeriodontalCare: context.underPeriodontalCare === true,
        previousExamCount:
          typeof context.previousExamCount === "number" ? context.previousExamCount : 0,
      },
      observations,
      probe: probe.probe,
      probeNote: probe.probeNote,
      recorded,
    });
    notices = result.notices;
    requirement = result.requirement;

    // A REFUSAL FROM THE CLINICAL LAYER BLOCKS THE WRITE. bpe.ts grades its own
    // notices, and "refusal" means the reading must not be recorded this way --
    // BPE is never used around implants, and it cannot measure treatment
    // response. Storing it anyway would make the refusal decorative.
    const refusals = result.notices.filter((n) => n.severity === "refusal");
    if (refusals.length > 0) return refused(refusals.map((n) => n.message));

    const statuses = {} as Record<SextantId, SextantStatus>;
    for (const scored of result.sextants) statuses[scored.sextant] = scored.status;
    results = { scores: result.scores, statuses };
  } else {
    results = readSextantGrid(payload);
    if (failed(results)) return badRequest(results.error);
  }

  const input: NewBpeExam = {
    recorded,
    probe: probe.probe,
    probeNote: probe.probeNote,
    scores: results.scores,
    statuses: results.statuses,
    notes,
    ...amendment,
  };
  const exam = await saveBpeExam(scope, input);
  // The requirement and the warnings travel with the saved exam: a code 3 means
  // that sextant is charted after initial therapy and a code 4 means full mouth
  // from the outset, and a screen that stored the score without saying so has
  // recorded the finding and lost the instruction.
  return ok({ exam, requirement, notices });
}

async function postChart(
  payload: Payload,
  scope: PerioScope,
  recorded: PerioAttribution,
): Promise<Response> {
  if (payload.version !== undefined) {
    return badRequest("versions are assigned when a record is written and cannot be set by a caller");
  }
  const probe = readProbe(payload);
  if (failed(probe)) return badRequest(probe.error);
  const notes = readNotes(payload);
  if (failed(notes)) return badRequest(notes.error);
  const amendment = readAmendment(payload);
  if (failed(amendment)) return badRequest(amendment.error);
  const diagnosis = readDiagnosis(payload.diagnosis);
  if (failed(diagnosis)) return badRequest(diagnosis.error);

  const rawTrigger = payload.trigger;
  const trigger =
    rawTrigger === undefined || rawTrigger === null ? null : (rawTrigger as PerioChartTrigger);
  if (trigger !== null && !TRIGGERS.includes(trigger)) {
    return badRequest(`"${String(rawTrigger)}" is not a charting trigger`);
  }

  const chartInput = readChartInput(payload, recorded, probe, amendment);
  if (failed(chartInput)) return badRequest(chartInput.error);

  // Every clinical rule at once, from the tested module: FDI validity, the
  // deciduous refusal, duplicate teeth and sites, a tooth outside the declared
  // sextants, FURCATION GRADES 1-4 AND MOBILITY STAGES 1-3 (Dentally's scales,
  // which replaced Hamp I-III and Miller 0-III), a furcation grade on a
  // single-rooted tooth, a typed CAL, depth and recession ranges, and a finding
  // at a site that was never probed.
  //
  // THE RANGES ARE NOT RESTATED HERE, deliberately. A second copy of "1 to 4" in
  // a route is a second place for the scale to be wrong, and this route already
  // learned that lesson with the CAL: the raw body reaches validatePocketChart
  // untouched precisely so the tested module is the only thing that judges it.
  const issues = [...validatePocketChart(chartInput), ...unbackedSextants(chartInput)];
  if (issues.length > 0) return refused(issues);

  const input: NewPerioChart = {
    recorded,
    probe: probe.probe,
    probeNote: probe.probeNote,
    sextants: chartInput.sextants as SextantId[],
    teeth: chartInput.teeth.map((t) => ({
      tooth: t.tooth,
      mobility: t.mobility,
      furcation: t.furcation,
      // Narrowed to the six stored fields ONLY HERE, after validation has seen
      // the raw object: anything else a caller sent is dropped rather than
      // stored, and a CAL among it has already been refused above.
      sites: t.sites.map((s) => ({
        site: s.site,
        probingDepth: s.probingDepth ?? null,
        recession: s.recession ?? null,
        bleeding: Boolean(s.bleeding),
        suppuration: Boolean(s.suppuration),
        plaque: Boolean(s.plaque),
      })),
    })),
    trigger,
    bpeExamId: typeof payload.bpeExamId === "string" && payload.bpeExamId ? payload.bpeExamId : null,
    diagnosis,
    notes,
    ...amendment,
  };
  return ok({ chart: await savePerioChart(scope, input) });
}

async function postRetract(
  payload: Payload,
  scope: PerioScope,
  clinician: ClinicianRef,
): Promise<Response> {
  const kind = payload.kind;
  const id = typeof payload.id === "string" ? payload.id : "";
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  if (kind !== "bpe" && kind !== "chart") return badRequest('kind must be "bpe" or "chart"');
  if (!id) return badRequest("id is required");
  // GDC 4.1.5: a withdrawal with no reason is a deletion wearing a timestamp.
  if (!reason) return badRequest("a retraction must say why, and that reason stays on the record");
  if (reason.length > MAX_REASON) return badRequest("that reason is too long");

  const retracted =
    kind === "bpe"
      ? await retractBpeExam(scope, id, reason, clinician)
      : await retractPerioChart(scope, id, reason, clinician);
  if (!retracted) {
    // Missing, out of this site, or already retracted -- all one answer, so a
    // probe cannot tell a foreign patient's record from a nonexistent one.
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return ok({ retracted });
}
