// ===========================================================================
// PATCH /api/calendar/appointment/[id]   move, reassign or resize an appointment
// GET   /api/calendar/appointment/[id]?site=<siteId>   its recorded move history
//
// A THIN SHELL. Every guard, every re-validation, the fresh payload, the write
// and the read-back live in src/lib/calendar/move-service.ts so they can be
// driven directly by a test: the ORDER of those guards is the safety property,
// and an order nobody can test is an order that drifts.
//
// UNDO is this same route with the previous values plus `undoOf`. It is not a
// special unvalidated path: it re-runs the identical gate, the identical
// server-side re-validation and the identical read-back, because a reversal
// written blind is exactly as dangerous as a move written blind.
// ===========================================================================

import { requireDiaryAdmin } from "@/lib/calendar/access";
import { performMove } from "@/lib/calendar/move-service";
import { listMovesForAppointment } from "@/lib/calendar/repository";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Request body must be valid JSON." }, { status: 400 });
  }

  return performMove(id, body);
}

/**
 * The move history for one appointment: who moved it, when, and what happened to
 * the patient's text.
 *
 * A FAILED read is reported as failed and never as an empty history. Migration
 * 0063 is checked in but not applied, so locally this genuinely cannot be read,
 * and the panel must say so rather than implying an appointment has never moved.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const siteId = (new URL(request.url).searchParams.get("site") ?? "").trim();

  const access = await requireDiaryAdmin(siteId);
  if (access instanceof Response) return access;

  const read = await listMovesForAppointment(siteId, id);
  return Response.json({ ok: true, moves: read.moves, failed: read.failed });
}
