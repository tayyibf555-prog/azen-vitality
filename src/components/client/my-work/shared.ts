import type { LoadFailure } from "@/lib/my-work/rules";

// ---------------------------------------------------------------------------
// My work: display helpers and the ENDPOINT CONTRACTS this surface consumes.
//
// Pure display only. Every DECISION (is this shift published, did the read fail,
// is this policy still owed) is computed in `@/lib/my-work/rules` with a sibling
// test, and arrives here already decided. This file formats it.
// ---------------------------------------------------------------------------

// ===========================================================================
// THE CONTRACTS.
//
// Three of the four tabs read data owned by other lanes. Their routes are NOT
// edited from here — the contract is stated once, in one place, so the seam is
// visible and a mismatch is a five-line fix rather than a hunt.
//
// EVERY ONE takes `mine=1`, and `mine=1` means exactly this:
//   - the route resolves the staff record from the SESSION (findStaffByAppUser),
//     never from a query or body parameter;
//   - it does NOT apply the approver/owner role guard on that branch, because
//     the caller is asking about themselves — a `client_staff` login must reach
//     it and every one of those guards refuses them;
//   - it returns the caller's OWN rows and nothing else, narrowed at the query;
//   - with no staff link it answers 409 and says so, rather than 200 + [].
//
// Until a lane ships its half, the tab renders an honest failure — never an
// empty list. That is what `describeFailure` in the rules module is for.
// ===========================================================================

/** Published shifts for the signed-in person. Owner: the rota lane. */
export function myShiftsUrl(clientSlug: string, from: string, to: string): string {
  const q = new URLSearchParams({ client: clientSlug, from, to, mine: "1" });
  return `/api/rota/shifts?${q.toString()}`;
}

/** The signed-in person's own holiday. Owner: this lane. */
export function myHolidayUrl(clientSlug: string): string {
  return `/api/absence?client=${encodeURIComponent(clientSlug)}`;
}

/**
 * Today's clocking. Owner: the clocking lane.
 *
 * NO `mine=1`: this route has always forked on the role instead (`canManage`),
 * and a non-approver's GET is already narrowed to their own single row at the
 * query. Passing a parameter it does not read would suggest a contract that
 * is not there.
 */
export function myClockUrl(clientSlug: string): string {
  return `/api/staff-check-in?client=${encodeURIComponent(clientSlug)}`;
}

/** The signed-in person's own document vault. Owner: the HR/vault lane. */
export function myDocumentsUrl(clientSlug: string): string {
  const q = new URLSearchParams({ client: clientSlug, mine: "1" });
  return `/api/hr/document?${q.toString()}`;
}

/**
 * A short-lived signed URL for ONE of the caller's own documents.
 *
 * The browser sends back the exact `storagePath` the server gave it and never
 * constructs one; the route re-checks the prefix and the `..` traversal guard
 * regardless, because a path from a browser is a request, not a fact.
 */
export function myDocumentUrlEndpoint(clientSlug: string, storagePath: string): string {
  const q = new URLSearchParams({ client: clientSlug, path: storagePath, mine: "1" });
  return `/api/hr/document/url?${q.toString()}`;
}

/** Policies the signed-in person is asked to sign, with their own signatures. */
export function myPoliciesUrl(clientSlug: string): string {
  const q = new URLSearchParams({ client: clientSlug, mine: "1" });
  return `/api/hr/policy?${q.toString()}`;
}

/** Where a signature is recorded. Owner: the e-sign lane. */
export function signPolicyUrl(policyId: string): string {
  return `/api/hr/policy/${encodeURIComponent(policyId)}/sign`;
}

// ---------------------------------------------------------------------------
// Formatting.
// ---------------------------------------------------------------------------

/** A "Mon 17 Aug" style label for a `YYYY-MM-DD` day, in London. */
export function dayLabel(dayKey: string): string {
  const ms = Date.parse(`${dayKey}T12:00:00Z`);
  if (Number.isNaN(ms)) return dayKey;
  return new Date(ms).toLocaleDateString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** "Mon 17 Aug 2026" — the longer form, for a date that needs its year. */
export function longDayLabel(dayKey: string): string {
  const ms = Date.parse(`${dayKey}T12:00:00Z`);
  if (Number.isNaN(ms)) return dayKey;
  return new Date(ms).toLocaleDateString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "2 Aug 2026, 09:14" for an ISO instant, in London. */
export function instantLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleString("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "09:00 to 17:00". */
export function timeRangeLabel(startTime: string, endTime: string): string {
  return `${startTime} to ${endTime}`;
}

/** "1.4 MB" / "812 KB" / "—". */
export function sizeLabel(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Document kind labels are NOT restated here: `DOCUMENT_KIND_LABELS` in
// @/lib/hr/documents is the one list, so the manager's vault and this page name
// the same certificate the same way.

/** Read a JSON endpoint, turning every way it can go wrong into a LoadFailure. */
export async function readJson<T>(url: string): Promise<{ data: T | null; failure: LoadFailure | null }> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    // The request never completed: offline, DNS, aborted. `status: null` is the
    // rules module's signal for exactly that, and it says so out loud.
    return { data: null, failure: { status: null } };
  }
  const body = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
  if (!res.ok || body === null || body.ok === false) {
    // An unparseable 200 counts as a failure, deliberately: rendering "you have
    // nothing" off a body we could not read is the exact lie this guards against.
    return { data: null, failure: { status: res.status, serverMessage: body?.error ?? null } };
  }
  return { data: body as T, failure: null };
}
