// REACTIVATION-RESYNC-INFLIGHT: a periodic Dentally re-sync re-classifies an
// already-in-flight reactivation target (mid-cadence, some attempts sent) and
// upserts it. This test proves whether that upsert overwrites the in-flight
// status/prior_attempts back to dormant/0 — which would restart the cadence and
// re-contact the patient.
//
// It models a real Postgres table in memory so the upsert(onConflict:'id')
// semantics (insert-or-replace-by-id) and update().eq() are reproduced exactly.
import { describe, it, expect, vi, beforeEach } from "vitest";

interface Row {
  id: string;
  status: string;
  prior_attempts: number | string;
  [k: string]: unknown;
}

// In-memory store keyed by id, plus a chainable builder that mimics the subset
// of the supabase client the reactivation repository uses.
const store = vi.hoisted(() => {
  const rows = new Map<string, Row>();

  function makeBuilder() {
    // Per-chain state.
    let op: "upsert" | "update" | "select" | null = null;
    let onConflict: string | null = null;
    let payload: Row[] = [];
    let updateFields: Record<string, unknown> = {};
    let eqCol: string | null = null;
    let eqVal: unknown = null;
    let inCol: string | null = null;
    let inVals: unknown[] | null = null;

    const builder: Record<string, unknown> = {};

    builder.from = () => builder;

    builder.upsert = (data: Row | Row[], opts?: { onConflict?: string }) => {
      op = "upsert";
      onConflict = opts?.onConflict ?? "id";
      payload = Array.isArray(data) ? data : [data];
      return builder;
    };

    builder.update = (fields: Record<string, unknown>) => {
      op = "update";
      updateFields = fields;
      return builder;
    };

    builder.select = () => {
      op = "select";
      return builder;
    };

    builder.eq = (col: string, val: unknown) => {
      eqCol = col;
      eqVal = val;
      return builder;
    };

    builder.in = (col: string, vals: unknown[]) => {
      inCol = col;
      inVals = vals;
      return builder;
    };

    builder.maybeSingle = () => builder;

    // Thenable: awaiting the builder commits the pending operation.
    builder.then = (resolve: (v: unknown) => unknown) => {
      if (op === "upsert") {
        // onConflict:'id' -> replace-by-id with the full incoming row.
        void onConflict;
        for (const r of payload) rows.set(r.id, { ...r });
        return resolve({ data: null, error: null });
      }
      if (op === "update") {
        if (eqCol === "id") {
          const existing = rows.get(String(eqVal));
          if (existing) rows.set(String(eqVal), { ...existing, ...updateFields });
        }
        return resolve({ data: null, error: null });
      }
      if (op === "select") {
        // .in("id", [...]) -> array of matching rows (used by upsertTargets).
        if (inCol === "id" && inVals) {
          const matched = inVals
            .map((v) => rows.get(String(v)))
            .filter((r): r is Row => r !== undefined)
            .map((r) => ({ ...r }));
          return resolve({ data: matched, error: null });
        }
        // .eq("id", ...).maybeSingle() -> single row or null (used by getTarget).
        const found = eqCol === "id" ? rows.get(String(eqVal)) : undefined;
        return resolve({ data: found ?? null, error: null });
      }
      return resolve({ data: null, error: null });
    };

    return builder;
  }

  return { rows, serviceClient: () => makeBuilder() };
});

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => store.serviceClient(),
  anonServerClient: () => store.serviceClient(),
}));

import { toReactivationTarget, type ReactivationInput } from "./normalise";
import {
  upsertTargets,
  setTargetStatus,
  incrementPriorAttempts,
  getTarget,
} from "./repository";

const NOW = new Date("2026-07-01T09:00:00.000Z");

// A lapsed patient with a long-past last visit -> classifies as a target.
function lapsedInput(): ReactivationInput {
  return {
    siteId: "site-1",
    patient: {
      id: "P100",
      first_name: "Jane",
      last_name: "Doe",
      use_sms: true,
      use_email: true,
      marketing: true,
    },
    lastVisitAt: "2025-08-15T00:00:00.000Z", // lapsed: > 9 months before NOW, within the 1-year cap
    futureBookingExists: false,
    plan: null,
    amountOutstanding: 0,
    historicSpend: 400,
    lastTouchAt: null,
  };
}

beforeEach(() => {
  store.rows.clear();
});

describe("reactivation re-sync of an in-flight target", () => {
  it("must NOT reset an enrolled, mid-cadence target back to dormant/0", async () => {
    // 1. First classification: fresh target, dormant, 0 attempts.
    const first = toReactivationTarget(lapsedInput(), NOW)!;
    expect(first.status).toBe("dormant");
    expect(first.priorAttempts).toBe(0);
    await upsertTargets([first]);

    // 2. The real flow enrols the patient and sends touches: status -> in_cadence,
    //    prior_attempts is incremented as messages go out (see
    //    /api/reactivation/[action] enrol + send, and the sweep).
    await setTargetStatus(first.id, "in_cadence");
    await incrementPriorAttempts(first.id);
    await incrementPriorAttempts(first.id);

    const midFlight = await getTarget(first.id);
    expect(midFlight?.status).toBe("in_cadence");
    expect(midFlight?.priorAttempts).toBe(2);

    // 3. A later periodic sync re-pulls this patient (their Dentally record was
    //    touched, so incremental sync returns them) and re-classifies. The fresh
    //    target again carries status='dormant', prior_attempts=0.
    const reclassified = toReactivationTarget(lapsedInput(), NOW)!;
    expect(reclassified.status).toBe("dormant");
    expect(reclassified.priorAttempts).toBe(0);
    await upsertTargets([reclassified]);

    // 4. Assert the in-flight state survived the re-sync. Without a fix the row
    //    is now dormant/0, which restarts the cadence and re-contacts the patient.
    const after = await getTarget(first.id);
    expect(after?.status, "in-flight status must be preserved across re-sync").toBe("in_cadence");
    expect(after?.priorAttempts, "prior_attempts must be preserved across re-sync").toBe(2);
  });

  it("still inserts a genuinely-new target as dormant/0 (fix is insert-only, not a blanket freeze)", async () => {
    const fresh = toReactivationTarget(lapsedInput(), NOW)!;
    await upsertTargets([fresh]);
    const stored = await getTarget(fresh.id);
    expect(stored?.status).toBe("dormant");
    expect(stored?.priorAttempts).toBe(0);
  });

  it("refreshes Dentally-owned facts on re-sync while preserving cadence progress", async () => {
    const first = toReactivationTarget(lapsedInput(), NOW)!;
    await upsertTargets([first]);
    await setTargetStatus(first.id, "in_cadence");
    await incrementPriorAttempts(first.id);

    // Patient's name changed in Dentally; re-sync must still refresh it.
    const renamed = { ...lapsedInput(), patient: { ...lapsedInput().patient, last_name: "Smith" } };
    const reclassified = toReactivationTarget(renamed, NOW)!;
    await upsertTargets([reclassified]);

    const after = await getTarget(first.id);
    expect(after?.patientName).toBe("Jane Smith");   // fresh fact refreshed
    expect(after?.status).toBe("in_cadence");         // cadence progress kept
    expect(after?.priorAttempts).toBe(1);
  });
});
