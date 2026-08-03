import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { isPerioEnabled, PERIO_COPY } from "./gate";
import { SEXTANTS } from "./bpe";
import { SITE_IDS } from "./pocket-chart";
import type {
  BpeExamRecord,
  BpeScore,
  ClinicianRef,
  MobilityStage,
  FurcationGrade,
  PerioAttribution,
  PerioGrade,
  PerioProbe,
  PerioSiteId,
  PerioSiteMeasurement,
  PerioStage,
  PerioToothRecord,
  SextantId,
  SextantStatus,
  SixPointChart,
} from "./types";
import type { PerioExtent } from "./diagnosis";

// ===========================================================================
// public.perio_bpe_exam + public.perio_chart (+ its tooth and site rows) --
// the periodontal record this platform AUTHORS.
//
// THE ONE FACT THAT SHAPES EVERY LINE BELOW. Dentally's API exposes no
// periodontal resource of any kind, so unlike src/lib/patient-chart/
// draft-repository.ts -- which sits beside a read-only mirror and holds a
// clinician's scratch selection -- nothing here mirrors anything. These rows
// ARE the record. That is why they are versioned, append-only, attributed to a
// named clinician, and switched off by default.
//
// THE SHAPES ARE NOT INVENTED HERE. Everything crossing this boundary is the
// vocabulary of src/lib/perio/types.ts -- BpeExamRecord, SixPointChart,
// PerioToothRecord, SextantId, PerioSiteId, PerioProbe -- so a stored row
// round-trips through bpe.ts, pocket-chart.ts and diagnosis.ts with no
// translation layer. A repository that spoke its own dialect would put a
// mapping step between a clinical record and the tested code that reads it,
// which is a place for a reading to change on the way past.
//
// THREE DELIBERATE DIVERGENCES FROM draft-repository.ts, each with a reason:
//
// 1. WITH THE GATE OFF THIS THROWS, it does not return []. The draft repository
//    returns an empty array because an empty draft is a truthful answer: the
//    clinician has planned nothing on screen. An empty perio result is NOT a
//    truthful answer -- it reads as "this patient has no periodontal findings",
//    which is indistinguishable from a healthy BPE 0 and is exactly the false
//    completeness CHARTING.md 6.3 exists to prevent.
//
// 2. THE AUTHOR IS NOT OPTIONAL. The draft repository takes `actor: string |
//    null`. Here attribution is PerioAttribution, required by the type, so a
//    write with no named clinician cannot be expressed (GDC Standard 4.1.4).
//
// 3. NOTHING UPDATES AND NOTHING DELETES. An amendment inserts a new version
//    whose supersedesId names the one it replaces (GDC 4.1.5); a mistake is
//    retracted with a reason and stays readable. The database enforces this with
//    triggers, not with trust -- serviceClient() holds the service role and
//    bypasses RLS, but it does not bypass a trigger.
//
// EVERY QUERY IS SITE-SCOPED AND PATIENT-SCOPED IN THE QUERY ITSELF, including
// the ones that already have a row id. getPatientDetail had a confirmed
// site-scope IDOR; the fix pattern was to write the scope into the predicate
// rather than to check it once at the top of a caller, and this file follows it
// without exception.
// ===========================================================================

/** Which patient, in which site. Both halves are written into every predicate. */
export interface PerioScope {
  siteId: string;
  patientId: string;
}

/** Why this chart was taken. The protocol triggers plus the annual re-chart --
 *  the obligation most often missed, and a named allegation in negligence claims. */
export type PerioChartTrigger = "bpe-3" | "bpe-4" | "maintenance-annual" | "other";

/** The clinician's OWN 2017/18 diagnosis, when they have committed to one.
 *  suggestDiagnosis() never writes here: it shows its working and the clinician
 *  decides (PERIO.md 3.3). */
export interface RecordedDiagnosis {
  stage: PerioStage | null;
  grade: PerioGrade | null;
  extent: PerioExtent | null;
}

/** The fields every stored perio record carries beyond its clinical content. */
interface StoredEnvelope {
  /** 1-based, per (site, patient). Assigned by the database, never by a caller. */
  version: number;
  /** When the row was written, as against `recorded.at`, when the examination happened. */
  createdAt: string;
  /** Practice notes on the entry. Not a clinical finding. */
  notes: string | null;
  /** Withdrawn, with a reason, and still readable. There is no delete. */
  retractedAt: string | null;
  retractionReason: string | null;
}

export interface NewBpeExam {
  recorded: PerioAttribution;
  probe: PerioProbe;
  probeNote: string | null;
  scores: Record<SextantId, BpeScore | null>;
  statuses: Record<SextantId, SextantStatus>;
  notes: string | null;
  supersedesId: string | null;
  amendmentReason: string | null;
}

export interface StoredBpeExam extends BpeExamRecord, StoredEnvelope {}

export interface NewPerioChart {
  recorded: PerioAttribution;
  probe: PerioProbe;
  probeNote: string | null;
  /** What this chart says it covers. All six is a full-mouth chart. */
  sextants: SextantId[];
  teeth: PerioToothRecord[];
  trigger: PerioChartTrigger | null;
  /** The exam that demanded this chart, where there was one. */
  bpeExamId: string | null;
  diagnosis: RecordedDiagnosis | null;
  notes: string | null;
  supersedesId: string | null;
  amendmentReason: string | null;
}

export interface StoredPerioChartHeader extends Omit<SixPointChart, "teeth">, StoredEnvelope {
  probeNote: string | null;
  trigger: PerioChartTrigger | null;
  bpeExamId: string | null;
  diagnosis: RecordedDiagnosis | null;
}

export interface StoredPerioChart extends StoredPerioChartHeader {
  teeth: PerioToothRecord[];
}

// ---------------------------------------------------------------------------
// Errors. Typed, because the route has to say three different things and a bare
// throw would flatten all of them into "could not save".
// ---------------------------------------------------------------------------

/** The feature is off. Defence in depth: the route checks the gate first. */
export class PerioDisabledError extends Error {
  constructor() {
    super(PERIO_COPY.disabled);
    this.name = "PerioDisabledError";
  }
}

/** A write the data refuses -- an amendment pointing at a record that is not
 *  this patient's, in this site, or that has already been retracted. */
export class PerioRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerioRefusedError";
  }
}

function assertEnabled(): void {
  if (!isPerioEnabled()) throw new PerioDisabledError();
}

// ---------------------------------------------------------------------------
// Row shapes and mapping
// ---------------------------------------------------------------------------

/** lowercase column prefix per sextant, e.g. UR -> ur_code / ur_furcation / ur_status. */
const SEXTANT_COLUMN: Record<SextantId, string> = {
  UR: "ur",
  UA: "ua",
  UL: "ul",
  LR: "lr",
  LA: "la",
  LL: "ll",
};

const ENVELOPE_COLS = [
  "id",
  "site_id",
  "dentally_patient_id",
  "version",
  "recorded_at",
  "created_at",
  "author_user_id",
  "author_name",
  "author_gdc_number",
  "probe",
  "probe_note",
  "notes",
  "supersedes_id",
  "amendment_reason",
  "retracted_at",
  "retraction_reason",
];

const BPE_COLS = [
  ...ENVELOPE_COLS,
  ...SEXTANTS.flatMap((s) => [
    `${SEXTANT_COLUMN[s]}_code`,
    `${SEXTANT_COLUMN[s]}_furcation`,
    `${SEXTANT_COLUMN[s]}_status`,
  ]),
].join(", ");

const CHART_COLS = [
  ...ENVELOPE_COLS,
  "sextants",
  "trigger",
  "bpe_exam_id",
  "diagnosis_stage",
  "diagnosis_grade",
  "diagnosis_extent",
].join(", ");

type Row = Record<string, unknown>;

/**
 * supabase-js infers its row type from the literal passed to .select(). These
 * projections are BUILT (SEXTANTS.flatMap) rather than written inline, because
 * eighteen sextant columns spelled out by hand is eighteen chances to mistype
 * one, so the inference has nothing to work from and yields GenericStringError.
 * Both helpers go through `unknown`, which is honest: the database's shape is
 * checked by the migration and by the mappers below, not by a cast.
 */
function asRows(data: unknown): Row[] {
  return Array.isArray(data) ? (data as Row[]) : [];
}
function asRow(data: unknown): Row {
  return data as Row;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}
function nullableStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function nullableNum(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

const PROBES: readonly PerioProbe[] = ["who-621", "who-cpi", "other"];
const STATUSES: readonly SextantStatus[] = ["scorable", "insufficient-teeth", "no-teeth"];

function toAttribution(r: Row): PerioAttribution {
  return {
    clinician: {
      id: str(r.author_user_id),
      name: str(r.author_name),
      gdcNumber: nullableStr(r.author_gdc_number),
    },
    at: str(r.recorded_at),
  };
}

function toEnvelope(r: Row): StoredEnvelope {
  return {
    version: Number(r.version),
    createdAt: str(r.created_at),
    notes: nullableStr(r.notes),
    retractedAt: nullableStr(r.retracted_at),
    retractionReason: nullableStr(r.retraction_reason),
  };
}

function toProbe(v: unknown): PerioProbe {
  const probe = str(v) as PerioProbe;
  return PROBES.includes(probe) ? probe : "other";
}

function toBpeExam(r: Row): StoredBpeExam {
  const scores = {} as Record<SextantId, BpeScore | null>;
  const statuses = {} as Record<SextantId, SextantStatus>;
  for (const sextant of SEXTANTS) {
    const p = SEXTANT_COLUMN[sextant];
    const code = nullableNum(r[`${p}_code`]);
    // A code outside 0-4 cannot exist -- the check constraint refuses it -- but
    // reading it back as null rather than trusting the number keeps a row written
    // by some future path from putting a code 7 on a clinical screen.
    scores[sextant] =
      code !== null && code >= 0 && code <= 4
        ? { code: code as BpeScore["code"], furcation: r[`${p}_furcation`] === true }
        : null;
    const status = str(r[`${p}_status`]) as SextantStatus;
    statuses[sextant] = STATUSES.includes(status) ? status : "scorable";
  }
  return {
    id: str(r.id),
    siteId: str(r.site_id),
    patientId: str(r.dentally_patient_id),
    recorded: toAttribution(r),
    supersedesId: nullableStr(r.supersedes_id),
    amendmentReason: nullableStr(r.amendment_reason),
    probe: toProbe(r.probe),
    probeNote: nullableStr(r.probe_note),
    scores,
    statuses,
    ...toEnvelope(r),
  };
}

function toChartHeader(r: Row): StoredPerioChartHeader {
  const raw = Array.isArray(r.sextants) ? (r.sextants as unknown[]) : [];
  const sextants = raw
    .map((v) => str(v) as SextantId)
    .filter((v): v is SextantId => SEXTANTS.includes(v));
  const stage = nullableStr(r.diagnosis_stage) as PerioStage | null;
  const grade = nullableStr(r.diagnosis_grade) as PerioGrade | null;
  const extent = nullableStr(r.diagnosis_extent) as PerioExtent | null;
  return {
    id: str(r.id),
    siteId: str(r.site_id),
    patientId: str(r.dentally_patient_id),
    recorded: toAttribution(r),
    supersedesId: nullableStr(r.supersedes_id),
    amendmentReason: nullableStr(r.amendment_reason),
    probe: toProbe(r.probe),
    probeNote: nullableStr(r.probe_note),
    sextants,
    trigger: (nullableStr(r.trigger) as PerioChartTrigger | null) ?? null,
    bpeExamId: nullableStr(r.bpe_exam_id),
    // A chart with no committed diagnosis carries null rather than an object of
    // nulls, so "the clinician has not staged this" is one check, not three.
    diagnosis: stage || grade || extent ? { stage, grade, extent } : null,
    ...toEnvelope(r),
  };
}

// ---------------------------------------------------------------------------
// Version assignment is the database's job (trigger perio_*_version), so nothing
// here sends a version. Two concurrent writes can still compute the same next
// version under read-committed; the unique index turns the loser into a 23505,
// and ONE retry is enough because the retry re-reads the max.
// ---------------------------------------------------------------------------

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
}

async function insertRecord(table: string, row: Row, cols: string): Promise<Row> {
  const db = serviceClient();
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await db.from(table).insert(row).select(cols).single();
    if (!error) return asRow(data);
    if (!isUniqueViolation(error) || attempt === 1) throw error;
  }
  throw new Error(`could not insert into ${table}`); // unreachable
}

/** The envelope columns shared by both record tables. */
function envelopeRow(
  scope: PerioScope,
  input: {
    recorded: PerioAttribution;
    probe: PerioProbe;
    probeNote: string | null;
    notes: string | null;
    supersedesId: string | null;
    amendmentReason: string | null;
  },
): Row {
  return {
    site_id: scope.siteId,
    dentally_patient_id: scope.patientId,
    recorded_at: input.recorded.at,
    author_user_id: input.recorded.clinician.id,
    author_name: input.recorded.clinician.name,
    author_gdc_number: input.recorded.clinician.gdcNumber,
    probe: input.probe,
    probe_note: input.probeNote,
    notes: input.notes,
    supersedes_id: input.supersedesId,
    amendment_reason: input.amendmentReason,
  };
}

/**
 * Confirm an amendment target is this patient's, in this site, and still
 * standing.
 *
 * Scoped in the predicate, not checked by the caller: an amendment that could
 * point across a site boundary would let one practice's record acquire another's
 * history, which is the same IDOR class getPatientDetail already shipped once.
 */
async function requireAmendable(
  table: string,
  scope: PerioScope,
  id: string,
  noun: string,
): Promise<void> {
  const db = serviceClient();
  const { data, error } = await db
    .from(table)
    .select("id, retracted_at, finalised_at")
    .eq("id", id)
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId)
    .maybeSingle();
  if (error) throw error;
  const row = (data ?? null) as Row | null;
  if (!row || !row.finalised_at) {
    throw new PerioRefusedError(`the ${noun} being amended does not exist for this patient`);
  }
  if (row.retracted_at) {
    throw new PerioRefusedError(`the ${noun} being amended has been retracted`);
  }
}

// ===========================================================================
// BPE
// ===========================================================================

/**
 * Record a BPE. An amendment is a NEW VERSION, never an edit.
 *
 * finalised_at is set in the same statement as the insert: a BPE is one row, so
 * the write is already atomic and there is no half-written state to guard.
 */
export async function saveBpeExam(scope: PerioScope, input: NewBpeExam): Promise<StoredBpeExam> {
  assertEnabled();
  if (input.supersedesId) {
    await requireAmendable("perio_bpe_exam", scope, input.supersedesId, "BPE");
  }

  const row: Row = { ...envelopeRow(scope, input), finalised_at: new Date().toISOString() };
  for (const sextant of SEXTANTS) {
    const p = SEXTANT_COLUMN[sextant];
    const score = input.scores[sextant] ?? null;
    row[`${p}_code`] = score ? score.code : null;
    row[`${p}_furcation`] = score ? score.furcation : false;
    row[`${p}_status`] = input.statuses[sextant] ?? "scorable";
  }

  return toBpeExam(await insertRecord("perio_bpe_exam", row, BPE_COLS));
}

/**
 * This patient's BPE history in this site, newest first.
 *
 * RETRACTED EXAMS ARE INCLUDED. A retraction is part of the record -- a reader
 * needs to see that a score was withdrawn and why, which is the entire
 * difference between retracting and deleting.
 */
export async function listBpeExams(scope: PerioScope, limit = 20): Promise<StoredBpeExam[]> {
  assertEnabled();
  const db = serviceClient();
  const { data, error } = await db
    .from("perio_bpe_exam")
    .select(BPE_COLS)
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId)
    .not("finalised_at", "is", null)
    .order("recorded_at", { ascending: false })
    .order("version", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return asRows(data).map(toBpeExam);
}

/** The standing BPE: newest, finalised, not retracted. Serves perio_bpe_exam_latest_idx. */
export async function latestBpeExam(scope: PerioScope): Promise<StoredBpeExam | null> {
  assertEnabled();
  const db = serviceClient();
  const { data, error } = await db
    .from("perio_bpe_exam")
    .select(BPE_COLS)
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId)
    .not("finalised_at", "is", null)
    .is("retracted_at", null)
    .order("recorded_at", { ascending: false })
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw error;
  const rows = asRows(data);
  return rows.length ? toBpeExam(rows[0]) : null;
}

/**
 * Withdraw a BPE entered in error. The row stays; the reason and the name are
 * added. The database trigger permits exactly this update and nothing else.
 */
export async function retractBpeExam(
  scope: PerioScope,
  id: string,
  reason: string,
  by: ClinicianRef,
): Promise<StoredBpeExam | null> {
  assertEnabled();
  const db = serviceClient();
  const { data, error } = await db
    .from("perio_bpe_exam")
    .update({
      retracted_at: new Date().toISOString(),
      retracted_by: by.id,
      retraction_reason: reason,
    })
    .eq("id", id)
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId)
    .not("finalised_at", "is", null)
    .is("retracted_at", null)
    .select(BPE_COLS)
    .maybeSingle();
  if (error) throw error;
  return data ? toBpeExam(asRow(data)) : null;
}

// ===========================================================================
// The 6-point chart
// ===========================================================================

/**
 * Record a 6-point chart: header, then teeth, then up to 192 site rows, then
 * finalise.
 *
 * THE CLEANUP PATH IS THE INTERESTING PART. supabase-js cannot wrap these
 * inserts in one transaction, so a failure after the header lands would leave a
 * chart with no measurements -- which renders as "charted, every site blank",
 * the single most dangerous artefact this feature could produce. So the header
 * is written UNFINALISED, every read ignores unfinalised charts, and a failure
 * deletes the header (cascading to any children written so far). That delete is
 * the only one the append-only trigger allows, and it is allowed precisely
 * because an unfinalised chart was never a clinical record.
 */
export async function savePerioChart(
  scope: PerioScope,
  input: NewPerioChart,
): Promise<StoredPerioChart> {
  assertEnabled();
  if (input.supersedesId) {
    await requireAmendable("perio_chart", scope, input.supersedesId, "chart");
  }

  const db = serviceClient();
  const header = await insertRecord(
    "perio_chart",
    {
      ...envelopeRow(scope, input),
      sextants: input.sextants,
      trigger: input.trigger,
      bpe_exam_id: input.bpeExamId,
      diagnosis_stage: input.diagnosis?.stage ?? null,
      diagnosis_grade: input.diagnosis?.grade ?? null,
      diagnosis_extent: input.diagnosis?.extent ?? null,
      finalised_at: null,
    },
    CHART_COLS,
  );
  const chartId = str(header.id);

  try {
    if (input.teeth.length > 0) {
      const teethRows = input.teeth.map((t) => ({
        chart_id: chartId,
        tooth_fdi: t.tooth,
        mobility: t.mobility,
        furcation: t.furcation,
      }));
      const { error: teethError } = await db.from("perio_chart_tooth").insert(teethRows);
      if (teethError) throw teethError;

      const siteRows = input.teeth.flatMap((t) =>
        t.sites.map((s) => ({
          chart_id: chartId,
          tooth_fdi: t.tooth,
          site: s.site,
          probing_depth_mm: s.probingDepth,
          recession_mm: s.recession,
          bleeding: s.bleeding,
          suppuration: s.suppuration,
          plaque: s.plaque,
          // cal_mm is NOT sent: it is a generated column. The database computes
          // depth + recession, so no caller can store an attachment loss that
          // disagrees with the numbers it came from.
        })),
      );
      if (siteRows.length > 0) {
        const { error: siteError } = await db.from("perio_chart_site").insert(siteRows);
        if (siteError) throw siteError;
      }
    }

    const { error: finaliseError } = await db
      .from("perio_chart")
      .update({ finalised_at: new Date().toISOString() })
      .eq("id", chartId);
    if (finaliseError) throw finaliseError;
  } catch (error) {
    // Best effort, and deliberately swallowed: the caller must hear about the
    // ORIGINAL failure, not about a cleanup that also went wrong. Anything left
    // behind is unfinalised and therefore invisible to every read.
    await db.from("perio_chart").delete().eq("id", chartId);
    throw error;
  }

  const saved = await getPerioChart(scope, chartId);
  if (!saved) throw new Error("the chart was written but could not be read back");
  return saved;
}

/**
 * One chart's measurements, in the shape pocket-chart.ts consumes.
 *
 * THE STORED cal_mm IS NOT READ BACK. It exists so "which patients have
 * interdental attachment loss of 5mm or more" can be asked of the database
 * rather than by loading 51k charts into Node, but the one place a CAL may reach
 * a clinician is buildPocketChart(), which derives it from the depth and
 * recession returned here. One value, one producer.
 */
async function loadMeasurements(chartId: string): Promise<PerioToothRecord[]> {
  const db = serviceClient();
  const [teeth, sites] = await Promise.all([
    db
      .from("perio_chart_tooth")
      .select("tooth_fdi, mobility, furcation")
      .eq("chart_id", chartId)
      .order("tooth_fdi", { ascending: true }),
    db
      .from("perio_chart_site")
      .select("tooth_fdi, site, probing_depth_mm, recession_mm, bleeding, suppuration, plaque")
      .eq("chart_id", chartId)
      .order("tooth_fdi", { ascending: true }),
  ]);
  if (teeth.error) throw teeth.error;
  if (sites.error) throw sites.error;

  const byTooth = new Map<number, PerioSiteMeasurement[]>();
  for (const raw of asRows(sites.data)) {
    const tooth = Number(raw.tooth_fdi);
    const list = byTooth.get(tooth) ?? [];
    list.push({
      site: str(raw.site) as PerioSiteId,
      probingDepth: nullableNum(raw.probing_depth_mm),
      recession: nullableNum(raw.recession_mm),
      bleeding: raw.bleeding === true,
      suppuration: raw.suppuration === true,
      plaque: raw.plaque === true,
    });
    byTooth.set(tooth, list);
  }

  return asRows(teeth.data).map((raw) => {
    const tooth = Number(raw.tooth_fdi);
    const list = byTooth.get(tooth) ?? [];
    // Ordered by the clinical walk (mb, b, db, ml, l, dl) rather than by whatever
    // the database returned, so a comparison lines two charts up site for site.
    list.sort((a, b) => SITE_IDS.indexOf(a.site) - SITE_IDS.indexOf(b.site));
    return {
      tooth,
      sites: list,
      // FURCATION GRADES 1–4, MOBILITY STAGES 1–3 — Dentally's scales, which
      // replaced Hamp I–III and Miller 0–III.
      //
      // THE CAST IS NOT A CHECK, AND IT IS NOT MEANT TO BE. A smallint out of
      // range would satisfy TypeScript here and mean nothing clinically, so the
      // number is carried through UNCHANGED rather than coerced, clamped or
      // nulled: validatePocketChart refuses it by name when buildPocketChart
      // runs, and tab-perio.tsx turns that refusal into a sentence naming the
      // chart that could not be read and stating it has not been deleted.
      //
      // Silently mapping an out-of-range value to null here would be the worse
      // failure of the two — a stored finding would vanish off the screen and
      // the chart around it would still render as complete. There are no legacy
      // rows to migrate: this schema (migration 0066) has never been applied,
      // and the check constraints on perio_chart_tooth carry the same 1–4 and
      // 1–3 ranges, so the database refuses the value before it is ever stored.
      mobility: nullableNum(raw.mobility) as MobilityStage | null,
      furcation: nullableNum(raw.furcation) as FurcationGrade | null,
    };
  });
}

/**
 * One chart in full, by id -- scoped to this patient in this site in the query
 * itself, so a chart id from another practice resolves to nothing rather than to
 * someone else's periodontal record.
 *
 * A retracted chart IS returned when asked for by id: you asked for that one,
 * and its retraction is part of what you need to see.
 */
export async function getPerioChart(scope: PerioScope, id: string): Promise<StoredPerioChart | null> {
  assertEnabled();
  const db = serviceClient();
  const { data, error } = await db
    .from("perio_chart")
    .select(CHART_COLS)
    .eq("id", id)
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId)
    .not("finalised_at", "is", null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const header = toChartHeader(asRow(data));
  return { ...header, teeth: await loadMeasurements(header.id) };
}

/** This patient's chart history in this site, newest first, headers only.
 *  Retracted charts included, for the same reason retracted BPEs are. */
export async function listPerioChartHeaders(
  scope: PerioScope,
  limit = 20,
): Promise<StoredPerioChartHeader[]> {
  assertEnabled();
  const db = serviceClient();
  const { data, error } = await db
    .from("perio_chart")
    .select(CHART_COLS)
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId)
    .not("finalised_at", "is", null)
    .order("recorded_at", { ascending: false })
    .order("version", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return asRows(data).map(toChartHeader);
}

/**
 * The comparison view's two charts: this visit and the one before it, in full.
 *
 * A single perio chart is nearly useless -- the clinical value is the change, so
 * this is the read the screen actually makes and the one perio_chart_latest_idx
 * is shaped for. Feed the pair to diffPocketCharts(). Retracted charts are
 * excluded here (unlike the history list): a withdrawn chart must never become
 * the baseline that "improving" or "deteriorating" is measured against.
 */
export async function latestPerioCharts(scope: PerioScope, count = 2): Promise<StoredPerioChart[]> {
  assertEnabled();
  const db = serviceClient();
  const { data, error } = await db
    .from("perio_chart")
    .select(CHART_COLS)
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId)
    .not("finalised_at", "is", null)
    .is("retracted_at", null)
    .order("recorded_at", { ascending: false })
    .order("version", { ascending: false })
    .limit(count);
  if (error) throw error;
  const headers = asRows(data).map(toChartHeader);
  const teeth = await Promise.all(headers.map((h) => loadMeasurements(h.id)));
  return headers.map((h, i) => ({ ...h, teeth: teeth[i] }));
}

/** Withdraw a chart entered in error. Same posture as retractBpeExam. */
export async function retractPerioChart(
  scope: PerioScope,
  id: string,
  reason: string,
  by: ClinicianRef,
): Promise<StoredPerioChartHeader | null> {
  assertEnabled();
  const db = serviceClient();
  const { data, error } = await db
    .from("perio_chart")
    .update({
      retracted_at: new Date().toISOString(),
      retracted_by: by.id,
      retraction_reason: reason,
    })
    .eq("id", id)
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId)
    .not("finalised_at", "is", null)
    .is("retracted_at", null)
    .select(CHART_COLS)
    .maybeSingle();
  if (error) throw error;
  return data ? toChartHeader(asRow(data)) : null;
}
