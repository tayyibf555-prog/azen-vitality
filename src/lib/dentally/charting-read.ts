// ===========================================================================
// THE CHART READ. Four Dentally streams, shaped into one ChartRead.
//
// SECOND READ IN THIS FILE: getPlanPanelRead, at the bottom, feeds the treatment
// plan panel that sits beneath the arch. It is a separate read with its own four
// streams and its own health flags; the block above it explains why the two are
// not folded together. Both are read-only and neither may gain a write.
//
// This is the data layer behind the FDI charting screen, which is a READ-ONLY
// MIRROR of Dentally. Nothing here writes, and no write path exists to call:
// DentallyClient carries no create/update/delete method for any charting
// resource, and none may be added (POST 404s on all five upstream).
//
// WHY THIS IS NOT FOLDED ONTO getPatientDetail. That function feeds the record
// header, all eleven tabs and the diary quick-view. A fifth stream there would
// make every one of them page treatment_plan_items on every open, and would force
// a fifth key onto the shared ReadHealth that ten existing panels destructure.
// src/lib/dentally/read.ts is deliberately not edited by this feature.
//
// EVERY STREAM CARRIES ITS OWN HEALTH FLAG, and that is the whole point of the
// shape. read.ts's own comment says it plainly: a failed notes read rendered as
// "No clinical notes in Dentally" is read by a clinician as a fact about the
// PATIENT rather than a fact about the network. On a chart that failure is louder
// still, because an items read that catches to [] renders as thirty-two clean,
// unmarked teeth: a positive claim that this patient has no findings. So each of
// the four walks flips only its own key, and the screen states which one failed.
//
// NOT CALIBRATED AGAINST LIVE. No probe has run against a charted patient. The
// field names come from developer.dentally.co (verified 2026-08-01); the wire
// shapes of `teeth` and `surfaces` are unverified, which is why they go through
// the tolerant parsers and why anything unplaceable is COUNTED rather than
// dropped. Re-probe before this is used clinically.
// ===========================================================================

import { DentallyClient } from "./client";
import { dentallyFromEnv } from "./read";
import { pageToCeiling } from "./paging";
import { dentallySiteId } from "@/lib/mock/clients";
import { readPlanId } from "@/lib/calendar/funding";
import { parseTeeth } from "@/lib/charting/fdi";
import { parseSurfaces, splitIndicesByScheme } from "@/lib/charting/surfaces";
// THE PANEL'S GROUPING AND TOTALS ARE NOT REIMPLEMENTED HERE. buildPlanPanel owns
// the unassigned bucket, the per-card sums, the funding rollup and the
// reconciliation count, and it is exhaustively tested against a deliberately
// broken implementation (see its MUTATION LOG). A second summing loop in this file
// is precisely how two halves of one screen come to disagree about what a patient
// is being charged.
import { buildPlanPanel } from "@/lib/charting/plan-panel";
import type { PlanAppointment, PlanHeader, PlanPanelItem } from "@/lib/charting/plan-panel";
import type {
  ChartItem,
  ChartRead,
  ChartReadHealth,
  PlanRow,
  TreatmentCategoryRow,
  TreatmentRow,
} from "@/lib/charting/types";

// --- Local copies of read.ts's coercers ------------------------------------
// read.ts keeps these module-private and this feature does not edit that file, so
// they are mirrored here byte for byte rather than reimplemented differently. Any
// divergence between the two is a bug in this file.

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
/**
 * A Dentally record id as a string, or null when it is absent.
 *
 * Ids arrive as NUMBERS from real Dentally and as strings from the mock. Using
 * str() alone returns null for a number, and that exact bug once sent every live
 * appointment into the diary's Unassigned column. Every id below goes through this.
 */
function idOf(v: unknown): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  return str(v);
}
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v) || 0;
}
function bool(v: unknown): boolean {
  return v === true || v === 1 || v === "true";
}

/** A raw field printed back to the reader verbatim. An array is joined rather than
 *  JSON-stringified, because the point of showing it is that a human can read what
 *  Dentally actually holds for a row we could not place. */
function rawText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => String(x)).join(",");
  return String(v);
}

// --- Paging ----------------------------------------------------------------
// Same rule as read.ts: Dentally caps a page at ~100 rows, so a single unpaged
// call silently truncates. The difference here is that hitting the CEILING is
// reported rather than swallowed: a chart cut off at the bound is a partial
// clinical record, and the screen says so.

const PER_PAGE = 100;
/** Items: 25 pages, up to 2,500 rows for one patient. Generous for a real chart,
 *  and low enough that a source which IGNORES patient_id (Dentally already ignores
 *  site_id elsewhere) hits the ceiling and raises `truncated` instead of quietly
 *  paging the whole practice. */
const ITEMS_MAX_PAGES = 25;
/** The catalogue, its categories and this patient's plans are all small. */
const SMALL_MAX_PAGES = 5;

// THE PAGER ITSELF LIVES IN ./paging, and it is now the ONLY copy in the repo.
//
// This file used to declare its own `pageToCeiling` and src/lib/dentally/read.ts
// declared `pageBounded` beside it: the same loop, line for line, differing only in
// whether the truncation was returned or discarded. Both also measured a short page
// against their OWN module's PER_PAGE while every caller chose `per_page` inside its
// closure — nothing tied the size asked for to the size measured against, which is
// exactly the drift `pageAll` was fixed for two directories away. The shared one
// takes `perPage` as an argument and hands it to the fetcher, so the two cannot
// disagree. Behaviour here is unchanged: every caller below still pages at PER_PAGE.

// --- Mapping ---------------------------------------------------------------

/** A mapped row plus the one fact about it that ChartItem does not carry: whether
 *  the teeth field held something we could not read. "This treatment names no
 *  tooth" (an examination, a radiograph, a denture) and "this treatment names a
 *  tooth we could not place" are different facts and only the second belongs in
 *  ChartRead.unplaced. */
interface MappedItem {
  item: ChartItem;
  teethUnparsed: boolean;
}

function toChartItem(r: Record<string, unknown>): MappedItem {
  const { teeth, unparsed } = parseTeeth(r.teeth);
  const { surfaces, indices, unrecognised } = parseSurfaces(r.surfaces);
  // WHICH INDICES THIS ROW'S TEETH CAN ACTUALLY HOLD. Split HERE because this is
  // the first point where both halves are known: parseSurfaces sees the numbers
  // and not the teeth, and 1-5 versus 1-8 is decided by the tooth alone.
  //
  // An index with no region on any of the named teeth — a 7 on an incisor — is
  // NOT dropped and NOT nudged onto the nearest region. It joins the unreadable
  // letters, so the tooltip, History, the CSV export and the status-bar count all
  // still say that Dentally holds a surface here that we could not place.
  const { placeable, outOfScheme } = splitIndicesByScheme(teeth, indices);
  const item: ChartItem = {
    id: String(r.id ?? ""),
    teeth,
    rawTeeth: rawText(r.teeth),
    surfaces,
    surfaceIndices: placeable,
    rawSurfaces: rawText(r.surfaces),
    unrecognisedSurfaces: [...unrecognised, ...outOfScheme.map(String)],
    // COMPUTED HERE, ONCE, so nothing downstream has to infer it. An extraction,
    // crown, bridge, endo or implant carries no surfaces at all; a renderer that
    // only draws surfaces draws those as a clean tooth, which is the most direct
    // route this screen has to a wrong-site event.
    //
    // A SURFACE WE CAN PLACE AND A SURFACE WE CANNOT ARE BOTH SURFACES, and
    // conflating either with an ABSENT one was a real defect: live Dentally sends
    // integers, so a single-surface filling had no named surface and drew the
    // whole-crown ring that means extraction.
    //
    // ALL THREE COUNTS BELONG IN THIS TEST. `indices` is the one that arrived
    // with the integer mapping, and leaving it out would have re-created exactly
    // the same bug from the other side: every real live filling would parse
    // cleanly into `surfaces: []` + `indices: [5]`, and then be declared
    // whole-tooth. A planned filling that renders as a planned extraction is a
    // wrong-treatment claim on the face of the chart.
    wholeTooth:
      teeth.length > 0 &&
      surfaces.length === 0 &&
      indices.length === 0 &&
      unrecognised.length === 0,
    region: str(r.region),
    baseChart: bool(r.base_chart),
    completed: bool(r.completed),
    completedAt: str(r.completed_at),
    charged: bool(r.charged),
    notes: str(r.notes),
    // The STAFF code, never patient_nomenclature: this is a clinician's screen and
    // patient-facing wording on it would be a different claim about the treatment.
    nomenclature: str(r.nomenclature),
    price: num(r.price),
    value: num(r.value),
    durationMin: num(r.duration),
    nhsTreatmentCat: str(r.nhs_treatment_cat),
    udaBand: str(r.uda_band),
    position: num(r.position),
    planId: idOf(r.treatment_plan_id),
    treatmentId: idOf(r.treatment_id),
    practitionerId: idOf(r.practitioner_id),
    // Through the SHARED funding reader, which handles the flat payment_plan_id and
    // the nested payment_plan.id. A second hand-written list is how two screens
    // drift about which id is NHS.
    paymentPlanId: readPlanId(r),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
  return { item, teethUnparsed: unparsed };
}

function toTreatmentRow(r: Record<string, unknown>): TreatmentRow {
  return {
    id: idOf(r.id) ?? "",
    // Field name unverified against live; read defensively rather than assuming
    // one. An empty code renders as an empty column, not as a wrong one.
    code: str(r.code) ?? str(r.reference) ?? str(r.abbreviation) ?? "",
    name: str(r.name) ?? str(r.nomenclature) ?? "Treatment",
    categoryId: idOf(r.treatment_category_id ?? r.category_id),
    price: num(r.price ?? r.value),
  };
}

function toCategoryRow(r: Record<string, unknown>): TreatmentCategoryRow {
  return { id: idOf(r.id) ?? "", name: str(r.name) ?? "Uncategorised" };
}

/**
 * One treatment plan, for the chart's plan tabs.
 *
 * ACCEPTANCE IS DECIDED ON start_date/accepted_at ALONE, and this is a DELIBERATE
 * departure from read.ts's PlanRecord, which falls back to created_at. That
 * fallback is right where acceptedAt is only a date to print; it is wrong here,
 * because on this screen acceptance is a clinical STATUS: every plan has a
 * created_at, so carrying the fallback would make every plan read "accepted" and
 * the unaccepted state — the one that exists so an item on a declined plan cannot
 * render as live planned treatment — would never appear at all.
 */
function toPlanRow(r: Record<string, unknown>): PlanRow {
  const acceptedAt = str(r.start_date) ?? str(r.accepted_at);
  const completedAt = str(r.completed_at);
  return {
    id: idOf(r.id) ?? "",
    label: str(r.nickname) ?? str(r.name) ?? "Treatment plan",
    status: completedAt ? "completed" : acceptedAt ? "accepted" : "unaccepted",
    acceptedAt,
  };
}

// --- Cache -----------------------------------------------------------------
// 30s, matching the record's own TTL so the header and the chart cannot disagree.
//
// NOT read.ts's cachedRead, and not because of style. cachedRead memoises whatever
// resolves, so a single blip would pin "we could not read this patient's chart"
// onto that patient for the full thirty seconds, for every user on the instance,
// long after Dentally had recovered. This uses the conditional-set idiom the
// availability read already uses: a result with ANY failed health key is returned
// to this caller and NOT written to the cache.
//
// It also stays live under VITEST (cachedRead short-circuits there), because
// "a failed read is not cached" is a behaviour that has to be testable. Tests call
// clearChartReadCache() between cases.

const CHART_CACHE_TTL_MS = 30_000;
const chartCache = new Map<string, { at: number; value: ChartRead }>();

/** Drop every cached chart. For tests, and for nothing else. */
export function clearChartReadCache(): void {
  chartCache.clear();
}

function healthy(h: ChartReadHealth): boolean {
  return h.items === "ok" && h.treatments === "ok" && h.categories === "ok" && h.plans === "ok";
}

/**
 * One patient's chart, cached for 30 seconds (successes only).
 *
 * `siteId` is our INTERNAL site id, as everywhere else in this file's neighbours;
 * it is mapped through dentallySiteId() for the one call that sends it.
 */
export async function getPatientChart(patientId: string, siteId: string): Promise<ChartRead> {
  const key = `chart:${siteId}:${patientId}`;
  const hit = chartCache.get(key);
  if (hit && Date.now() - hit.at < CHART_CACHE_TTL_MS) return hit.value;

  const value = await getPatientChartUncached(patientId, siteId);
  if (healthy(value.health)) {
    chartCache.set(key, { at: Date.now(), value });
    if (chartCache.size > 100) {
      for (const [k] of [...chartCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 25)) {
        chartCache.delete(k);
      }
    }
  }
  return value;
}

/** The chart read with no cache of its own. Prefer getPatientChart. */
export async function getPatientChartUncached(patientId: string, siteId: string): Promise<ChartRead> {
  const client: DentallyClient = dentallyFromEnv();

  // Four streams, four flags. Flipped inside each catch and read after the join.
  const health: ChartReadHealth = { items: "ok", treatments: "ok", categories: "ok", plans: "ok" };
  // TWO FLAGS, NOT ONE, because they mean different things to a clinician and
  // CHART_COPY.truncated only ever described the first. One shared flag made a
  // practice whose stock treatment list runs past 500 rows print "this may not
  // be the whole of this patient's chart" on every patient forever, while the
  // items walk had in fact completed. A caveat that is always on is a caveat
  // nobody reads.
  let truncated = false; // the PATIENT'S chart
  let truncatedCatalogue = false; // the treatment list, its categories, the plans

  const itemsP = pageToCeiling(
    (page, perPage) =>
      client
        .listTreatmentPlanItems({ patientId, page, perPage })
        .then((res) => (Array.isArray(res.treatment_plan_items) ? res.treatment_plan_items : [])),
    PER_PAGE,
    ITEMS_MAX_PAGES,
  )
    .then((out) => {
      if (out.truncated) truncated = true;
      return out.rows.map((row) => (row && typeof row === "object" ? row : {}) as Record<string, unknown>);
    })
    .catch((err) => {
      console.error(`[dentally] treatment_plan_items failed for patient ${patientId}`, err);
      health.items = "failed";
      return [] as Record<string, unknown>[];
    });

  const treatmentsP = pageToCeiling(
    (page, perPage) =>
      client
        .listTreatments({ page, perPage })
        .then((res) => (Array.isArray(res.treatments) ? res.treatments : [])),
    PER_PAGE,
    SMALL_MAX_PAGES,
  )
    .then((out) => {
      if (out.truncated) truncatedCatalogue = true;
      return out.rows.map((t) => toTreatmentRow((t ?? {}) as Record<string, unknown>));
    })
    .catch((err) => {
      console.error("[dentally] treatments failed", err);
      health.treatments = "failed";
      return [] as TreatmentRow[];
    });

  const categoriesP = pageToCeiling(
    (page, perPage) =>
      client
        .listTreatmentCategories({ page, perPage })
        .then((res) => (Array.isArray(res.treatment_categories) ? res.treatment_categories : [])),
    PER_PAGE,
    SMALL_MAX_PAGES,
  )
    .then((out) => {
      if (out.truncated) truncatedCatalogue = true;
      return out.rows.map((c) => toCategoryRow((c ?? {}) as Record<string, unknown>));
    })
    .catch((err) => {
      console.error("[dentally] treatment_categories failed", err);
      health.categories = "failed";
      return [] as TreatmentCategoryRow[];
    });

  // THE FOURTH STREAM, and it has its own flag for a reason. treatment_plan_items
  // carries only a plan id; PlanRow needs the id, the label, the acceptance date and
  // the status, and read.ts's PlanRecord carries no id at all. Without a flag of its
  // own, a failed plans read would render as "this patient has no treatment plans",
  // which is a different clinical statement from "we could not read them".
  const plansP = pageToCeiling(
    (page, perPage) =>
      client
        .listTreatmentPlansById({ siteId: dentallySiteId(siteId), patientId, page, perPage })
        .then((res) => (Array.isArray(res.treatment_plans) ? res.treatment_plans : [])),
    PER_PAGE,
    SMALL_MAX_PAGES,
  )
    .then((out) => {
      if (out.truncated) truncatedCatalogue = true;
      return (
        out.rows
          .map((p) => (p ?? {}) as Record<string, unknown>)
          // The same client-side safety net the patient-detail plans read keeps, in
          // case Dentally ignores patient_id the way it ignores site_id elsewhere.
          // A row carrying NO patient_id is kept, for the reason spelled out at the
          // items filter below: a discarded row is indistinguishable on screen from
          // a patient who has no plans, and those are different facts.
          .filter((r) => {
            const owner = idOf(r.patient_id);
            return owner === null || owner === patientId;
          })
          .map(toPlanRow)
      );
    })
    .catch((err) => {
      console.error(`[dentally] treatment_plans failed for patient ${patientId}`, err);
      health.plans = "failed";
      return [] as PlanRow[];
    });

  const [rawItems, treatments, categories, plans] = await Promise.all([
    itemsP,
    treatmentsP,
    categoriesP,
    plansP,
  ]);

  // CAPTURED AT FETCH TIME, not at render time, so the as-of line on screen is
  // honest to within the read rather than to within the paint.
  const fetchedAt = new Date().toISOString();

  // The same client-side patient filter, for the same reason: whether this endpoint
  // honours patient_id is unverified, and a chart showing another patient's items
  // is the worst outcome available here.
  //
  // A ROW THAT CARRIES NO patient_id IS KEPT, and that is the correction. The old
  // predicate discarded every row whose patient_id was absent, so if this endpoint
  // turns out to hang its rows off treatment_plan_id alone, EVERY row would have
  // been dropped, health.items would have stayed "ok", and the status bar would
  // have printed "No treatment items on this patient's chart in Dentally" for a
  // patient with a full chart. That is a category A claim about a person
  // manufactured by a field-name mismatch. The net still catches the case it was
  // built for: a row that names a DIFFERENT patient is still discarded.
  const mapped = rawItems
    .filter((r) => {
      const owner = idOf(r.patient_id);
      return owner === null || owner === patientId;
    })
    .map(toChartItem);

  // A row whose teeth WILL NOT PARSE is not dropped. It keeps its raw value and is
  // counted on screen: a finding the parser could not place is still a finding, and
  // silently discarding it is indistinguishable from the practice never recording it.
  //
  // A row that names NO tooth at all is a different thing and stays in `items`: an
  // examination, a radiograph, a hygiene appointment and a denture are ordinary
  // treatment and on a real chart they are most of the rows. Filing them under
  // "items we could not place on a tooth" printed a large unplaced count on every
  // patient and taught the reader to ignore the one signal that matters.
  const items: ChartItem[] = [];
  const unplaced: ChartItem[] = [];
  for (const { item, teethUnparsed } of mapped) (teethUnparsed ? unplaced : items).push(item);

  return {
    items,
    unplaced,
    treatments,
    categories,
    plans,
    truncated,
    truncatedCatalogue,
    fetchedAt,
    health,
  };
}

// ===========================================================================
// THE TREATMENT PLAN PANEL READ. Four more Dentally streams, shaped into the
// working half of the charting screen.
//
// The chart above is the arch. This is what a clinician operates during an
// appointment: the plan header and its chip, the appointment cards with their
// notes and rows, the per-card duration and price totals, and the plan-level
// totals along the bottom. It is the SAME read-only mirror the chart is. No write
// call exists here and none may be added — DentallyClient carries no
// create/update/delete for any charting resource (see the comment block on its
// charting section), and every action control on this panel renders DISABLED with
// its reason stated on screen.
//
// WHY IT IS A SEPARATE READ FROM getPatientChart. The two screens want different
// things from overlapping endpoints: the chart needs the practice-wide treatment
// catalogue and its categories and does not care which appointment an item sits
// under; the panel needs the appointment cards and the plans' money fields and
// does not care about the catalogue. Folding them together would make every chart
// open page the treatment_appointments index, would make every panel open page a
// 500-row catalogue, and would force a seventh key onto a ChartReadHealth that the
// chart's status bar already destructures.
//
// THE ONE FACT THAT SHAPES THIS FILE, from a live probe of production data on
// 2026-08-02: ONLY 17 OF 100 PLAN ITEMS CARRY A treatment_appointment_id. 83% of a
// real patient's plan belongs to no appointment card at all. Everything below is
// arranged so that an item cannot be lost: nothing is filtered on having a card,
// nothing is filtered on having a plan we recognise, and the grouping that decides
// where a row lands is buildPlanPanel's, which counts what it received against
// what it rendered and reports whether the two balance.
// ===========================================================================

/** Plans: a patient's plan list is small, like the chart's. */
const PANEL_SMALL_MAX_PAGES = 5;
/** The patient's diary appointments, for the card headers. Ten pages is a
 *  fifteen-year attender; past that the headers are reported as possibly
 *  incomplete rather than silently missing. */
const DIARY_MAX_PAGES = 10;

/**
 * MONEY, AND WHY IT IS CONVERTED HERE AND NOWHERE ELSE.
 *
 * The panel's engine and the screen both speak integer PENCE, because a footer
 * that sums floating-point pounds drifts by a penny against the rows above it and
 * a clinician reading a total that does not equal its own column loses the whole
 * screen. Every probe of live Dentally recorded in this repo, however, shows
 * DECIMAL POUNDS on the wire and often as a STRING: /v1/payments returns
 * `amount: "27.9"`, /v1/nhs_claims returns `expected_uda: "1.56"`. So the decimal
 * to integer conversion happens exactly once, at this boundary, and rounds rather
 * than truncates (26.8 * 100 is 2680.0000000000005 in IEEE 754, and Math.trunc
 * would book it as £26.79).
 *
 * ABSENT IS NULL, NOT ZERO, and that distinction is the whole reason this returns
 * a nullable. A plan whose private_treatment_value Dentally did not send is a plan
 * we do not know the value of; printing it as "£0.00" is a positive claim that the
 * patient owes nothing for it. The item-level twin below returns 0 instead,
 * because an item's price genuinely defaults to zero on a banded NHS row and
 * ChartItem.price already reads it that way.
 *
 * The raw value stays on ChartItem.price untouched, so a later probe that proves
 * the unit wrong has one line to change and an audit trail beside it.
 */
function penceOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** The item-level twin: a missing price is a zero-price row, which is an ordinary
 *  thing on a plan (an image inside a band, a bridge abutment) and NOT an absence. */
function pence(v: unknown): number {
  return penceOrNull(v) ?? 0;
}

/**
 * One treatment_appointment: a CARD on the panel.
 *
 * It carries NO date, NO time and NO practitioner. Those come from the diary
 * appointment named by `appointment_id`, resolved separately below. This shape
 * deliberately mirrors PlanAppointment exactly rather than inventing a wider one,
 * so buildPlanPanel can be handed these rows unchanged.
 */
function toPlanAppointment(r: Record<string, unknown>): PlanAppointment {
  return {
    id: idOf(r.id) ?? "",
    // POSITION IS THE CARD NUMBER and it is zero-based: position 0 renders as
    // "Appt. 1". num() sends an absent position to 0, which is the first card —
    // wrong, but visibly wrong and in the right group, where inventing a number
    // from array order would be invisibly wrong on every card after a deletion.
    position: num(r.position),
    appointmentId: idOf(r.appointment_id),
    notes: str(r.notes),
    bookable: bool(r.bookable),
  };
}

/**
 * One treatment_plan, as the panel's header.
 *
 * SEPARATE FROM toPlanRow, which serves the chart's plan TABS and reduces a plan
 * to a label and a three-way status. The panel prints the plan's own money —
 * private_treatment_value, nhs_uda_value, nhs_completed_uda_value — and those
 * three are the plan-level totals along the bottom of the screen. They are NOT
 * summed from the items and must never be: buildPlanPanel's mutation M8 covers
 * exactly that mistake.
 */
function toPlanHeader(r: Record<string, unknown>): PlanHeader {
  return {
    id: idOf(r.id) ?? "",
    // `nickname` is the field the reference screen shows. `name` is the
    // dashboard's field on the same object; both are read before giving up, and
    // the fallback is a neutral noun rather than an empty chip.
    nickname: str(r.nickname) ?? str(r.name) ?? "Treatment plan",
    completed: bool(r.completed),
    completedAt: str(r.completed_at),
    startDate: str(r.start_date),
    endDate: str(r.end_date),
    // Through the SHARED funding reader, which handles both the flat
    // payment_plan_id and the nested payment_plan.id, exactly as toChartItem does.
    paymentPlanId: readPlanId(r),
    practitionerId: idOf(r.practitioner_id),
    privateTreatmentValuePence: penceOrNull(r.private_treatment_value),
    // UDA IS NOT MONEY, but it is decimal ("1.56") and it is summed and compared,
    // so it goes to integer hundredths for the same reason pence does. The name
    // says hundredths rather than pence so nobody later renders it with a £.
    nhsUdaHundredths: penceOrNull(r.nhs_uda_value),
    nhsCompletedUdaHundredths: penceOrNull(r.nhs_completed_uda_value),
  };
}

/**
 * The card header facts that live on the DIARY appointment, not on the
 * treatment_appointment.
 *
 * `unresolvedReason` is a SENTENCE, present exactly when the header could not be
 * built, and it is the whole point of this shape. A card rendered with a blank
 * date and a blank clinician is read by a clinician as "this appointment is not
 * booked yet" — a statement about the patient's care. When the truth is instead
 * "Dentally points this card at an appointment we could not find" or "the diary
 * read failed", the panel has to say so in words. Silence is the one answer that
 * is never available here.
 */
export interface PlanCardHeader {
  /** The treatment_appointment this header belongs to. */
  treatmentAppointmentId: string;
  /** The diary appointment it was resolved from, or null. */
  appointmentId: string | null;
  start: string | null;
  finish: string | null;
  durationMin: number | null;
  /** Dentally's own state string, verbatim ("booked", "Did not attend"). Not
   *  canonicalised: this panel prints it, it does not branch on it. */
  state: string | null;
  practitioner: string | null;
  practitionerId: string | null;
  /** null when the header resolved. Otherwise the sentence the card must render. */
  unresolvedReason: string | null;
}

const CARD_UNRESOLVED = {
  notBooked:
    "Not booked into the diary yet, so this card has no date, time or clinician.",
  diaryFailed:
    "This patient's diary could not be read, so this card's date, time and clinician are unavailable. This is a connection problem, not a fact about the appointment.",
  noStart:
    "The linked diary appointment carries no start time, so this card's date and time cannot be shown.",
} as const;

/** The dangling-reference sentence, which names the id so it can be looked up in
 *  Dentally by hand. A cancelled or merged appointment leaves exactly this. */
function danglingReason(appointmentId: string): string {
  return `Dentally links this card to appointment ${appointmentId}, which was not in this patient's appointment list. Its date, time and clinician cannot be shown.`;
}

function resolveCardHeader(
  appt: PlanAppointment,
  diary: Map<string, Record<string, unknown>>,
  diaryFailed: boolean,
): PlanCardHeader {
  const base = {
    treatmentAppointmentId: appt.id,
    appointmentId: appt.appointmentId,
    start: null,
    finish: null,
    durationMin: null,
    state: null,
    practitioner: null,
    practitionerId: null,
  };
  // ORDER MATTERS. A card with no appointment_id is not booked, and that is TRUE
  // whether or not the diary read succeeded — reporting the outage first would
  // tell a clinician to retry for a date that does not exist.
  if (appt.appointmentId === null) {
    return { ...base, unresolvedReason: CARD_UNRESOLVED.notBooked };
  }
  if (diaryFailed) return { ...base, unresolvedReason: CARD_UNRESOLVED.diaryFailed };
  const row = diary.get(appt.appointmentId);
  if (!row) return { ...base, unresolvedReason: danglingReason(appt.appointmentId) };
  const start = str(row.start_time);
  if (start === null) return { ...base, unresolvedReason: CARD_UNRESOLVED.noStart };
  return {
    ...base,
    start,
    finish: str(row.finish_time),
    // num() would turn an absent duration into 0 minutes, which prints as a real
    // "0 min" on the header. Absent stays null and the header simply omits it.
    durationMin: typeof row.duration === "number" || typeof row.duration === "string"
      ? num(row.duration) || null
      : null,
    state: str(row.state),
    practitioner: str(row.practitioner),
    practitionerId: idOf(row.practitioner_id),
    unresolvedReason: null,
  };
}

/**
 * One practitioner's DISPLAY NAME, or null when the row carries none we can use.
 *
 * The live shape is {id, active, site_id, user:{first_name, last_name}}, which is
 * what read.ts's own practitioner read maps, so the same three field paths are
 * tried here in the same order.
 *
 * IT RETURNS NULL RATHER THAN A NOUN. read.ts falls back to the literal string
 * "Practitioner" because it is filling a PICKER, where a row with no readable name
 * is still a row you can choose. Here the name becomes INITIALS on a clinical
 * record, and "Practitioner" would render as "P" against a treatment: a plausible
 * pair of letters naming nobody, which is precisely what initialsOf() refuses to
 * do with a uuid. A row we cannot name resolves to nothing, and the screen then
 * says so in the one way that is honest.
 */
function practitionerNameOf(r: Record<string, unknown>): string | null {
  const user = (r.user && typeof r.user === "object" ? r.user : {}) as Record<string, unknown>;
  const joined = `${str(user.first_name) ?? ""} ${str(user.last_name) ?? ""}`.trim();
  if (joined.length > 0) return joined;
  return str(user.name) ?? str(r.name) ?? null;
}

/** One flag per stream, exactly as ChartReadHealth does and for the same reason:
 *  a failed read must never render as "this patient has no treatment plan". */
export interface PlanPanelHealth {
  items: "ok" | "failed";
  appointments: "ok" | "failed";
  plans: "ok" | "failed";
  /** The DIARY read, which supplies the card headers alone. It failing degrades
   *  every card header to a stated reason; it does not hide a single row. */
  diary: "ok" | "failed";
  /**
   * THE FIFTH STREAM, /v1/practitioners, and it has a flag of its own for the
   * reason every other one does.
   *
   * Every treatment_plan_item carries a practitioner_id and nothing else about the
   * clinician who worked it. Without this read the only names available are the
   * ones that happen to sit on a RESOLVED DIARY APPOINTMENT of the same plan, and
   * only 17 of 100 live items belong to an appointment at all — so a plan with no
   * resolved card renders a blank clinician on 100% of its rows while looking
   * complete. A blank cell on this screen means "Dentally sent nothing here", so
   * that blank is an active falsehood about a clinical record, not merely a gap
   * (GDC 4.1.4: record the name or initials of the treating clinician).
   *
   * It failing names nobody; it does not hide a row and does not blank a panel.
   */
  practitioners: "ok" | "failed";
}

/** One plan, with its cards, its rows and its totals already grouped. */
export interface PlanPanelEntry {
  plan: PlanHeader;
  /** buildPlanPanel's model: groups (cards then the unassigned bucket), totals,
   *  funding, unassignedItemCount and reconciliation. */
  model: ReturnType<typeof buildPlanPanel>;
  /** Card headers by treatment_appointment id. Every card in `model.groups` of
   *  kind "appointment" has an entry, resolved or with its reason stated. */
  cardHeaders: Record<string, PlanCardHeader>;
  /**
   * Practitioner id to DISPLAY NAME, from /v1/practitioners.
   *
   * THE SAME MAP ON EVERY PANEL, deliberately: a practice's clinicians are a
   * property of the site, not of one treatment plan, and a per-plan map would name
   * the same person on one panel and leave them blank on the next. Empty when the
   * practitioners read failed, and health.practitioners then says so.
   */
  practitioners: Record<string, string>;
  /**
   * True for the synthetic entry that holds items belonging to no plan we
   * received — a null treatment_plan_id, or one naming a plan the plans read did
   * not return. Without it those rows would be dropped by the per-plan split, and
   * a dropped row on this screen is a treatment the patient is not shown.
   */
  synthetic: boolean;
}

export interface PlanPanelRead {
  /** One entry per plan, plus the synthetic entry when it has rows. */
  panels: PlanPanelEntry[];
  /** Every item read for this patient, before grouping. */
  itemCount: number;
  /** Every item that ended up in a rendered group, across all panels. Equal to
   *  itemCount on a healthy read; when it is not, `balanced` is false and the
   *  screen must say the panel is incomplete rather than look complete. */
  renderedItemCount: number;
  balanced: boolean;
  /** THIS PATIENT'S items or cards hit their page ceiling. */
  truncated: boolean;
  /** The plan list or the diary hit theirs. Kept apart from `truncated` for the
   *  same reason truncatedCatalogue is: a caveat that is always on is a caveat
   *  nobody reads. */
  truncatedSupporting: boolean;
  /** Captured at FETCH time, not render time. */
  fetchedAt: string;
  health: PlanPanelHealth;
}

const PANEL_CACHE_TTL_MS = 30_000;
const panelCache = new Map<string, { at: number; value: PlanPanelRead }>();

/** Drop every cached panel. For tests, and for nothing else. */
export function clearPlanPanelReadCache(): void {
  panelCache.clear();
}

function panelHealthy(h: PlanPanelHealth): boolean {
  return (
    h.items === "ok" &&
    h.appointments === "ok" &&
    h.plans === "ok" &&
    h.diary === "ok" &&
    h.practitioners === "ok"
  );
}

/**
 * One patient's treatment plan panel, cached for 30 seconds (successes only).
 *
 * Same cache rule as getPatientChart, and for the same reason spelled out there:
 * memoising a failure would pin "we could not read this patient's plan" onto that
 * patient for the full window, for every user on the instance, long after Dentally
 * had recovered.
 */
export async function getPlanPanelRead(patientId: string, siteId: string): Promise<PlanPanelRead> {
  const key = `panel:${siteId}:${patientId}`;
  const hit = panelCache.get(key);
  if (hit && Date.now() - hit.at < PANEL_CACHE_TTL_MS) return hit.value;

  const value = await getPlanPanelReadUncached(patientId, siteId);
  if (panelHealthy(value.health)) {
    panelCache.set(key, { at: Date.now(), value });
    if (panelCache.size > 100) {
      for (const [k] of [...panelCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 25)) {
        panelCache.delete(k);
      }
    }
  }
  return value;
}

/** The panel read with no cache of its own. Prefer getPlanPanelRead. */
export async function getPlanPanelReadUncached(
  patientId: string,
  siteId: string,
): Promise<PlanPanelRead> {
  const client: DentallyClient = dentallyFromEnv();

  const health: PlanPanelHealth = {
    items: "ok",
    appointments: "ok",
    plans: "ok",
    diary: "ok",
    practitioners: "ok",
  };
  let truncated = false; // THIS PATIENT'S plan: items and cards
  let truncatedSupporting = false; // the plan list, the diary and the practitioners

  const itemsP = pageToCeiling(
    (page, perPage) =>
      client
        .listTreatmentPlanItems({ patientId, page, perPage })
        .then((res) => (Array.isArray(res.treatment_plan_items) ? res.treatment_plan_items : [])),
    PER_PAGE,
    ITEMS_MAX_PAGES,
  )
    .then((out) => {
      if (out.truncated) truncated = true;
      return out.rows.map((row) => (row && typeof row === "object" ? row : {}) as Record<string, unknown>);
    })
    .catch((err) => {
      console.error(`[dentally] treatment_plan_items failed for patient ${patientId}`, err);
      health.items = "failed";
      return [] as Record<string, unknown>[];
    });

  const apptsP = pageToCeiling(
    (page, perPage) =>
      client
        .listTreatmentAppointments({ patientId, page, perPage })
        .then((res) =>
          Array.isArray(res.treatment_appointments) ? res.treatment_appointments : [],
        ),
    PER_PAGE,
    PANEL_SMALL_MAX_PAGES,
  )
    .then((out) => {
      if (out.truncated) truncated = true;
      return out.rows.map((row) => (row && typeof row === "object" ? row : {}) as Record<string, unknown>);
    })
    .catch((err) => {
      console.error(`[dentally] treatment_appointments failed for patient ${patientId}`, err);
      health.appointments = "failed";
      return [] as Record<string, unknown>[];
    });

  const plansP = pageToCeiling(
    (page, perPage) =>
      client
        .listTreatmentPlansById({ siteId: dentallySiteId(siteId), patientId, page, perPage })
        .then((res) => (Array.isArray(res.treatment_plans) ? res.treatment_plans : [])),
    PER_PAGE,
    PANEL_SMALL_MAX_PAGES,
  )
    .then((out) => {
      if (out.truncated) truncatedSupporting = true;
      return out.rows.map((row) => (row && typeof row === "object" ? row : {}) as Record<string, unknown>);
    })
    .catch((err) => {
      console.error(`[dentally] treatment_plans failed for patient ${patientId}`, err);
      health.plans = "failed";
      return [] as Record<string, unknown>[];
    });

  // THE DIARY, and it is ONE list read rather than a GET per card on purpose. A
  // patient with eight cards would otherwise issue eight requests, each able to
  // fail on its own, on a screen opened at the chair. cancelled=true is passed
  // because a card booked as an appointment that was later cancelled still HAS a
  // date and a clinician, and the default excludes exactly those rows — a card
  // would then report "not in this patient's appointment list" for an appointment
  // that plainly exists in Dentally.
  const diaryP = pageToCeiling(
    (page, perPage) =>
      client
        .getPatientAppointments(patientId, page, perPage, true)
        .then((res) => (Array.isArray(res.appointments) ? res.appointments : [])),
    PER_PAGE,
    DIARY_MAX_PAGES,
  )
    .then((out) => {
      if (out.truncated) truncatedSupporting = true;
      return out.rows.map((row) => (row && typeof row === "object" ? row : {}) as Record<string, unknown>);
    })
    .catch((err) => {
      console.error(`[dentally] appointments failed for patient ${patientId} (plan panel headers)`, err);
      health.diary = "failed";
      return [] as Record<string, unknown>[];
    });

  // THE FIFTH STREAM: the site's practitioners, which is the only place in this
  // read a practitioner_id can be turned into a NAME.
  //
  // IT IS NOT OPTIONAL POLISH. Every treatment_plan_item carries a practitioner_id
  // and no name, and before this read existed the panel resolved names ONLY from
  // the diary appointments the card headers happened to resolve. 17 of 100 live
  // items sit on an appointment at all, so 83% of a real plan could be named only
  // by coincidence, and a plan with no resolved card rendered a blank clinician on
  // every row of it. A blank cell on this table means "Dentally sent nothing here"
  // (appointment-card.tsx says so where the columns are defined), so that blank was
  // a false statement about who treated a patient, on a screen that looked finished.
  //
  // SITE SCOPED, like the plans read beside it, and mapped through dentallySiteId()
  // for the same reason: our internal id is not Dentally's.
  //
  // ACTIVE IS NOT FILTERED. read.ts drops inactive rows because it is filling a
  // picker of people you can book today. This is a HISTORICAL record: a filling
  // placed in 2019 by a clinician who has since left the practice still has to
  // carry their initials, and dropping them here would put the unresolved mark
  // against exactly the oldest entries.
  const practitionersP = pageToCeiling(
    (page, perPage) =>
      client
        .listPractitioners(dentallySiteId(siteId), { page, perPage })
        .then((res) => (Array.isArray(res.practitioners) ? res.practitioners : [])),
    PER_PAGE,
    PANEL_SMALL_MAX_PAGES,
  )
    .then((out) => {
      if (out.truncated) truncatedSupporting = true;
      return out.rows.map((row) => (row && typeof row === "object" ? row : {}) as Record<string, unknown>);
    })
    .catch((err) => {
      console.error(`[dentally] practitioners failed for site ${siteId} (plan panel names)`, err);
      health.practitioners = "failed";
      return [] as Record<string, unknown>[];
    });

  const [rawItems, rawAppts, rawPlans, rawDiary, rawPractitioners] = await Promise.all([
    itemsP,
    apptsP,
    plansP,
    diaryP,
    practitionersP,
  ]);

  const fetchedAt = new Date().toISOString();

  // The same client-side patient filter the chart read keeps, for the same reason:
  // whether these endpoints honour patient_id is unverified, and a plan showing
  // another patient's treatment is the worst outcome available here. A row that
  // carries NO patient_id is KEPT — dropping those would empty the panel entirely
  // if the endpoint turns out to hang its rows off treatment_plan_id alone, and an
  // empty panel reads as "this patient has no treatment plan".
  const mine = (r: Record<string, unknown>): boolean => {
    const owner = idOf(r.patient_id);
    return owner === null || owner === patientId;
  };

  // EVERY ITEM BECOMES A ROW, including one whose teeth would not parse. The chart
  // above routes those into `unplaced` because it cannot draw them on an arch; the
  // panel is a LIST, and a treatment with a price, a duration and a clinician is a
  // real row whatever its teeth field said. Filtering them here would hide charged
  // work from the person reading the plan.
  const items: PlanPanelItem[] = rawItems.filter(mine).map((r) => ({
    ...toChartItem(r).item,
    treatmentAppointmentId: idOf(r.treatment_appointment_id),
    pricePence: pence(r.price),
  }));

  const appointments = rawAppts.filter(mine).map(toPlanAppointment).filter((a) => a.id !== "");

  const plans = rawPlans.filter(mine).map(toPlanHeader).filter((p) => p.id !== "");

  const diary = new Map<string, Record<string, unknown>>();
  for (const row of rawDiary) {
    const id = idOf(row.id);
    if (id !== null) diary.set(id, row);
  }

  // ONE map for the whole read, keyed by the id an item actually carries. Through
  // idOf(), because practitioner ids arrive as NUMBERS from live Dentally and as
  // strings from the mock, and a str()-only key would leave every live row
  // unmatched while every local one resolved.
  //
  // A row we could not name is simply absent from the map rather than present with
  // a placeholder: the view then knows the difference between "Dentally named no
  // clinician on this line" and "Dentally named one we could not look up", and it
  // renders those two differently.
  const practitionerNames: Record<string, string> = {};
  for (const row of rawPractitioners) {
    const id = idOf(row.id);
    const name = practitionerNameOf(row);
    if (id !== null && name !== null) practitionerNames[id] = name;
  }

  // --- The split into panels ------------------------------------------------
  // One panel per plan, and then a SYNTHETIC panel for everything left over.
  //
  // The leftover panel is not a nicety. An item whose treatment_plan_id is null,
  // or names a plan the plans read did not return (a plan on another site, a plan
  // past the page ceiling, a failed plans read), belongs to no panel — and a
  // per-plan split with no catch-all silently drops it while every panel on screen
  // still looks complete. That is the same failure the unassigned bucket exists to
  // prevent, one level up.
  const planIds = new Set(plans.map((p) => p.id));
  const itemsByPlan = new Map<string, PlanPanelItem[]>();
  const orphanItems: PlanPanelItem[] = [];
  for (const item of items) {
    const pid = item.planId;
    if (pid !== null && planIds.has(pid)) {
      const bucket = itemsByPlan.get(pid);
      if (bucket) bucket.push(item);
      else itemsByPlan.set(pid, [item]);
    } else {
      orphanItems.push(item);
    }
  }

  // Cards split the same way, and an ORPHAN CARD goes to the synthetic panel too
  // rather than being dropped: a card carrying rows we did place would otherwise
  // leave those rows in a bucket with no header.
  // PlanAppointment carries no plan id, because buildPlanPanel does not need one.
  // The owning plan is therefore read off the RAW row, indexed here rather than
  // searched per card.
  const apptPlanById = new Map<string, string | null>();
  for (const r of rawAppts) {
    const id = idOf(r.id);
    if (id !== null) apptPlanById.set(id, idOf(r.treatment_plan_id));
  }
  const apptsByPlan = new Map<string, PlanAppointment[]>();
  const orphanAppts: PlanAppointment[] = [];
  for (const a of appointments) {
    const pid = apptPlanById.get(a.id) ?? null;
    if (pid !== null && planIds.has(pid)) {
      const bucket = apptsByPlan.get(pid);
      if (bucket) bucket.push(a);
      else apptsByPlan.set(pid, [a]);
    } else {
      orphanAppts.push(a);
    }
  }

  const headersFor = (list: PlanAppointment[]): Record<string, PlanCardHeader> => {
    const out: Record<string, PlanCardHeader> = {};
    for (const a of list) out[a.id] = resolveCardHeader(a, diary, health.diary === "failed");
    return out;
  };

  const panels: PlanPanelEntry[] = plans.map((plan) => {
    const planAppts = apptsByPlan.get(plan.id) ?? [];
    return {
      plan,
      // GROUPING AND TOTALS ARE buildPlanPanel'S, not this file's.
      model: buildPlanPanel({ plan, appointments: planAppts, items: itemsByPlan.get(plan.id) ?? [] }),
      cardHeaders: headersFor(planAppts),
      practitioners: practitionerNames,
      synthetic: false,
    };
  });

  if (orphanItems.length > 0 || orphanAppts.length > 0) {
    // The synthetic plan carries NULL money, never zero: we do not have this
    // plan's record, so we do not know its value, and "£0.00" would be a claim.
    const plan: PlanHeader = {
      id: "",
      nickname:
        health.plans === "failed"
          ? "Treatment not shown against a plan (the plan list could not be read)"
          : "Treatment not shown against a plan",
      completed: false,
      completedAt: null,
      startDate: null,
      endDate: null,
      paymentPlanId: null,
      practitionerId: null,
      privateTreatmentValuePence: null,
      nhsUdaHundredths: null,
      nhsCompletedUdaHundredths: null,
    };
    panels.push({
      plan,
      model: buildPlanPanel({ plan, appointments: orphanAppts, items: orphanItems }),
      cardHeaders: headersFor(orphanAppts),
      practitioners: practitionerNames,
      synthetic: true,
    });
  }

  // THE OUTER RECONCILIATION. buildPlanPanel counts what it received against what
  // it rendered inside one plan; this counts what we read against what reached any
  // panel at all, which is the only place a bug in the split above could show.
  const renderedItemCount = panels.reduce(
    (n, p) => n + p.model.groups.reduce((m, g) => m + g.rows.length, 0),
    0,
  );

  return {
    panels,
    itemCount: items.length,
    renderedItemCount,
    balanced: renderedItemCount === items.length,
    truncated,
    truncatedSupporting,
    fetchedAt,
    health,
  };
}
