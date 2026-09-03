// ===========================================================================
// THE OS SCENARIO HARNESS.
//
// TEST SUPPORT ONLY. Nothing in the application imports this file.
//
// WHAT THESE SCENARIOS ARE FOR, AND HOW THEY DIFFER FROM WAVE 1's.
//
// Wave 1 proved each module against itself: the write gate refuses when the
// switch is off, the triage bank never asks an NHS-plan patient about symptoms,
// the equipment agent refuses an interlock bypass. Every one of those claims is
// about ONE file, and a per-module test is the right shape for it.
//
// These are about the JOINS. A practice does not experience a module; it
// experiences a journey — an enquiry arrives on the website, the platform texts
// back, the patient replies, an appointment is booked, a write intent is filed,
// and every one of those messages has to be on the patient's record afterwards.
// Five modules, four tables and two switches deep, and no module's own test can
// see the seam where two of them meet. So each file here is ONE journey, driven
// through the real code with an in-memory Supabase, and it asserts the state of
// EVERY module the journey touched — not only the one whose name is on the door.
//
// THREE INVARIANTS ARE ASSERTED IN EVERY JOURNEY, and they live here because a
// per-journey copy of them is a per-journey chance to weaken one:
//
//   1. NOTHING REACHED A LIVE DENTALLY HOST. Not "no test asserted that it did"
//      — proven twice over: a `fetch` guard that fails on any request to a
//      *.dentally.co host, and a ledger sweep that requires every intent row
//      aimed at such a host to be `blocked` (i.e. the gate refused before
//      constructing a client), with no row anywhere in status `sent`.
//   2. CORRESPONDENCE COMPLETENESS. Every message the journey sent is readable
//      from the patient's record, from the source that carries it. The record
//      read reports which sources failed; a journey where any source failed is
//      a journey whose record is lying by omission, so `failedSourceNames` must
//      be empty as well.
//   3. THE ANTI-OVERLAP DAILY CAP. One outreach message per recipient per
//      Europe/London day, across every module (src/lib/messaging/frequency.ts,
//      message_daily_log). Transactional rows are exempt BY DESIGN, so the
//      invariant is stated as: no address has more than one NON-transactional
//      stamp for a day.
//
// WHY NOTHING HERE IMPORTS `vitest`. This is not a `.test.ts` file, so vitest
// does not collect it, and a non-test module that imports the test runner is a
// module that can be pulled into a bundle by an editor's auto-import. So the
// helpers RETURN violations as strings rather than asserting them, and each
// journey writes `expect(violations).toEqual([])` — which also prints the whole
// list of what broke rather than stopping at the first one.
//
// WHY IT DOES NOT IMPORT THE IN-MEMORY DATABASE EITHER, and takes it as an
// argument instead. `src/lib/test-support/fake-supabase.ts` reads
// supabase/migrations/ off the filesystem, and roster.test.ts crawls src/ to
// prove that NO non-test file imports it — because a server component that did
// would read the disk on every request. This file is not a test file, so it is
// inside that crawl, and the rule is a good one: a `import type` would have
// satisfied the compiler and still tripped the crawl, and rightly, because the
// next edit turns a type import into a value one. So the world is handed its
// database by the journey that owns it, and the shape below is structural — the
// real FakeSupabase satisfies it without either file knowing about the other.
// ===========================================================================

export type Row = Record<string, unknown>;

/**
 * The in-memory Supabase, described rather than imported.
 *
 * Structurally identical to `FakeSupabase` in src/lib/test-support. Each journey
 * passes `createFakeSupabase()` in; nothing here needs to know where that came
 * from, and the crawl above stays true.
 */
export interface OsFake {
  db: { tables: Record<string, Row[]> };
  client: { from: (table: string) => unknown };
  reset: () => void;
  failTable: (table: string, message?: string) => void;
  clearFailures: () => void;
  rows: (table: string) => Row[];
  seed: (table: string, ...rows: Row[]) => void;
}

// ---------------------------------------------------------------------------
// The practice these journeys run in.
//
// Real ids out of src/lib/mock/clients.ts, deliberately, because the write gate
// resolves a client id from a site id through getSite() and a made-up site would
// send every intent row to client "unknown" — which passes an assertion about a
// ledger row while proving nothing about the wiring.
// ---------------------------------------------------------------------------

export const CLIENT = "vitality";
/** N15 Vitality Dental. Its publicPhone is the number the triage help-now line prints. */
export const SITE = "site-cc";
export const SITE_PHONE = "020 8808 8484";

/** A base URL that is NOT dentally.co, so the gate's target is the local mock. */
export const MOCK_DENTALLY_BASE = "http://localhost:3000/api/mock-dentally";
export const MOCK_DENTALLY_HOST = "localhost:3000";

// ---------------------------------------------------------------------------
// THE FETCH GUARD.
//
// The ledger sweep below proves the gate refused. This proves nothing slipped
// past the gate: if any code in a journey puts a request on the wire at all, the
// request is recorded and rejected, and a request to a *.dentally.co host is
// recorded as a VIOLATION rather than merely a surprise.
//
// It rejects every request, not only the Dentally ones. A scenario suite that
// reaches the network has stopped being a scenario suite, and the rejection
// names the URL so the surprise is diagnosable in one line.
// ---------------------------------------------------------------------------

export interface FetchGuard {
  /** Every URL any code tried to fetch, in order. */
  calls: string[];
  /** The subset aimed at a real Dentally host. Must always be empty. */
  liveDentallyCalls: string[];
  restore: () => void;
}

/** The same hostname test the write path uses (src/lib/dentally/write.ts). */
export function isLiveDentallyUrl(url: string): boolean {
  try {
    return /(^|\.)dentally\.co$/i.test(new URL(url).hostname);
  } catch {
    // An unparseable URL is treated as real, exactly as targetsRealDentally does:
    // the safe answer to "I cannot tell where this points" is "the live book".
    return true;
  }
}

export function installFetchGuard(): FetchGuard {
  const original = globalThis.fetch;
  const guard: FetchGuard = {
    calls: [],
    liveDentallyCalls: [],
    restore: () => {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch = (async (input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: unknown })?.url ?? input);
    guard.calls.push(url);
    if (isLiveDentallyUrl(url)) guard.liveDentallyCalls.push(url);
    throw new Error(
      `[os-scenarios] a scenario tried to reach the network: ${url}. ` +
        "Scenarios run entirely in memory; stub the model call or fix the wiring.",
    );
  }) as typeof globalThis.fetch;
  return guard;
}

// ---------------------------------------------------------------------------
// THE WORLD: an in-memory practice.
// ---------------------------------------------------------------------------

export interface OsWorld {
  fake: OsFake;
  /** Set a system_toggle row for the practice. Absent row ≠ false — see the catalog. */
  setToggle: (slug: string, enabled: boolean) => void;
  /** Remove a slug's toggle row entirely, so "absent" is testable. */
  clearToggle: (slug: string) => void;
  /** Rows currently in a table (a copy). */
  rows: (table: string) => Row[];
  reset: () => void;
}

export function createOsWorld(fake: OsFake): OsWorld {
  return {
    fake,
    setToggle(slug: string, enabled: boolean) {
      const rows = (fake.db.tables.system_toggle ??= []);
      const existing = rows.find((r) => r.client_id === CLIENT && r.module_slug === slug);
      if (existing) existing.enabled = enabled;
      else fake.seed("system_toggle", { client_id: CLIENT, module_slug: slug, enabled });
    },
    clearToggle(slug: string) {
      const rows = fake.db.tables.system_toggle;
      if (!rows) return;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].client_id === CLIENT && rows[i].module_slug === slug) rows.splice(i, 1);
      }
    },
    rows: (table: string) => fake.rows(table),
    reset: () => fake.reset(),
  };
}

// ---------------------------------------------------------------------------
// INVARIANT 1 — nothing reached a live Dentally host.
// ---------------------------------------------------------------------------

/**
 * Sweep the sync ledger and the fetch guard together.
 *
 * The two halves say different things and both are needed. The GUARD proves no
 * request left the process. The LEDGER proves the gate is the reason: a row
 * aimed at `api.dentally.co` must be `blocked`, because in dry-run mode the gate
 * returns before a client is constructed; a row that RAN must be aimed at the
 * mock and recorded `dry_run`. `sent` may not appear at all — it is the one
 * status that means the real practice book was written to.
 *
 * Returns a list of violations. Empty is the passing case.
 */
export function liveDentallyViolations(world: OsWorld, guard: FetchGuard): string[] {
  const problems: string[] = [];
  for (const url of guard.liveDentallyCalls) {
    problems.push(`a request was made to a live Dentally host: ${url}`);
  }
  for (const row of world.rows("dentally_write_intent")) {
    const target = String(row.target ?? "");
    const status = String(row.status ?? "");
    const kind = String(row.kind ?? "?");
    if (status === "sent") {
      problems.push(`intent ${kind} is status "sent" — that status means the live practice book was written`);
    }
    if (isLiveDentallyUrl(`https://${target}`) && status !== "blocked") {
      problems.push(
        `intent ${kind} targets the live host ${target} with status "${status}" — only "blocked" is safe there`,
      );
    }
    if (!isLiveDentallyUrl(`https://${target}`) && status !== "dry_run" && status !== "blocked") {
      problems.push(`intent ${kind} against the mock ${target} is status "${status}" — expected dry_run or blocked`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// INVARIANT 2 — correspondence completeness.
// ---------------------------------------------------------------------------

/** The shape getThreadForPatient returns, without importing the inbox here. */
export interface ThreadReadLike {
  thread: { messages: Array<{ source: string; body: string; direction: string }> } | null;
  failedSourceNames: string[];
}

/**
 * Every source named in `expectedSources` must appear on the record, and no
 * source may have failed to read.
 *
 * A failed source is a violation even when the expected ones are all present: a
 * record that could not read the balance-reminder history is a record that is
 * silently incomplete, and "the message I was looking for is there" is not
 * evidence that the rest is.
 */
export function correspondenceViolations(read: ThreadReadLike, expectedSources: string[]): string[] {
  const problems: string[] = [];
  for (const name of read.failedSourceNames) {
    problems.push(`the record could not read correspondence source "${name}"`);
  }
  if (expectedSources.length > 0 && !read.thread) {
    problems.push(`the record has no thread at all, but expected ${expectedSources.join(", ")}`);
    return problems;
  }
  const present = new Set((read.thread?.messages ?? []).map((m) => m.source));
  for (const name of expectedSources) {
    if (!present.has(name)) {
      problems.push(
        `correspondence source "${name}" is missing from the record (present: ${[...present].sort().join(", ") || "none"})`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// INVARIANT 3 — the anti-overlap daily cap.
// ---------------------------------------------------------------------------

/**
 * At most one OUTREACH stamp per (site, address, day) in message_daily_log.
 *
 * The log's primary key is that triple, so a second outreach message the same
 * day is an upsert no-op rather than a second row — which is precisely why the
 * check is written as "no duplicate triple" rather than "count === 1": a
 * duplicate can only appear if something bypassed the upsert, and that is the
 * failure worth catching.
 *
 * Transactional sources (diary, no-show, pre-visit) are exempt from the cap by
 * design and still stamp the day, so their presence is never a violation.
 */
export function dailyCapViolations(world: OsWorld): string[] {
  const seen = new Map<string, number>();
  for (const row of world.rows("message_daily_log")) {
    const key = `${String(row.site_id)}|${String(row.address)}|${String(row.sent_on)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const problems: string[] = [];
  for (const [key, count] of seen) {
    if (count > 1) problems.push(`message_daily_log has ${count} rows for ${key}; the daily cap upsert did not dedupe`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The funding-jargon rule, applied to anything patient-facing a journey produced.
// ---------------------------------------------------------------------------

/**
 * Words a patient must never see, in any agent message, form or link.
 *
 * "NHS" and "private" are the charter's rule (section 0.7). "111" is allowed and
 * "NHS 111" is not, which is why the scan is on the word NHS rather than on the
 * phrase — the triage help-now line says "call 111" for exactly this reason.
 */
export const FORBIDDEN_PATIENT_WORDS = [/\bNHS\b/i, /\bprivate(ly)?\b/i, /\bband\s*[123]\b/i];

export function patientCopyViolations(label: string, texts: string[]): string[] {
  const problems: string[] = [];
  for (const text of texts) {
    for (const rx of FORBIDDEN_PATIENT_WORDS) {
      const hit = rx.exec(text);
      if (hit) problems.push(`${label}: patient-facing copy contains "${hit[0]}" — ${JSON.stringify(text.slice(0, 120))}`);
    }
  }
  return problems;
}
