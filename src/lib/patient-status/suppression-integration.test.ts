// INTEGRATION: applyStatusChange -> the REAL suppression machinery -> the REAL
// isSuppressed the send/drain path uses. Only the supabase serviceClient (in-memory
// store), the override/audit repository, and the Dentally write gate are doubled.
//
// Proves the owner-confirmed patient-initiated-flow semantics:
//   - INACTIVE creates NO suppression rows, so a patient's own first-contact / booking
//     confirmation is NOT blocked (only targeting is excluded, tested separately).
//   - DO_NOT_CONTACT blocks EVERY channel at the send choke point.
//   - Clearing back to active removes ONLY the admin rows; a genuine STOP survives.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

interface Row {
  site_id: string;
  channel: string;
  to_ref: string;
  reason: string;
}
const store = { rows: [] as Row[] };

// In-memory message_suppression backing the REAL addAdminDoNotContact /
// clearAdminDoNotContact / isSuppressed. Supports the exact chains those use.
vi.mock("@/lib/supabase/server", () => {
  function from(table: string) {
    if (table !== "message_suppression") throw new Error(`unexpected table: ${table}`);
    let mode: "delete" | "select" | null = null;
    const eqs: Array<{ col: keyof Row; val: string }> = [];
    const builder = {
      select() {
        mode = "select";
        return builder;
      },
      upsert(rows: Row | Row[], opts: { onConflict: string; ignoreDuplicates?: boolean }) {
        for (const row of Array.isArray(rows) ? rows : [rows]) {
          const idx = store.rows.findIndex(
            (r) => r.site_id === row.site_id && r.channel === row.channel && r.to_ref === row.to_ref,
          );
          if (idx >= 0) {
            if (!opts.ignoreDuplicates) store.rows[idx] = row;
          } else store.rows.push(row);
        }
        return { error: null };
      },
      delete() {
        mode = "delete";
        return builder;
      },
      eq(col: keyof Row, val: string) {
        eqs.push({ col, val });
        return builder;
      },
      async maybeSingle() {
        const found = store.rows.find((r) => eqs.every((e) => r[e.col] === e.val));
        return { data: found ? { id: "x" } : null, error: null };
      },
      then(resolve: (v: { error: null }) => void) {
        if (mode === "delete") store.rows = store.rows.filter((r) => !eqs.every((e) => r[e.col] === e.val));
        resolve({ error: null });
      },
    };
    return builder;
  }
  return { serviceClient: () => ({ from }) };
});

// Override/audit persistence is not under test here.
vi.mock("./repository", () => ({
  getOverride: vi.fn(async () => null),
  upsertOverride: vi.fn(async () => {}),
  markOverrideSynced: vi.fn(async () => {}),
  insertAudit: vi.fn(async () => {}),
}));
// Writes disabled: the Dentally path is 'skipped'/'unsupported', never touched.
// The WriteGate consults the OWNER's master Dentally write-back switch, and then
// the switch on the module that is writing. Both readers are stubbed ON here:
// this file's subject is what its own module does with the answer, and the
// switches have their own tests in src/lib/systems/repository.test.ts and
// src/lib/dentally/write-gate.test.ts.
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledStrict: async () => true,
  isSystemExplicitlyDisabled: async () => false,
}));

vi.mock("@/lib/dentally/write", () => ({
  // Added when the WriteGate landed. The gate resolves the target host through
  // the same predicate the client factory uses, so a partial mock of this module
  // has to carry it — and `true` is the posture these tests are ABOUT: a
  // production deployment whose base URL is the live practice book. That is
  // exactly when "writes are off" has to mean nothing happens at all, rather
  // than a write landing in a local mock.
  targetsRealDentally: () => true,
  isDentallyWriteEnabled: () => false,
  dentallyAgentClient: () => ({ updatePatient: vi.fn() }),
}));

import { applyStatusChange } from "./service";
import { isSuppressed } from "@/lib/messaging/suppression";

beforeEach(() => {
  store.rows = [];
});

describe("patient-initiated flows stay open (inactive)", () => {
  it("INACTIVE creates NO suppression rows, so first-contact / booking confirmation is NOT blocked", async () => {
    await applyStatusChange({ siteId: "site-cc", patientId: "p1", status: "inactive" });
    expect(store.rows).toEqual([]);
    expect(await isSuppressed("site-cc", "sms", "patient:p1")).toBe(false);
    expect(await isSuppressed("site-cc", "email", "patient:p1")).toBe(false);
  });
});

describe("do_not_contact blocks every channel", () => {
  it("suppresses sms, email AND whatsapp at the send choke point", async () => {
    await applyStatusChange({ siteId: "site-cc", patientId: "p1", status: "do_not_contact" });
    expect(await isSuppressed("site-cc", "sms", "patient:p1")).toBe(true);
    expect(await isSuppressed("site-cc", "email", "patient:p1")).toBe(true);
    expect(await isSuppressed("site-cc", "whatsapp", "patient:p1")).toBe(true);
  });
});

describe("clearing do_not_contact preserves a genuine STOP", () => {
  it("removes admin rows but leaves the patient's own STOP row suppressing", async () => {
    // Patient texted STOP on sms first.
    store.rows.push({ site_id: "site-cc", channel: "sms", to_ref: "patient:p1", reason: "stop" });
    await applyStatusChange({ siteId: "site-cc", patientId: "p1", status: "do_not_contact" });
    // Now lift the admin status back to active.
    await applyStatusChange({ siteId: "site-cc", patientId: "p1", status: "active" });
    // Admin rows are gone: email/whatsapp no longer suppressed.
    expect(await isSuppressed("site-cc", "email", "patient:p1")).toBe(false);
    // But the genuine STOP survives on sms.
    expect(await isSuppressed("site-cc", "sms", "patient:p1")).toBe(true);
  });
});
