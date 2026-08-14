import { getClient, getSite } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireApproverRole } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getViewScope } from "@/lib/site-view";
import { isDayKey, weekdayOfDayKey } from "@/lib/absence/rules";
import { listApprovedAbsence } from "@/lib/absence/repository";
import { sendMessage } from "@/lib/messaging/send";
import { isSuppressed } from "@/lib/messaging/suppression";
import { isDryRun } from "@/lib/messaging/types";
import { practiceName } from "@/lib/rota/config";
import { draftShiftMessage, type ShiftLine } from "@/lib/rota/draft";
import {
  buildPublication,
  summarisePrePublish,
  weekRange,
  type PublishedShift,
} from "@/lib/rota/publish";
import {
  listPublications,
  listShifts,
  listStaff,
  markNotified,
  markPublished,
  recordPublication,
} from "@/lib/rota/repository";
import { isSystemEnabledForSend } from "@/lib/systems/repository";
import type { Absence } from "@/lib/absence/types";
import type { RotaStaff } from "@/lib/rota/types";

export const dynamic = "force-dynamic";

// ===========================================================================
// GET  /api/rota/publish?client=&weekStart=  the pre-publish summary.
// POST /api/rota/publish                     publish the week, then tell people.
//
// PUBLISHING TEXTS REAL PHONES, so it wears every gate the 24/7 sweep wears, in the
// same order and with the same fail directions. All three are copied from
// `api/rota/sweep/route.ts` rather than reasoned out again:
//
//   1. THE KILL SWITCH. `isSystemEnabledForSend(client, "rota")`. The sweep skips a
//      disabled client entirely; publishing REFUSES, which is a deliberate
//      difference. "Published" is a promise that people were told. Recording a
//      version nobody was told about would put a lie in the evidence log, and the
//      log is the only reason the log exists.
//
//   2. MESSAGING_DRY_RUN. The provider returns {provider:"dry-run"} and we count a
//      simulation and CHANGE NOTHING ELSE. Marking the shifts notified here would
//      permanently consume their unnotified state, and the first real send after
//      switch-on would skip every one of them: nobody would ever get their first
//      text. The publication row still gets written (the manager did publish) with
//      notified_count 0 and simulated_count set, so the record stays honest.
//
//   3. SUPPRESSION, FAIL CLOSED. A number that texted STOP is not texted again, and
//      a suppression read that FAILS counts as suppressed. A skipped send self-heals
//      on the next publish; a send made against somebody's opt-out does not.
//
// GUARD: requireUser -> requireClientAccess -> requireApproverRole.
// ===========================================================================

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

function siteName(siteId: string): string {
  return getSite(siteId)?.name ?? siteId;
}

/** A staff member's published shifts, in the message's line shape. */
function toLines(shifts: PublishedShift[]): ShiftLine[] {
  return shifts.map((s) => ({
    date: s.shiftDate,
    start: s.startTime,
    end: s.endTime,
    siteName: siteName(s.siteId),
  }));
}

/**
 * Resolve the week + site being published, and read everything both methods need.
 *
 * `siteId` is null when the switcher is on All sites, and that null is CARRIED into
 * the publication key: publishing the whole group and publishing one site are two
 * different promises to two different audiences, and diffing one against the other
 * would report changes nobody made.
 */
async function loadWeek(clientId: string, weekStart: string, allSites: boolean, siteIds: string[]) {
  const { from, to } = weekRange(weekStart);
  const siteId = allSites ? null : (siteIds[0] ?? null);
  const [shifts, publications] = await Promise.all([
    listShifts(clientId, from, to, siteId ? { siteIds: [siteId] } : undefined),
    listPublications(clientId, weekStart, siteId),
  ]);
  let absences: Absence[] = [];
  try {
    absences = await listApprovedAbsence(clientId, from, to);
  } catch {
    absences = [];
  }
  return { siteId, shifts, publications, absences };
}

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const url = new URL(request.url);
  const client = getClient(url.searchParams.get("client") ?? "");
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // ---------------------------------------------------------------------------
  // THE CAPABILITY SWAP LANDED (orchestrator decision 7).
  // ---------------------------------------------------------------------------
  // NOTE ON THE COMMENTS IN THIS FILE: the key names below are written in backticks
  // and never in double quotes. The catalog's coverage sweep proves a key is
  // enforced by finding the quoted literal in the route source, so a comment
  // quoting a key would satisfy that proof on its own -- and did, until a mutation
  // check caught it: deleting the real guard left the sweep green because the
  // comment still said the words.
  //
  // THE SWAP LANDED, AND THE READ TOOK `rota.view`, NOT `rota.publish`. This GET is
  // the PREVIEW — who would be texted, and what changed since the last version. It
  // sends nothing. `rota.publish` is DESTRUCTIVE in the catalog, which means it
  // refuses outright on an environment with no sign-in configured; making the
  // preview refuse there would blank the screen the practice manager reads BEFORE
  // deciding, to protect an act she has not taken yet. The POST below carries
  // `rota.publish`, and that is where the phones are.
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;
  const capDenied = await requireCapability(auth, "rota.view");
  if (capDenied) return capDenied;

  const weekStart = url.searchParams.get("weekStart") ?? "";
  if (!isDayKey(weekStart)) return bad("weekStart must be a YYYY-MM-DD date");
  if (weekdayOfDayKey(weekStart) !== "monday") return bad("weekStart must be a Monday");

  const scope = await getViewScope(client.id);
  const { siteId, shifts, publications, absences } = await loadWeek(
    client.id,
    weekStart,
    scope.isAllSites,
    scope.siteIds,
  );

  const summary = summarisePrePublish({
    shifts,
    weekStart,
    siteId,
    previous: publications[0]?.snapshot ?? null,
    existingVersions: publications.map((p) => ({ version: p.version })),
    absences,
  });

  // The switch state travels WITH the summary so the button can say why it is
  // disabled instead of failing at the press.
  const enabled = await isSystemEnabledForSend(client.id, "rota");

  return Response.json({
    ok: true,
    weekStart,
    siteId,
    summary,
    canPublish: enabled,
    dryRun: isDryRun(),
    lastPublishedAt: publications[0]?.publishedAt ?? null,
    history: publications.map((p) => ({
      version: p.version,
      publishedAt: p.publishedAt,
      shiftCount: p.shiftCount,
      notifiedCount: p.notifiedCount,
      simulatedCount: p.simulatedCount,
    })),
  });
}

export async function POST(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const clientSlug = str(body.clientSlug, 60) ?? new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // ---------------------------------------------------------------------------
  // THE CAPABILITY SWAP LANDED (orchestrator decision 7).
  // ---------------------------------------------------------------------------
  // NOTE ON THE COMMENTS IN THIS FILE: the key names below are written in backticks
  // and never in double quotes. The catalog's coverage sweep proves a key is
  // enforced by finding the quoted literal in the route source, so a comment
  // quoting a key would satisfy that proof on its own -- and did, until a mutation
  // check caught it: deleting the real guard left the sweep green because the
  // comment still said the words.
  //
  // THE SWAP LANDED. `rota.publish` is DESTRUCTIVE — this is the act that texts
  // real phones and cannot be unsent — so on an environment with no sign-in
  // configured it refuses with a 503 that says exactly why, rather than messaging
  // a team on nobody's authority. GATES 1-3 below (kill switch, dry run,
  // suppression) still apply on top; this one decides whether the person may ask.
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;
  const capDenied = await requireCapability(auth, "rota.publish");
  if (capDenied) return capDenied;

  const weekStart = str(body.weekStart, 10) ?? "";
  if (!isDayKey(weekStart)) return bad("weekStart must be a YYYY-MM-DD date");
  if (weekdayOfDayKey(weekStart) !== "monday") return bad("weekStart must be a Monday");
  // "changed" (the default) tells only the people whose week is different from what
  // they were last told. "all" is a deliberate re-send. Defaulting to "changed"
  // means a stray second press does not text the whole team again for nothing.
  const notifyMode = body.notify === "all" ? "all" : "changed";

  // GATE 1: the kill switch, before anything is written.
  if (!(await isSystemEnabledForSend(client.id, "rota"))) {
    return Response.json(
      {
        ok: false,
        error:
          "Staff rota is switched off in System controls, so the rota cannot be published. Nobody would be told about it.",
      },
      { status: 409 },
    );
  }

  const scope = await getViewScope(client.id);
  const { siteId, shifts, publications, absences } = await loadWeek(
    client.id,
    weekStart,
    scope.isAllSites,
    scope.siteIds,
  );

  const summary = summarisePrePublish({
    shifts,
    weekStart,
    siteId,
    previous: publications[0]?.snapshot ?? null,
    existingVersions: publications.map((p) => ({ version: p.version })),
    absences,
  });
  const snapshot = buildPublication(shifts, weekStart, summary.version, siteId);
  if (snapshot.shifts.length === 0) {
    return bad("There are no shifts to publish for that week.", 409);
  }

  // Who to tell. On a re-publish, only the people whose week actually changed,
  // unless the manager explicitly asked to tell everybody again.
  const changedStaff = new Set<string>();
  if (summary.diff) {
    for (const s of summary.diff.added) changedStaff.add(s.staffId);
    for (const s of summary.diff.removed) changedStaff.add(s.staffId);
    for (const c of summary.diff.changed) {
      changedStaff.add(c.before.staffId);
      changedStaff.add(c.after.staffId);
    }
  }
  const tellEveryone = notifyMode === "all" || summary.firstPublish;

  const staff = await listStaff(client.id);
  const staffById = new Map<string, RotaStaff>(staff.map((s) => [s.id, s]));
  const name = practiceName(client.id);

  const byStaff = new Map<string, PublishedShift[]>();
  for (const s of snapshot.shifts) {
    const list = byStaff.get(s.staffId) ?? [];
    list.push(s);
    byStaff.set(s.staffId, list);
  }

  const dryRun = isDryRun();
  let notifiedStaff = 0;
  let simulatedStaff = 0;
  // Everyone this publish could NOT reach, for whatever reason: no phone and no
  // email on file, an opt-out, or every attempt failing. One honest number rather
  // than three that between them miss the suppressed case, which an earlier draft
  // of this route counted in none of its buckets and therefore never reported.
  let notReached = 0;
  let sendFailures = 0;
  const notifiedShiftIds: string[] = [];
  const providers = new Set<string>();

  for (const [staffId, staffShifts] of byStaff) {
    if (!tellEveryone && !changedStaff.has(staffId)) continue;
    const person = staffById.get(staffId);
    if (!person) {
      notReached += 1;
      continue;
    }

    // NOT `body`: the request body is already in scope, and shadowing it here is
    // exactly how a route ends up texting somebody a JSON blob.
    const messageBody = draftShiftMessage(person.name, name, toLines(staffShifts));
    const subject = `Your shifts at ${name}, week beginning ${weekStart}`;
    const siteForSuppression = staffShifts[0]?.siteId ?? "";

    let reached = false;
    let simulated = false;

    // --- SMS ---------------------------------------------------------------
    if (person.phone) {
      // GATE 3: fail closed. A suppression read that throws counts as suppressed.
      let suppressed = true;
      try {
        suppressed = await isSuppressed(siteForSuppression, "sms", person.phone);
      } catch {
        suppressed = true;
      }
      if (!suppressed) {
        try {
          const res = await sendMessage({ channel: "sms", to: person.phone, body: messageBody });
          providers.add(res.provider);
          if (res.provider === "dry-run") simulated = true;
          else reached = true;
        } catch {
          // One bad number must never abort the publish for the rest of the team.
          sendFailures += 1;
        }
      }
    }

    // --- EMAIL -------------------------------------------------------------
    // A second channel, not a fallback: a rota is worth having in writing, and some
    // staff have an email on file and no mobile.
    if (person.email) {
      let suppressed = true;
      try {
        suppressed = await isSuppressed(siteForSuppression, "email", person.email);
      } catch {
        suppressed = true;
      }
      if (!suppressed) {
        try {
          const res = await sendMessage({ channel: "email", to: person.email, body: messageBody, subject });
          providers.add(res.provider);
          if (res.provider === "dry-run") simulated = true;
          else reached = true;
        } catch {
          sendFailures += 1;
        }
      }
    }

    if (reached) {
      notifiedStaff += 1;
      // GATE 2, the half that matters: only shifts REALLY sent consume their
      // unnotified state. In dry-run this list stays empty.
      notifiedShiftIds.push(...staffShifts.map((s) => s.id));
    } else if (simulated) {
      simulatedStaff += 1;
    } else {
      notReached += 1;
    }
  }

  // The record of the act, written whether or not anybody could be reached: the
  // manager published, and that is the fact the log is about.
  let publication;
  try {
    publication = await recordPublication({
      clientId: client.id,
      siteId,
      weekStart,
      version: summary.version,
      publishedBy: auth?.id ?? null,
      shiftCount: snapshot.shifts.length,
      snapshot,
      notifiedCount: notifiedStaff,
      simulatedCount: simulatedStaff,
    });
  } catch (err) {
    // LOUD. A publication that could not be recorded is not a publication, and a
    // cheerful {ok:true} here would leave the manager believing a version exists
    // that nobody can ever produce as evidence.
    return Response.json(
      {
        ok: false,
        error:
          "The rota was not published: the publication record could not be saved. Nothing has been changed. " +
          (err instanceof Error ? err.message : String(err)),
      },
      { status: 500 },
    );
  }

  await markPublished(
    client.id,
    snapshot.shifts.map((s) => s.id),
    summary.version,
    publication.publishedAt,
  );
  if (notifiedShiftIds.length > 0) await markNotified(notifiedShiftIds);

  return Response.json({
    ok: true,
    version: publication.version,
    weekStart,
    siteId,
    shiftCount: snapshot.shifts.length,
    notifiedStaff,
    simulatedStaff,
    notReached,
    sendFailures,
    dryRun,
    providers: [...providers],
    changeCount: summary.changeCount,
  });
}
