import "server-only";
import { serviceClient } from "@/lib/supabase/server";

// Exact per-site patient counts from the nightly book scan (see
// /api/sync/patient-count). Dentally's index meta.total covers the whole book
// but ignores active/archived filters, so "how many ACTIVE patients" is counted
// by us, once a day, off-hours.

export interface PatientCountRow {
  siteId: string;
  total: number;
  active: number;
  countedAt: string; // ISO
}

export async function upsertPatientCount(row: { siteId: string; total: number; active: number }): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("patient_count").upsert(
    { site_id: row.siteId, total: row.total, active: row.active, counted_at: new Date().toISOString() },
    { onConflict: "site_id" },
  );
  if (error) throw error;
}

export async function getPatientCounts(siteIds: string[]): Promise<PatientCountRow[]> {
  const db = serviceClient();
  const { data, error } = await db.from("patient_count").select("*").in("site_id", siteIds);
  if (error) throw error;
  return ((data ?? []) as Array<{ site_id: string; total: number; active: number; counted_at: string }>).map((r) => ({
    siteId: r.site_id,
    total: Number(r.total),
    active: Number(r.active),
    countedAt: r.counted_at,
  }));
}
