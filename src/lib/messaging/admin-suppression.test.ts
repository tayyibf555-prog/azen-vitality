// Admin "Do not contact" suppression helpers (patient status feature).
//
// addAdminDoNotContact must:
//   - add a row on EVERY channel (sms, email, whatsapp) with reason admin_do_not_contact,
//   - NEVER clobber an existing 'stop' row (ignoreDuplicates), so a patient's own opt-out
//     is preserved.
// clearAdminDoNotContact must delete ONLY admin_do_not_contact rows, never a 'stop' row.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { addAdminDoNotContact, clearAdminDoNotContact, ADMIN_DNC_REASON } from "./suppression";

interface Row {
  site_id: string;
  channel: string;
  to_ref: string;
  reason: string;
}

const store = { rows: [] as Row[] };

// Minimal supabase query-builder fake for message_suppression: supports the array
// upsert(..., { onConflict, ignoreDuplicates }) that addAdminDoNotContact uses and the
// delete().eq().eq().eq() chain that clearAdminDoNotContact uses.
vi.mock("@/lib/supabase/server", () => {
  function from(table: string) {
    if (table !== "message_suppression") throw new Error(`unexpected table: ${table}`);
    let mode: "delete" | null = null;
    const eqs: Array<{ col: keyof Row; val: string }> = [];
    const builder = {
      upsert(rows: Row | Row[], opts: { onConflict: string; ignoreDuplicates?: boolean }) {
        const list = Array.isArray(rows) ? rows : [rows];
        for (const row of list) {
          const idx = store.rows.findIndex(
            (r) => r.site_id === row.site_id && r.channel === row.channel && r.to_ref === row.to_ref,
          );
          if (idx >= 0) {
            // ignoreDuplicates => INSERT ... ON CONFLICT DO NOTHING: leave the existing row.
            if (!opts.ignoreDuplicates) store.rows[idx] = row;
          } else {
            store.rows.push(row);
          }
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
      // delete().eq()...eq() is awaited; resolve by applying the pending delete.
      then(resolve: (v: { error: null }) => void) {
        if (mode === "delete") {
          store.rows = store.rows.filter((r) => !eqs.every((e) => r[e.col] === e.val));
        }
        resolve({ error: null });
      },
    };
    return builder;
  }
  return { serviceClient: () => ({ from }) };
});

beforeEach(() => {
  store.rows = [];
});

describe("addAdminDoNotContact", () => {
  it("adds an admin_do_not_contact row on sms, email AND whatsapp for the patient ref", async () => {
    await addAdminDoNotContact("site-cc", "patient:p1");
    const channels = store.rows.filter((r) => r.to_ref === "patient:p1").map((r) => r.channel).sort();
    expect(channels).toEqual(["email", "sms", "whatsapp"]);
    expect(store.rows.every((r) => r.reason === ADMIN_DNC_REASON)).toBe(true);
  });

  it("preserves an existing STOP row - never overwrites a patient's own opt-out", async () => {
    // Patient already texted STOP on sms.
    store.rows.push({ site_id: "site-cc", channel: "sms", to_ref: "patient:p1", reason: "stop" });
    await addAdminDoNotContact("site-cc", "patient:p1");
    const sms = store.rows.find((r) => r.channel === "sms" && r.to_ref === "patient:p1");
    expect(sms?.reason).toBe("stop"); // untouched
    // email + whatsapp were added as admin rows.
    expect(store.rows.filter((r) => r.reason === ADMIN_DNC_REASON).map((r) => r.channel).sort()).toEqual([
      "email",
      "whatsapp",
    ]);
  });
});

describe("clearAdminDoNotContact", () => {
  it("removes ONLY admin rows and leaves a genuine STOP row in place", async () => {
    store.rows = [
      { site_id: "site-cc", channel: "sms", to_ref: "patient:p1", reason: "stop" },
      { site_id: "site-cc", channel: "email", to_ref: "patient:p1", reason: ADMIN_DNC_REASON },
      { site_id: "site-cc", channel: "whatsapp", to_ref: "patient:p1", reason: ADMIN_DNC_REASON },
    ];
    await clearAdminDoNotContact("site-cc", "patient:p1");
    // The STOP row survives; both admin rows are gone.
    expect(store.rows).toEqual([
      { site_id: "site-cc", channel: "sms", to_ref: "patient:p1", reason: "stop" },
    ]);
  });

  it("does not touch another patient's admin rows", async () => {
    store.rows = [
      { site_id: "site-cc", channel: "sms", to_ref: "patient:p1", reason: ADMIN_DNC_REASON },
      { site_id: "site-cc", channel: "sms", to_ref: "patient:p2", reason: ADMIN_DNC_REASON },
    ];
    await clearAdminDoNotContact("site-cc", "patient:p1");
    expect(store.rows).toEqual([
      { site_id: "site-cc", channel: "sms", to_ref: "patient:p2", reason: ADMIN_DNC_REASON },
    ]);
  });
});
