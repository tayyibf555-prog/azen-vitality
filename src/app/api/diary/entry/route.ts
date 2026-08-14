// ===========================================================================
// POST / PATCH / DELETE /api/diary/entry
//
// Breaks and notes on the diary. THESE ARE OUR RECORDS, NOT DENTALLY'S: Dentally
// exposes no endpoint for breaks, blocked time or diary notes, so nothing here
// mirrors it. They live in public.diary_entry (migration 0063).
//
// Every path is guarded by requireDiaryAdmin, which proves the caller may reach
// the named SITE and, when a practitioner is named, that the practitioner belongs
// to it. That last step is the one that is easy to miss and the only thing
// stopping a caller holding site A from hanging a break on a site B clinician's
// column.
//
// DELETE is SOFT. A break someone removed on a Monday stays recoverable and
// auditable, which matters when the question later is who took lunch off the
// diary.
// ===========================================================================

import { requireDiaryAdmin } from "@/lib/calendar/access";
import { requireCapability } from "@/lib/auth/capability-guard";
import { validateEntryInput } from "@/lib/calendar/entries";
import { insertEntry, softDeleteEntry, updateEntry } from "@/lib/calendar/repository";
import { recordUsage } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

interface EntryBody {
  siteId?: unknown;
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  body?: unknown;
  day?: unknown;
  startMin?: unknown;
  endMin?: unknown;
  practitionerId?: unknown;
}

async function readJson(request: Request): Promise<EntryBody | null> {
  try {
    return (await request.json()) as EntryBody;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * MIGRATION 0063 IS CHECKED IN BUT NOT APPLIED, so a write here can fail with a
 * missing relation. It is reported as a failure in the practice's own words
 * rather than as a silent no-op, because a break someone believes they saved and
 * which is not on the diary is exactly the class of error this feature exists to
 * prevent.
 */
function writeFailed(err: unknown, what: string): Response {
  console.error(`[diary] ${what} failed`, err);
  return Response.json(
    { ok: false, error: "That could not be saved. The diary has not been changed." },
    { status: 503 },
  );
}

export async function POST(request: Request): Promise<Response> {
  const payload = await readJson(request);
  if (!payload) return Response.json({ ok: false, error: "bad json" }, { status: 400 });

  const siteId = str(payload.siteId);
  const practitionerId = str(payload.practitionerId) || null;

  const access = await requireDiaryAdmin(siteId, practitionerId);
  if (access instanceof Response) return access;

  // THE PER-PERSON GATE, on top of requireDiaryAdmin's role gate. Every method on
  // this route is a write to the practice's own diary; the owner can withhold it
  // from one named individual without taking the whole diary away from them.
  const capabilityDenied = await requireCapability(access.auth, "diary.entry.write");
  if (capabilityDenied) return capabilityDenied;

  // Built field by field rather than forwarded, so nothing else a caller put on
  // the body can reach the validator or the database.
  const check = validateEntryInput({
    kind: payload.kind,
    title: payload.title,
    body: payload.body,
    day: payload.day,
    startMin: payload.startMin,
    endMin: payload.endMin,
    practitionerId: payload.practitionerId,
  });
  if (!check.ok) return Response.json({ ok: false, error: check.error }, { status: 400 });

  try {
    const entry = await insertEntry({
      clientId: access.clientId,
      siteId,
      practitionerId: check.value.practitionerId,
      day: check.value.day,
      startMin: check.value.startMin,
      endMin: check.value.endMin,
      kind: check.value.kind,
      title: check.value.title,
      body: check.value.body,
      authorId: access.auth?.id ?? null,
      authorName: access.auth?.email ?? "Team",
    });
    void recordUsage("calendar", "diary_entry_create", {
      clientId: access.clientId,
      userEmail: access.auth?.email,
      role: access.auth?.role,
    });
    return Response.json({ ok: true, entry });
  } catch (err) {
    return writeFailed(err, "insertEntry");
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const payload = await readJson(request);
  if (!payload) return Response.json({ ok: false, error: "bad json" }, { status: 400 });

  const siteId = str(payload.siteId);
  const id = str(payload.id);
  const practitionerId = str(payload.practitionerId) || null;
  if (!id) return Response.json({ ok: false, error: "id is required" }, { status: 400 });

  const access = await requireDiaryAdmin(siteId, practitionerId);
  if (access instanceof Response) return access;
  const capabilityDenied = await requireCapability(access.auth, "diary.entry.write");
  if (capabilityDenied) return capabilityDenied;

  // Built field by field rather than forwarded, so nothing else a caller put on
  // the body can reach the validator or the database.
  const check = validateEntryInput({
    kind: payload.kind,
    title: payload.title,
    body: payload.body,
    day: payload.day,
    startMin: payload.startMin,
    endMin: payload.endMin,
    practitionerId: payload.practitionerId,
  });
  if (!check.ok) return Response.json({ ok: false, error: check.error }, { status: 400 });

  try {
    // Site-scoped in the repository too, so an id from another practice cannot be
    // edited by pairing it with a site the caller does hold.
    const entry = await updateEntry(id, siteId, {
      practitionerId: check.value.practitionerId,
      day: check.value.day,
      startMin: check.value.startMin,
      endMin: check.value.endMin,
      kind: check.value.kind,
      title: check.value.title,
      body: check.value.body,
    });
    if (!entry) return Response.json({ ok: false, error: "not found" }, { status: 404 });
    void recordUsage("calendar", "diary_entry_update", {
      clientId: access.clientId,
      userEmail: access.auth?.email,
      role: access.auth?.role,
    });
    return Response.json({ ok: true, entry });
  } catch (err) {
    return writeFailed(err, "updateEntry");
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const payload = await readJson(request);
  if (!payload) return Response.json({ ok: false, error: "bad json" }, { status: 400 });

  const siteId = str(payload.siteId);
  const id = str(payload.id);
  if (!id) return Response.json({ ok: false, error: "id is required" }, { status: 400 });

  // No practitioner is named on a delete: the row is found by its own id inside
  // the site the caller has already been proved to hold.
  const access = await requireDiaryAdmin(siteId);
  if (access instanceof Response) return access;
  const capabilityDenied = await requireCapability(access.auth, "diary.entry.write");
  if (capabilityDenied) return capabilityDenied;

  try {
    const removed = await softDeleteEntry(id, siteId);
    if (!removed) return Response.json({ ok: false, error: "not found" }, { status: 404 });
    void recordUsage("calendar", "diary_entry_delete", {
      clientId: access.clientId,
      userEmail: access.auth?.email,
      role: access.auth?.role,
    });
    return Response.json({ ok: true });
  } catch (err) {
    return writeFailed(err, "softDeleteEntry");
  }
}
