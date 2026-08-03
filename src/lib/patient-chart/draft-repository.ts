import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { isChartDraftEnabled } from "@/lib/charting/write-gate";
import { parseSurfaces, serialiseSurfaces } from "@/lib/charting/surfaces";
import type { DraftEntry } from "@/lib/charting/types";

// ===========================================================================
// public.chart_draft — the clinician's in-progress SELECTION on the chart.
//
// THIS IS NOT A CLINICAL RECORD AND IT NEVER REACHES DENTALLY. Dentally publishes
// no create route on any charting resource, so there is nothing to send it to;
// this table holds what a dentist has marked on screen while talking to a patient,
// before typing the same thing into Dentally. It is switched OFF by default (see
// isChartDraftEnabled) because two sources of truth for clinical data is the worst
// outcome available and that call belongs to the practice, not to this file.
//
// WHY IT LIVES HERE AND NOT IN src/lib/charting/. chart-workspace.tsx is a client
// component that imports the reducer, the render state, the preferences and the
// write gate from src/lib/charting/. A server-only module holding serviceClient()
// sitting beside them is one mistaken import away from pulling the service-role
// client into the client graph. src/lib/patient-notes/repository.ts is separated
// from its own pure modules for exactly this reason.
//
// EVERY FUNCTION THROWS ON A DATABASE ERROR rather than catching to an empty
// array. A draft read that quietly returns nothing renders as "this clinician has
// planned nothing", which is a claim; the route turns the throw into an explicit
// failed state the screen can say out loud.
// ===========================================================================

interface Row {
  tooth_fdi: number;
  surfaces: string;
  treatment_code: string;
  treatment_name: string | null;
  dentition: string;
}

const COLS = "tooth_fdi, surfaces, treatment_code, treatment_name, dentition";

/** A stored row back into the shape the reducer works in. Surfaces are RE-PARSED
 *  through the one canonicaliser, so even a row written by some future path cannot
 *  hand the chart an order the reducer would never produce. */
function toEntry(r: Row): DraftEntry {
  const { surfaces } = parseSurfaces(r.surfaces);
  return {
    tooth: r.tooth_fdi,
    surfaces,
    treatmentCode: r.treatment_code,
    treatmentName: r.treatment_name ?? "",
    dentition: r.dentition === "deciduous" ? "deciduous" : "permanent",
  };
}

export interface DraftScope {
  siteId: string;
  patientId: string;
}

/**
 * This patient's whole draft, in this site.
 *
 * Returns [] when the feature is off — that is the shipped state, and the caller
 * has already been told so by the gate rather than by an empty list.
 */
export async function listDraft(scope: DraftScope): Promise<DraftEntry[]> {
  if (!isChartDraftEnabled()) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("chart_draft")
    .select(COLS)
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId)
    .order("tooth_fdi", { ascending: true });
  if (error) throw error;
  return (data as Row[]).map(toEntry);
}

/**
 * Save one tooth-and-treatment entry, replacing whatever was there.
 *
 * An UPSERT on the unique (site, patient, tooth, treatment) index, so re-marking a
 * tooth corrects the entry rather than accumulating near-duplicates. Surfaces are
 * serialised through the canonicaliser on the way in for the same reason they are
 * parsed on the way out.
 */
export async function upsertDraftEntry(scope: DraftScope, entry: DraftEntry, actor: string | null): Promise<void> {
  if (!isChartDraftEnabled()) return;
  const db = serviceClient();
  const { error } = await db
    .from("chart_draft")
    .upsert(
      {
        site_id: scope.siteId,
        dentally_patient_id: scope.patientId,
        tooth_fdi: entry.tooth,
        surfaces: serialiseSurfaces(entry.surfaces),
        treatment_code: entry.treatmentCode,
        treatment_name: entry.treatmentName,
        dentition: entry.dentition,
        created_by: actor,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "site_id,dentally_patient_id,tooth_fdi,treatment_code" },
    );
  if (error) throw error;
}

/**
 * Remove one entry.
 *
 * Scoped by site AND patient AND tooth AND treatment, written into the query rather
 * than checked once by the caller, so an entry can never be deleted across a site or
 * a patient boundary. Same discipline as the notes repository's three-part predicate.
 */
export async function deleteDraftEntry(
  scope: DraftScope,
  args: { tooth: number; treatmentCode: string },
): Promise<void> {
  if (!isChartDraftEnabled()) return;
  const db = serviceClient();
  const { error } = await db
    .from("chart_draft")
    .delete()
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId)
    .eq("tooth_fdi", args.tooth)
    .eq("treatment_code", args.treatmentCode);
  if (error) throw error;
}

/** Clear this patient's whole draft in this site. Nothing in Dentally is touched. */
export async function clearDraft(scope: DraftScope): Promise<void> {
  if (!isChartDraftEnabled()) return;
  const db = serviceClient();
  const { error } = await db
    .from("chart_draft")
    .delete()
    .eq("site_id", scope.siteId)
    .eq("dentally_patient_id", scope.patientId);
  if (error) throw error;
}
