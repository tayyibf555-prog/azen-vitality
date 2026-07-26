// The practice-set maximum lapse. The one year cap is gone (every lapsed patient is
// reachable), so this is the knob that lets the practice put an outer edge back on
// without a code change. Absence of a value means UNLIMITED, deliberately: the thing
// that bounds how many patients are actually contacted is the daily contact limit,
// the per-run enrolment ceiling and the kill switch, not this.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const store = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  error: null as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (store.error) throw store.error;
            return { data: store.row, error: null };
          },
        }),
      }),
    }),
  }),
}));

import { getMaxLapseMonths } from "./settings";
import { UNLIMITED_MAX_LAPSE_MONTHS } from "./normalise";

beforeEach(() => {
  store.row = null;
  store.error = null;
});
afterEach(() => vi.unstubAllEnvs());

describe("getMaxLapseMonths", () => {
  it("is unlimited when the practice has set nothing", async () => {
    expect(await getMaxLapseMonths("vitality")).toBe(UNLIMITED_MAX_LAPSE_MONTHS);
    store.row = { client_id: "vitality", daily_contact_limit: 25 };
    expect(await getMaxLapseMonths("vitality")).toBe(UNLIMITED_MAX_LAPSE_MONTHS);
    store.row = { client_id: "vitality", max_lapse_months: null };
    expect(await getMaxLapseMonths("vitality")).toBe(UNLIMITED_MAX_LAPSE_MONTHS);
  });

  it("returns the outer edge the practice has set", async () => {
    store.row = { client_id: "vitality", max_lapse_months: 24 };
    expect(await getMaxLapseMonths("vitality")).toBe(24);
  });

  it("accepts a numeric string, since Postgres numerics arrive as strings", async () => {
    store.row = { client_id: "vitality", max_lapse_months: "36" };
    expect(await getMaxLapseMonths("vitality")).toBe(36);
  });

  it("ignores a nonsense stored value rather than trusting NaN or zero", async () => {
    for (const bad of [0, -6, "soon", {}]) {
      store.row = { client_id: "vitality", max_lapse_months: bad };
      expect(await getMaxLapseMonths("vitality")).toBe(UNLIMITED_MAX_LAPSE_MONTHS);
    }
  });

  it("falls back to the deployment-wide env ceiling when the table has no value", async () => {
    vi.stubEnv("REACTIVATION_MAX_LAPSE_MONTHS", "18");
    expect(await getMaxLapseMonths("vitality")).toBe(18);
    // The practice's own setting wins over the deployment default.
    store.row = { client_id: "vitality", max_lapse_months: 30 };
    expect(await getMaxLapseMonths("vitality")).toBe(30);
  });

  it("degrades to the default when the column does not exist yet or the read fails", async () => {
    // Before the migration lands there is simply no value to read; the module must
    // keep working rather than throwing inside a cron sweep.
    store.error = new Error("column reactivation_settings.max_lapse_months does not exist");
    expect(await getMaxLapseMonths("vitality")).toBe(UNLIMITED_MAX_LAPSE_MONTHS);
    vi.stubEnv("REACTIVATION_MAX_LAPSE_MONTHS", "12");
    expect(await getMaxLapseMonths("vitality")).toBe(12);
  });
});
