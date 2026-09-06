import { describe, it, expect, vi, beforeEach } from "vitest";

import { POSTGREST_MAX_ROWS } from "@/lib/test-support/fake-supabase";

vi.mock("server-only", () => ({}));

// A chainable Supabase builder mock, the same shape systems/repository.test.ts
// uses: every step returns the same thenable, so an awaited chain resolves to the
// configured result. `h.calls` records what the repository asked for, because
// several of the properties here are about the SHAPE of the query (the +1 that
// proves "there are more", the cap that stops a count becoming a scan) rather
// than about the rows that come back.
const h = vi.hoisted(() => {
  let result: { data: unknown; error: unknown } = { data: null, error: null };
  const calls: Record<string, unknown[]> = { insert: [], update: [], limit: [], eq: [], select: [] };
  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    b.select = (...a: unknown[]) => {
      calls.select.push(a[0]);
      return b;
    };
    b.eq = (...a: unknown[]) => {
      calls.eq.push(a);
      return b;
    };
    b.order = () => b;
    b.limit = (...a: unknown[]) => {
      calls.limit.push(a[0]);
      return Promise.resolve(result);
    };
    b.insert = (...a: unknown[]) => {
      calls.insert.push(a[0]);
      return b;
    };
    b.update = (...a: unknown[]) => {
      calls.update.push(a[0]);
      return b;
    };
    b.maybeSingle = () => Promise.resolve(result);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    return b;
  };
  return {
    calls,
    reset: () => {
      for (const k of Object.keys(calls)) calls[k] = [];
      result = { data: null, error: null };
    },
    set: (r: { data: unknown; error: unknown }) => {
      result = r;
    },
    serviceClient: vi.fn(() => ({ from: () => makeBuilder() })),
  };
});

vi.mock("@/lib/supabase/server", () => ({ serviceClient: h.serviceClient }));

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BLOCKED_REASONS,
  DENTALLY_WRITE_KINDS,
  WRITE_INTENT_STATUSES,
  COUNT_CAP,
  ROW_CAP,
  __resetLedgerFailureLogForTests,
  countWriteIntents,
  listWriteIntents,
  recordWriteIntent,
  sanitiseWriteError,
  settleWriteIntent,
} from "./sync-ledger";

const INTENT = {
  clientId: "vitality",
  siteId: "site-ng",
  kind: "appointment.create" as const,
  source: "recall",
  moduleSlug: "recall",
  target: "api.dentally.co",
  payloadSummary: { fields: ["patient_id"], values: { patient_id: "1" }, fieldCount: 1 },
  status: "dry_run" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.reset();
  __resetLedgerFailureLogForTests();
});

describe("recording an intent NEVER fails the write it is about", () => {
  it("returns the new row's id on the happy path", async () => {
    h.set({ data: { id: "intent-1" }, error: null });
    await expect(recordWriteIntent(INTENT)).resolves.toBe("intent-1");
  });

  it("returns null and does not throw when the table is not there yet", async () => {
    // Migration 0096 is applied in production, but a fresh environment that has
    // never run it fails exactly this way — as does a revoked grant. A booking
    // must be completely unaffected either way.
    h.set({ data: null, error: { code: "42P01", message: 'relation "dentally_write_intent" does not exist' } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordWriteIntent(INTENT)).resolves.toBe(null);
    spy.mockRestore();
  });

  it("does not throw when the client itself cannot be built", async () => {
    h.serviceClient.mockImplementationOnce(() => {
      throw new Error("supabaseUrl is required.");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordWriteIntent(INTENT)).resolves.toBe(null);
    spy.mockRestore();
  });

  it("logs the FIRST failure loudly and then stays quiet about the same one", async () => {
    // Five write paths file intents; wherever the ledger is unreachable every one
    // of them fails identically, and 200 copies of the same line bury the error
    // that matters. A DIFFERENT reason still logs.
    h.set({ data: null, error: { code: "42P01", message: "missing" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await recordWriteIntent(INTENT);
    await recordWriteIntent(INTENT);
    await recordWriteIntent(INTENT);
    expect(spy).toHaveBeenCalledTimes(1);
    h.set({ data: null, error: { code: "42501", message: "permission denied" } });
    await recordWriteIntent(INTENT);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("writes the column names migration 0096 declares", async () => {
    h.set({ data: { id: "x" }, error: null });
    await recordWriteIntent({ ...INTENT, actor: "a@b.c", responseId: "appt-1" });
    expect(h.calls.insert[0]).toMatchObject({
      client_id: "vitality",
      site_id: "site-ng",
      kind: "appointment.create",
      source: "recall",
      module_slug: "recall",
      target: "api.dentally.co",
      status: "dry_run",
      blocked_reason: null,
      actor: "a@b.c",
      response_id: "appt-1",
    });
  });
});

describe("the queued -> sent transition, for the day the write key arrives", () => {
  it("stamps the row sent with Dentally's own id, and clears any blocked reason", async () => {
    h.set({ data: null, error: null });
    await expect(settleWriteIntent("intent-1", { status: "sent", responseId: "appt-99" })).resolves.toBe(true);
    expect(h.calls.update[0]).toMatchObject({
      status: "sent",
      response_id: "appt-99",
      blocked_reason: null,
      error: null,
    });
    expect(h.calls.eq[0]).toEqual(["id", "intent-1"]);
  });

  it("stamps a failed replay with the sanitised error instead", async () => {
    h.set({ data: null, error: null });
    await settleWriteIntent("intent-1", { status: "failed", error: "Dentally 422: rejected" });
    expect(h.calls.update[0]).toMatchObject({ status: "failed", error: "Dentally 422: rejected" });
  });

  it("reports FALSE rather than throwing when the stamp does not land", async () => {
    // "Dentally accepted it" and "our note about it landed" are different facts
    // and a replay must not report one as the other.
    h.set({ data: null, error: { message: "down" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(settleWriteIntent("intent-1", { status: "sent" })).resolves.toBe(false);
    spy.mockRestore();
  });

  it("refuses an empty id rather than updating every row", async () => {
    await expect(settleWriteIntent("", { status: "sent" })).resolves.toBe(false);
    expect(h.calls.update).toEqual([]);
  });
});

describe("the reads are bounded, and say when they were cut short", () => {
  it("asks for ONE more row than it will return, so 'more' is proven not guessed", async () => {
    h.set({ data: [], error: null });
    await listWriteIntents("vitality", { limit: 10 });
    expect(h.calls.limit[0]).toBe(11);
  });

  it("caps the page at ROW_CAP however large a limit is asked for", async () => {
    h.set({ data: [], error: null });
    await listWriteIntents("vitality", { limit: 100000 });
    expect(h.calls.limit[0]).toBe(ROW_CAP + 1);
  });

  it("returns the page and reports that there are more", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      id: `i${i}`,
      client_id: "vitality",
      kind: "appointment.create",
      source: "recall",
      target: "api.dentally.co",
      status: "dry_run",
      created_at: "2026-09-01T00:00:00Z",
      payload_summary: { fields: [] },
    }));
    h.set({ data: rows, error: null });
    const page = await listWriteIntents("vitality", { limit: 3 });
    expect(page.rows).toHaveLength(3);
    expect(page.more).toBe(true);
  });

  it("propagates a read error rather than rendering an empty ledger as 'nothing happened'", async () => {
    h.set({ data: null, error: { message: "down" } });
    await expect(listWriteIntents("vitality")).rejects.toBeTruthy();
  });

  it("counts by status, and admits when the count is only a floor", async () => {
    h.set({
      data: [{ status: "dry_run" }, { status: "dry_run" }, { status: "blocked" }, { status: "sent" }],
      error: null,
    });
    const counted = await countWriteIntents("vitality");
    expect(counted.counts.dry_run).toBe(2);
    expect(counted.counts.blocked).toBe(1);
    expect(counted.counts.sent).toBe(1);
    expect(counted.total).toBe(4);
    expect(counted.capped).toBe(false);
    expect(h.calls.limit[0]).toBe(COUNT_CAP + 1);
  });

  it("marks the count CAPPED when the scan hit its ceiling, so it can be printed as 'at least'", async () => {
    h.set({ data: Array.from({ length: COUNT_CAP + 1 }, () => ({ status: "dry_run" })), error: null });
    const counted = await countWriteIntents("vitality");
    expect(counted.capped).toBe(true);
    expect(counted.total).toBe(COUNT_CAP);
  });

  it("the scan asks for fewer rows than PostgREST will return, or the cap can never be seen", () => {
    // THE FLAG IS ONLY AS HONEST AS ITS DETECTION. `capped` is proven by asking
    // for COUNT_CAP + 1 rows and seeing more than COUNT_CAP arrive — and Supabase
    // applies a server-side max-rows ceiling to every REST request, measured at
    // 1,000 on this project with the service-role key (limit=1500 and limit=2001
    // both returned exactly 1,000 rows, `content-range: 0-999/*`, no error). A
    // response clipped by that ceiling looks exactly like a short one, so with
    // COUNT_CAP at its original 2,000 the extra row could NEVER arrive: `capped`
    // was structurally false in production and the Sync Status screen would have
    // printed a floor as a bare total the moment the ledger passed a thousand
    // rows. The fake in these tests honours .limit(2001) literally, which is why
    // no behavioural test could catch it and why this one is arithmetic.
    //
    // THE CEILING IS IMPORTED, NOT RESTATED (ruling W3/32). It was declared here
    // as a local `const` and again in src/lib/test-support/fake-supabase.ts, where
    // the fake that MODELS it lives. Two copies of a measured number is how one of
    // them stops being the measured number: raising the shared constant without
    // this file noticing would leave this guard asserting against a ceiling the
    // database no longer has.
    expect(
      COUNT_CAP + 1,
      "countWriteIntents asks for more rows than PostgREST will hand back, so `capped` can never be true",
    ).toBeLessThanOrEqual(POSTGREST_MAX_ROWS);
    // And the same for the page read, which proves `more` the same way.
    expect(ROW_CAP + 1).toBeLessThanOrEqual(POSTGREST_MAX_ROWS);
  });

  it("ignores a status the ledger does not know, rather than inventing a bucket", async () => {
    h.set({ data: [{ status: "wat" }, { status: "sent" }], error: null });
    const counted = await countWriteIntents("vitality");
    expect(counted.total).toBe(1);
  });
});

describe("the stored error carries the complaint and not the patient", () => {
  it("redacts an email address Dentally echoed back", () => {
    const out = sanitiseWriteError(new Error("422 email_address aisha.rahman@example.co.uk is taken"));
    expect(out).not.toContain("aisha.rahman@example.co.uk");
    expect(out).toContain("[email]");
    expect(out).toContain("422");
  });

  it.each(["+447700900123", "07700900123", "00447700900123"])("redacts a phone number (%s)", (phone) => {
    const out = sanitiseWriteError(new Error(`422 mobile_phone ${phone} is invalid`));
    expect(out).not.toContain(phone);
    expect(out).toContain("[phone]");
  });

  it("truncates, so a 20KB Dentally body cannot become a 20KB ledger row", () => {
    expect(sanitiseWriteError(new Error("x".repeat(5000))).length).toBe(500);
  });

  it("copes with something thrown that is not an Error at all", () => {
    expect(sanitiseWriteError("plain string")).toBe("plain string");
    expect(sanitiseWriteError(undefined)).toBe("undefined");
  });
});

// ===========================================================================
// THE MIGRATION TEXT PROVES THE CONSTRAINT.
//
// The in-memory fakes above prove the code path; they have no CHECK constraints,
// so they would happily hold a row Postgres refuses. The house answer to that is
// to assert against the migration TEXT as well (postop/outbox-isolation.test.ts
// does the same), and here it matters twice over: a reason the code can emit and
// the database will not accept is an insert that fails at the exact moment a
// staff member's refused booking was supposed to be recorded.
// ===========================================================================

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../supabase/migrations/0096_dentally_write_intent.sql", import.meta.url)),
  "utf8",
);

/** The quoted values inside one `check (<col> in (...))` clause. */
function checkValues(column: string): string[] {
  const at = MIGRATION.indexOf(`${column} text`);
  expect(at, `${column} is not declared in 0096`).toBeGreaterThan(-1);
  const clause = MIGRATION.slice(at, MIGRATION.indexOf("))", at));
  return [...clause.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

describe("migration 0096 accepts exactly what the code can write, and no more", () => {
  it("the status CHECK matches WRITE_INTENT_STATUSES", () => {
    expect(checkValues("status")).toEqual([...WRITE_INTENT_STATUSES].sort());
  });

  it("the blocked_reason CHECK matches BLOCKED_REASONS", () => {
    // The two added by the coordinator's ruling are the ones this would have
    // caught: a gate emitting 'writes_disabled' against a CHECK that predates it
    // fails the insert at the exact moment a refused staff click was to be filed.
    expect(checkValues("blocked_reason")).toEqual([...BLOCKED_REASONS].sort());
    expect(checkValues("blocked_reason")).toContain("writes_disabled");
    expect(checkValues("blocked_reason")).toContain("master_off");
  });

  it("the kind CHECK matches DENTALLY_WRITE_KINDS", () => {
    const at = MIGRATION.indexOf("kind text not null check");
    const clause = MIGRATION.slice(at, MIGRATION.indexOf("))", at));
    const values = [...clause.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]).sort();
    expect(values).toEqual([...DENTALLY_WRITE_KINDS].sort());
  });

  it("a blocked row must carry a reason, and a reason may not sit on any other status", () => {
    // Both directions, because both are dishonest: an unexplained refusal a
    // practice cannot act on, and a sentence about something that did not happen.
    expect(MIGRATION).toContain("check (blocked_reason is null or status = 'blocked')");
    expect(MIGRATION).toContain("check (status <> 'blocked' or blocked_reason is not null)");
  });

  it("seeds the master switch OFF, without ever stamping over a later deliberate ON", () => {
    expect(MIGRATION).toContain("values ('vitality', 'dentally-write-back', false, 'migration:0096')");
    expect(MIGRATION).toContain("on conflict (client_id, module_slug) do nothing");
  });

  it("keeps the locked posture: RLS on, no anon or authenticated grants", () => {
    expect(MIGRATION).toContain("alter table dentally_write_intent enable row level security");
    expect(MIGRATION).toContain("revoke all on dentally_write_intent from anon, authenticated");
  });
});
