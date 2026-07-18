import { describe, it, expect, vi, beforeEach } from "vitest";

// Number-health read-back over the phone_lookup cache.
//
// Proves:
//   - classifyNumberHealth maps a verdict to the right chip state (mobile / undeliverable
//     / unchecked / none), and shows the line type on an undeliverable landline.
//   - the batch loader normalises with the SAME toE164 the send path uses, so a raw
//     07... query matches a +447... cache key, and the ONE query it issues receives the
//     deduped, normalised E.164 list (never raw or per-row).
//   - a read failure fails soft to an empty map (every number then reads "unchecked").

interface Row {
  phone: string;
  valid: boolean;
  line_type: string | null;
}

const store = vi.hoisted(() => ({
  rows: [] as Row[],
  reads: 0,
  lastIn: null as string[] | null,
  failNext: false,
}));

vi.mock("@/lib/supabase/server", () => {
  function from(table: string) {
    if (table !== "phone_lookup") throw new Error(`unexpected table: ${table}`);
    let inList: string[] = [];
    const builder = {
      select() {
        return builder;
      },
      in(_col: string, vals: string[]) {
        inList = vals;
        return builder;
      },
      then(resolve: (v: { data: Row[] | null; error: unknown }) => unknown) {
        store.reads += 1;
        store.lastIn = inList;
        if (store.failNext) return resolve({ data: null, error: new Error("boom") });
        const data = store.rows.filter((r) => inList.includes(r.phone));
        return resolve({ data, error: null });
      },
    };
    return builder;
  }
  return { serviceClient: () => ({ from }) };
});

import {
  classifyNumberHealth,
  loadPhoneVerdicts,
  loadNumberHealthByPatient,
  numberHealthFor,
} from "./number-health";

beforeEach(() => {
  store.rows.length = 0;
  store.reads = 0;
  store.lastIn = null;
  store.failNext = false;
});

describe("classifyNumberHealth", () => {
  it("valid mobile verdict -> mobile", () => {
    expect(classifyNumberHealth("07700900123", { valid: true, lineType: "mobile" })).toEqual({
      state: "mobile",
      lineType: "mobile",
    });
  });

  it("invalid landline verdict -> undeliverable, carrying the line type", () => {
    expect(classifyNumberHealth("07700900123", { valid: false, lineType: "landline" })).toEqual({
      state: "undeliverable",
      lineType: "landline",
    });
  });

  it("a usable number with no verdict row -> unchecked", () => {
    expect(classifyNumberHealth("07700900123", null)).toEqual({ state: "unchecked", lineType: null });
  });

  it("an absent or unnormalisable number -> none (short-circuits, no verdict considered)", () => {
    expect(classifyNumberHealth(null, null)).toEqual({ state: "none", lineType: null });
    expect(classifyNumberHealth("not a number", { valid: true, lineType: "mobile" })).toEqual({
      state: "none",
      lineType: null,
    });
  });
});

describe("loadPhoneVerdicts", () => {
  it("normalises a raw 07... to the +447... cache key so the hit matches", async () => {
    store.rows.push({ phone: "+447700900123", valid: true, line_type: "mobile" });
    const map = await loadPhoneVerdicts(["07700 900123"]);
    expect(store.lastIn).toEqual(["+447700900123"]); // the query saw the normalised form
    expect(map.get("+447700900123")).toEqual({ valid: true, lineType: "mobile" });
  });

  it("issues ONE query with a deduped E.164 list (two raw formats of one number collapse)", async () => {
    await loadPhoneVerdicts(["07700 900123", "+44 7700 900123", "0161 496 0000"]);
    expect(store.reads).toBe(1);
    expect(store.lastIn).toEqual(["+447700900123", "+441614960000"]);
  });

  it("skips the query entirely when no number normalises", async () => {
    const map = await loadPhoneVerdicts([null, "", "junk"]);
    expect(store.reads).toBe(0);
    expect(map.size).toBe(0);
  });

  it("fails soft to an empty map on a read error", async () => {
    store.failNext = true;
    const map = await loadPhoneVerdicts(["07700900123"]);
    expect(map.size).toBe(0);
  });
});

describe("loadNumberHealthByPatient", () => {
  it("keys health by patient id, matching each patient's normalised number to the cache", async () => {
    store.rows.push({ phone: "+447700900123", valid: true, line_type: "mobile" });
    store.rows.push({ phone: "+441614960000", valid: false, line_type: "landline" });
    const health = await loadNumberHealthByPatient([
      { id: "p-mobile", phone: "07700 900123" },
      { id: "p-landline", phone: "0161 496 0000" },
      { id: "p-unchecked", phone: "07999 111222" },
      { id: "p-none", phone: null },
    ]);
    expect(store.reads).toBe(1); // one batch query for all four
    expect(health["p-mobile"]).toEqual({ state: "mobile", lineType: "mobile" });
    expect(health["p-landline"]).toEqual({ state: "undeliverable", lineType: "landline" });
    expect(health["p-unchecked"]).toEqual({ state: "unchecked", lineType: null });
    expect(health["p-none"]).toEqual({ state: "none", lineType: null });
  });
});

describe("numberHealthFor", () => {
  it("resolves a single number's health from the cache", async () => {
    store.rows.push({ phone: "+447700900123", valid: true, line_type: "voip" });
    expect(await numberHealthFor("07700 900123")).toEqual({ state: "mobile", lineType: "voip" });
  });

  it("returns none without querying when the number is absent", async () => {
    expect(await numberHealthFor(null)).toEqual({ state: "none", lineType: null });
    expect(store.reads).toBe(0);
  });
});
