import { serviceClient } from "@/lib/supabase/server";
import type { AfterHoursCapture, CaptureChannel, CaptureStatus } from "./types";

// Server-only persistence for the after-hours capture worklist. Mirrors the
// noshow repository row-mapper style: a private Row shape, a rowTo... mapper,
// and serviceClient() for every query (RLS-locked, server-only).

interface CaptureRow {
  id: string;
  site_id: string;
  from_number: string;
  dentally_patient_id: string | null;
  patient_name: string;
  channel: string;
  body: string | null;
  captured_at: string;
  status: string;
  follow_up_sent: boolean;
}

function rowToCapture(r: CaptureRow): AfterHoursCapture {
  return {
    id: r.id,
    siteId: r.site_id,
    fromNumber: r.from_number,
    dentallyPatientId: r.dentally_patient_id,
    patientName: r.patient_name,
    channel: r.channel as CaptureChannel,
    body: r.body,
    capturedAt: r.captured_at,
    status: r.status as CaptureStatus,
    followUpSent: r.follow_up_sent,
  };
}

export async function insertCapture(input: {
  siteId: string;
  fromNumber: string;
  dentallyPatientId?: string | null;
  patientName: string;
  channel: CaptureChannel;
  body?: string | null;
}): Promise<AfterHoursCapture> {
  const db = serviceClient();
  const { data, error } = await db
    .from("after_hours_capture")
    .insert({
      site_id: input.siteId,
      from_number: input.fromNumber,
      dentally_patient_id: input.dentallyPatientId ?? null,
      patient_name: input.patientName,
      channel: input.channel,
      body: input.body ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToCapture(data as CaptureRow);
}

export async function listCaptures(args: {
  siteIds: string[];
  statuses?: CaptureStatus[];
}): Promise<AfterHoursCapture[]> {
  const db = serviceClient();
  let q = db.from("after_hours_capture").select("*").in("site_id", args.siteIds);
  if (args.statuses && args.statuses.length > 0) q = q.in("status", args.statuses);
  const { data, error } = await q.order("captured_at", { ascending: false });
  if (error) throw error;
  return (data as CaptureRow[]).map(rowToCapture);
}

export async function getCapture(id: string): Promise<AfterHoursCapture | null> {
  const db = serviceClient();
  const { data, error } = await db.from("after_hours_capture").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? rowToCapture(data as CaptureRow) : null;
}

export async function setCaptureStatus(id: string, status: CaptureStatus): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("after_hours_capture").update({ status }).eq("id", id);
  if (error) throw error;
}

export async function markFollowUpSent(id: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("after_hours_capture").update({ follow_up_sent: true }).eq("id", id);
  if (error) throw error;
}

/**
 * Whether an open (status 'new') capture already exists from this number for a
 * site since the given instant. Used to dedupe the inbound webhook so a back and
 * forth of texts in one closed evening does not spawn a row per message.
 */
export async function hasOpenCaptureFrom(
  siteId: string,
  fromNumber: string,
  sinceIso: string,
): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("after_hours_capture")
    .select("id")
    .eq("site_id", siteId)
    .eq("from_number", fromNumber)
    .eq("status", "new")
    .gte("captured_at", sinceIso)
    .limit(1);
  if (error) throw error;
  return (data as unknown[]).length > 0;
}
