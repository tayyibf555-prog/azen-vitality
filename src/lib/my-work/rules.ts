// ---------------------------------------------------------------------------
// MY WORK — the staff self-service surface, as pure functions.
//
// No React, no database, no `fetch`, no `Date.now()`. Every decision this
// module makes is one a component would otherwise have inlined as a ternary,
// and this repo has already paid for rules hidden in React closures. Dates are
// inclusive London calendar days as `YYYY-MM-DD`, which sort lexicographically,
// so ordering is plain string comparison — no Date objects, no DST edge.
//
// THREE INVARIANTS LIVE HERE, and all three are the reason the file exists:
//
//  1. AN UNPUBLISHED DRAFT NEVER RENDERS. `isPublishedShift` requires a
//     publish stamp to be PRESENT, so a shift with no `publishedAt` — because
//     the rota was never published, because the publish migration is not
//     applied, or because a read forgot the filter — is withheld rather than
//     shown. Fail-closed in the direction that matters: a nurse must never
//     read a draft as her week.
//
//  2. A FAILED READ IS NEVER AN EMPTY STATE. `panelStateFor` checks the
//     failure BEFORE anything else, so "we could not load your shifts" can
//     never be rendered as "you have no shifts". Those two sentences mean
//     opposite things to somebody deciding whether to come in tomorrow.
//
//  3. NOTHING IS SHOWN WITHOUT A RESOLVED STAFF LINK. Every list function
//     takes `selfStaffId` and returns nothing at all when it is null, so a
//     login with no `rota_staff.app_user_id` cannot be shown somebody else's
//     row by an upstream mistake. The route narrows too; this is the second
//     lock, not the only one.
// ---------------------------------------------------------------------------

import { expiryState, type DocumentExpiryState, type StaffDocument } from "@/lib/hr/documents";
import {
  currentPolicies,
  signatureBindsToVersion,
  type StaffPolicy,
  type StaffPolicySignatureSummary,
} from "@/lib/hr/esign";

/** What a read attempt failed with. `status: null` means it never completed. */
export interface LoadFailure {
  /** HTTP status, or null when fetch itself threw (offline, DNS, aborted). */
  status: number | null;
  /** The server's own message, when it gave one worth repeating. */
  serverMessage?: string | null;
}

/**
 * A server message worth repeating to a person, or null.
 *
 * Guard responses in this codebase carry machine tokens — `{"error":"forbidden"}`,
 * `{"error":"unauthorized"}` — and showing one of those to a nurse looking at her
 * own page is an error code masquerading as an explanation. A message has to look
 * like a SENTENCE (more than one word, long enough to say something) before it is
 * preferred over our own wording.
 */
function usableServerMessage(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < 12 || !trimmed.includes(" ")) return null;
  return trimmed;
}

/**
 * The honest sentence for a failed read.
 *
 * EVERY branch returns a message, every message begins "We could not load",
 * and none of them is ever the empty string. That is asserted rather than
 * described: a blank message renders as a blank panel, which is exactly the
 * confident-empty-state failure this function exists to prevent.
 *
 * `subject` is a lower-case noun phrase ("your shifts", "your documents") so
 * the sentences read as English wherever they are used.
 */
export function describeFailure(subject: string, failure: LoadFailure): string {
  const server = usableServerMessage(failure.serverMessage);

  switch (failure.status) {
    case null:
      return `We could not load ${subject}: the server could not be reached. Nothing is shown rather than an empty list — try again in a moment.`;
    case 401:
      return `We could not load ${subject}: your session has expired. Sign in again.`;
    case 403:
      // Deliberately NOT the server's message. The role guards answer a bare
      // `{"error":"forbidden"}`, and "forbidden" on a staff member's own page is
      // an error code shown to a person, not an explanation.
      return `We could not load ${subject}: your login is not allowed to see it. Ask the practice manager to check your access.`;
    case 404:
      return `We could not load ${subject}: that part of the platform is not switched on for this practice yet.`;
    case 409:
      return server ?? `We could not load ${subject} for your login.`;
    case 503:
      return server ?? `We could not load ${subject}: it is not set up on this database yet.`;
    default:
      return server ?? `We could not load ${subject} (${failure.status}).`;
  }
}

/**
 * The copy every self-service surface shows when the login has no staff record.
 *
 * The shape is lifted verbatim from the clocking route, which is the only place
 * in the codebase that already had to say this — "Your login is not linked to a
 * staff record, so there is nothing to clock. The practice manager can link you
 * on the rota" (api/staff-check-in/route.ts). Same sentence, same remedy, so a
 * person who meets it twice meets the same wording twice.
 */
export function linkMissingCopy(consequence: string, remedy?: string): string {
  return (
    `Your login is not linked to a staff record, so ${consequence}. ` +
    (remedy ?? "The practice manager can link you to your staff record on People & logins.")
  );
}

/** What a tab should render right now. Exactly one of four, decided here. */
export type PanelState =
  | { kind: "failed"; message: string }
  | { kind: "loading" }
  | { kind: "unlinked"; message: string }
  | { kind: "ready"; count: number };

export interface PanelInput {
  /** Lower-case noun phrase for the failure sentence, e.g. "your shifts". */
  subject: string;
  /** Lower-case clause for the unlinked sentence, e.g. "there are no shifts to show". */
  consequence: string;
  loading: boolean;
  /** Whether the session resolved to a staff record. */
  linked: boolean;
  failure: LoadFailure | null;
  /** How many rows the tab has to show once it is ready. */
  count: number;
}

/**
 * THE ORDER IS THE RULE. A failure outranks everything, including a stale
 * `loading` flag and a missing staff link, because the one thing this surface
 * must never do is answer a question it could not actually answer.
 */
export function panelStateFor(input: PanelInput): PanelState {
  if (input.failure) {
    return { kind: "failed", message: describeFailure(input.subject, input.failure) };
  }
  if (input.loading) return { kind: "loading" };
  if (!input.linked) return { kind: "unlinked", message: linkMissingCopy(input.consequence) };
  return { kind: "ready", count: input.count };
}

// ---------------------------------------------------------------------------
// My rota.
// ---------------------------------------------------------------------------

/**
 * The subset of a rota shift this surface needs. Deliberately structural rather
 * than an import of `RotaShift`: the publish columns are added by the rota
 * lane's own migration, and this module must behave correctly BEFORE they
 * exist (they arrive as `undefined`, which reads as "not published").
 */
export interface SelfShift {
  id?: string | null;
  staffId: string;
  /** London calendar day, `YYYY-MM-DD`. */
  shiftDate: string;
  /** Wall-clock `HH:MM`. */
  startTime: string;
  endTime: string;
  role?: string | null;
  siteId?: string | null;
  status?: string | null;
  /** ISO instant the week this shift belongs to was published, or null/absent. */
  publishedAt?: string | null;
  publishedVersion?: number | null;
}

/** Statuses that mean "this shift is no longer yours", whatever its publish stamp. */
const WITHDRAWN_STATUSES = new Set(["cancelled", "removed"]);

function hasPublishStamp(shift: SelfShift): boolean {
  return typeof shift.publishedAt === "string" && shift.publishedAt.trim() !== "";
}

function isWithdrawn(shift: SelfShift): boolean {
  return WITHDRAWN_STATUSES.has(String(shift.status ?? "").toLowerCase());
}

/**
 * Whether a shift may be shown to the person working it.
 *
 * BOTH halves matter. A missing publish stamp is not "probably fine": the whole
 * point of a publish step is that a manager decides when a draft becomes a
 * promise, and a draft shown to staff is worse than no rota at all.
 */
export function isPublishedShift(shift: SelfShift): boolean {
  return hasPublishStamp(shift) && !isWithdrawn(shift);
}

export interface MyRotaView {
  /** The caller's published shifts, earliest first. */
  shifts: SelfShift[];
  /**
   * How many of the caller's shifts exist in the window but have NOT been
   * published. Surfaced so the tab can say "the rota for these days has not
   * been published yet" instead of the flatly wrong "you are not working".
   */
  withheld: number;
}

function byWhen(a: SelfShift, b: SelfShift): number {
  return (
    a.shiftDate.localeCompare(b.shiftDate) ||
    a.startTime.localeCompare(b.startTime) ||
    String(a.id ?? "").localeCompare(String(b.id ?? ""))
  );
}

/** The caller's own published shifts, plus a count of what is being withheld. */
export function myRota(shifts: SelfShift[], selfStaffId: string | null): MyRotaView {
  if (!selfStaffId) return { shifts: [], withheld: 0 };
  const mine = shifts.filter((s) => s.staffId === selfStaffId);
  return {
    shifts: mine.filter(isPublishedShift).sort(byWhen),
    // A withdrawn shift is not "waiting to be published", so it is not counted:
    // saying "1 shift not published yet" about a cancelled one is a lie.
    withheld: mine.filter((s) => !isWithdrawn(s) && !hasPublishStamp(s)).length,
  };
}

export interface ShiftDayGroup {
  dayKey: string;
  shifts: SelfShift[];
}

/** Group already-filtered shifts into ordered days, for a day-by-day list. */
export function groupShiftsByDay(shifts: SelfShift[]): ShiftDayGroup[] {
  const byDay = new Map<string, SelfShift[]>();
  for (const shift of [...shifts].sort(byWhen)) {
    const list = byDay.get(shift.shiftDate);
    if (list) list.push(shift);
    else byDay.set(shift.shiftDate, [shift]);
  }
  return [...byDay.entries()]
    .map(([dayKey, list]) => ({ dayKey, shifts: list }))
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

// ---------------------------------------------------------------------------
// My holiday.
// ---------------------------------------------------------------------------

/**
 * Narrow any staff-keyed list to the caller's own rows.
 *
 * The API narrows at the query, which is where it counts. This is the second
 * lock, in the one place that renders the rows: if a route is ever widened by
 * accident, this surface still shows one person's work — their own.
 */
export function mineOnly<T extends { staffId: string }>(rows: T[], selfStaffId: string | null): T[] {
  if (!selfStaffId) return [];
  return rows.filter((r) => r.staffId === selfStaffId);
}

/**
 * The staff id a self-service request must be posted for, or null.
 *
 * Always the SESSION'S staff record, never a form field. Returning null (rather
 * than "" or a guess) is what makes the caller handle the unlinked case.
 */
export function selfRequestStaffId(me: { id: string } | null | undefined): string | null {
  return me && typeof me.id === "string" && me.id !== "" ? me.id : null;
}

// ---------------------------------------------------------------------------
// My clocking.
//
// The clocking lane already computes the whole state machine: `buildTodayView`
// (@/lib/clock/pairing) returns, per person, the state, the ONLY tap that makes
// sense next, and when they clocked in. None of that is re-derived here — a
// second opinion about whether somebody is currently in would drift from the one
// the server re-checks with `validateClock`, and the button would then offer a
// tap the server refuses.
//
// What this module adds is the two things that surface is missing: WHICH row is
// mine, and the sentence to put beside the button.
// ---------------------------------------------------------------------------

/** The subset of a `TodayRow` this tab needs. Structural, so the shape can grow. */
export interface SelfClockRow {
  staffId: string;
  /** "in" | "out" | "expected" | "off", as the clocking lane decides it. */
  state: string;
  /** The only tap that makes sense next, decided by the clocking lane. */
  nextKind: "in" | "out";
  /** ISO instant they clocked in, while they are still in. */
  since?: string | null;
  /** Minutes across CLOSED sessions today. */
  minutes?: number | null;
  /** Minutes elapsed on the OPEN session. */
  openMinutes?: number | null;
}

/**
 * The caller's own row, or null.
 *
 * Null for an unresolved login AND for a login whose row is simply not in the
 * response — an approver's view of another site, say. Both mean "we cannot say",
 * and the tab must not invent an "out" state for somebody it cannot find: the
 * button would then offer to clock in a person it knows nothing about.
 */
export function myClockRow(rows: SelfClockRow[], selfStaffId: string | null): SelfClockRow | null {
  if (!selfStaffId) return null;
  return rows.find((r) => r.staffId === selfStaffId) ?? null;
}

/** "Clock in" / "Clock out" — a rule, because the server refuses the wrong one. */
export function clockActionLabel(nextKind: "in" | "out"): string {
  return nextKind === "in" ? "Clock in" : "Clock out";
}

/**
 * The sentence beside the button.
 *
 * `sinceLabel` is passed in ALREADY FORMATTED (this module holds no Intl and no
 * timezone), and its absence is handled rather than papered over: "clocked in"
 * with no time is still true and still useful, where "clocked in at —" is not.
 */
export function clockStateSentence(row: SelfClockRow | null, sinceLabel: string | null): string {
  if (!row) return "We do not have today's clocking for you.";
  if (row.state === "in") {
    return sinceLabel
      ? `You are clocked in, since ${sinceLabel}.`
      : "You are clocked in.";
  }
  if (row.state === "out") return "You are clocked out for now.";
  if (row.state === "expected") return "You are on the rota today and have not clocked in yet.";
  return "You are not on the rota today.";
}

// ---------------------------------------------------------------------------
// My documents.
//
// The vault lane owns `expiryState` and it is tested there, so it is IMPORTED
// rather than re-derived. A second opinion about whether a DBS certificate has
// lapsed is exactly the kind of rival rule that drifts, and the manager's screen
// and the nurse's screen would then disagree about the same certificate.
// ---------------------------------------------------------------------------

export interface MyDocumentRow {
  doc: StaffDocument;
  expiry: DocumentExpiryState;
}

/**
 * Worst first. `no-expiry` sorts LAST, with the valid ones: a passport scan
 * nobody dated is not urgent, and dressing it up as urgent would push a
 * genuinely expired indemnity off the top of the list.
 */
const EXPIRY_ORDER: Record<DocumentExpiryState, number> = {
  expired: 0,
  expiring: 1,
  valid: 2,
  "no-expiry": 3,
};

/**
 * The caller's own documents, worst expiry first.
 *
 * The narrowing is real, not cosmetic: `StaffDocument` carries `staffId`, so a
 * response that ever widened beyond one person would still render as one
 * person's file here. The route narrows too; this is the second lock.
 */
export function myDocuments(
  docs: StaffDocument[],
  selfStaffId: string | null,
  todayKey: string,
): MyDocumentRow[] {
  if (!selfStaffId) return [];
  return docs
    .filter((doc) => doc.staffId === selfStaffId)
    .map((doc) => ({ doc, expiry: expiryState(doc, todayKey) }))
    .sort(
      (a, b) =>
        EXPIRY_ORDER[a.expiry] - EXPIRY_ORDER[b.expiry] ||
        a.doc.label.localeCompare(b.doc.label) ||
        a.doc.id.localeCompare(b.doc.id),
    );
}

// ---------------------------------------------------------------------------
// My signatures.
//
// Two rules come from the e-sign lane and are IMPORTED, not restated:
//   `currentPolicies`        which version of each policy is actually in force
//                            today (retired ones out, future-dated ones not yet
//                            in force — nobody affirms a policy before it exists);
//   `signatureBindsToVersion` whether a signature affirms THIS version of THIS
//                            policy, which is the whole evidential claim.
// This module only decides what BELONGS TO ME and in what order it is shown.
// ---------------------------------------------------------------------------

export interface MyPolicyRow {
  policy: StaffPolicy;
  /** My signature against the version in force, or null when I still owe it. */
  signature: StaffPolicySignatureSummary | null;
  /** My signature on an EARLIER version, when the practice has re-issued it. */
  superseded: StaffPolicySignatureSummary | null;
}

export interface MyPolicyView {
  /** Never signed, or signed against a version that has since been replaced. */
  outstanding: MyPolicyRow[];
  /** Signed, against the version in force. */
  signed: MyPolicyRow[];
}

/**
 * The policies in force today, split into what I owe and what I have done.
 *
 * `selfStaffId` null returns nothing at all rather than everybody's signatures:
 * a login we cannot identify is shown no signature record, not a default one.
 */
export function myPolicies(
  policies: StaffPolicy[],
  signatures: StaffPolicySignatureSummary[],
  selfStaffId: string | null,
  todayKey: string,
): MyPolicyView {
  if (!selfStaffId) return { outstanding: [], signed: [] };

  const mine = signatures.filter((s) => s.staffId === selfStaffId);
  const rows: MyPolicyRow[] = currentPolicies(policies, todayKey).map((policy) => {
    const signature = mine.find((s) => signatureBindsToVersion(s, policy)) ?? null;
    // The most recent signature this person gave on an EARLIER version, so the
    // screen can say "you confirmed version 1 on 4 May" rather than implying they
    // have never seen the document.
    const superseded = signature
      ? null
      : (mine
          .filter((s) => s.policyId === policy.id && s.policyVersion !== policy.version)
          .sort((a, b) => b.signedAt.localeCompare(a.signedAt))[0] ?? null);
    return { policy, signature, superseded };
  });

  return {
    // Oldest in force first among what is owed: what has been waiting longest is
    // what to do next.
    outstanding: rows
      .filter((r) => r.signature === null)
      .sort(
        (a, b) =>
          a.policy.effectiveFrom.localeCompare(b.policy.effectiveFrom) ||
          a.policy.title.localeCompare(b.policy.title),
      ),
    // Most recently confirmed first among what is done.
    signed: rows
      .filter((r) => r.signature !== null)
      .sort(
        (a, b) =>
          String(b.signature?.signedAt ?? "").localeCompare(String(a.signature?.signedAt ?? "")) ||
          a.policy.title.localeCompare(b.policy.title),
      ),
  };
}

// ---------------------------------------------------------------------------
// READ IT, THEN CONFIRM IT.
// ---------------------------------------------------------------------------
// The evidential claim this whole lane produces is that a named login WAS SHOWN
// version N of a named document and affirmed it. For a while the screen had no
// way to open the document at all: it said "Read and confirm" and offered only
// the confirming half, which made the claim untrue on its face.
//
// The document is now opened through a short-lived signed URL. What is decided
// HERE is what the two controls say, because that copy is the difference between
// "I ticked a box" and "I was shown this and said yes".
//
// IT DOES NOT HARD-BLOCK. Refusing to enable the confirm button until an open
// succeeded would be a lock that lies: the person may have read the policy on
// paper, in an induction, or in a browser tab this app cannot observe, and a
// failed signed-URL mint (storage down, bucket missing) would then make the
// policy unsignable by anybody. So the copy CHANGES rather than the button
// disabling — before opening it asks them to open it, after opening it states
// what they were shown, and the record stores the affirmation either way.
// ---------------------------------------------------------------------------

export interface PolicyReadState {
  /** What the open control says. */
  openLabel: string;
  /** Whether the open control is mid-flight (spinner + disabled). */
  busy: boolean;
  /** The sentence above the name field, naming what is being affirmed. */
  confirmPrompt: string;
  /** True once this person has opened this version during this visit. */
  opened: boolean;
}

export function policyReadState(input: {
  title: string;
  version: number;
  /** True while the signed URL for THIS policy is being minted. */
  opening: boolean;
  /** True once the document has been opened in this session. */
  opened: boolean;
}): PolicyReadState {
  const opened = input.opened && !input.opening;
  return {
    openLabel: input.opening ? "Opening..." : opened ? "Open it again" : "Read the policy",
    busy: input.opening,
    // Before: an instruction. After: a STATEMENT OF WHAT THEY WERE SHOWN, which
    // is the sentence the record is actually about.
    confirmPrompt: opened
      ? `You opened version ${input.version} of ${input.title}. Type your full name to confirm you have read it.`
      : `Open version ${input.version} of ${input.title} above and read it, then type your full name to confirm.`,
    opened,
  };
}

/**
 * What to say when the document could not be opened.
 *
 * HONEST ABOUT WHAT DID NOT HAPPEN. The link is minted server-side and lasts two
 * minutes; when that fails, nothing was shown, and the message says so rather
 * than leaving somebody to confirm a document they never saw. It does not
 * speculate about the cause, and it does not tell them to sign anyway.
 */
export function policyOpenFailureCopy(title: string): string {
  return `We could not open ${title}, so nothing was shown to you. Try again in a moment, or ask the practice for a copy before you confirm it.`;
}
