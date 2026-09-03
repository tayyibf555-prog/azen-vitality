import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ===========================================================================
// THE EQUIPMENT DESK'S TOOL DISPATCH.
//
// Three properties, and each has a way of failing that a looser test would miss:
//
//   1. AN UNKNOWN TOOL NAME GETS NOTHING. Not an error a model can probe, not a
//      stack trace, and not a partial result — a refusal, decided before
//      anything is parsed or read.
//   2. TENANCY IS IN THE READ, not in a check afterwards. The asset id comes
//      from the MODEL, so the only thing that makes it this practice's asset is
//      a read scoped by client_id.
//   3. A FAILED READ SAYS SO. "Nothing found" and "could not look" are different
//      facts, and only one of them may become an answer.
// ===========================================================================

const store = vi.hoisted(() => ({
  assets: [] as Record<string, unknown>[],
  assetsFail: false,
  chunks: [] as Record<string, unknown>[],
  chunksFail: false,
  /** Every (clientId, assetId) pair getAsset was called with. */
  getAssetCalls: [] as [string, string][],
}));

vi.mock("./repository", () => ({
  listAssets: async () => (store.assetsFail ? null : store.assets),
  listManuals: async () => [{ assetId: "a1", status: "ready" }],
  getAsset: async (clientId: string, id: string) => {
    store.getAssetCalls.push([clientId, id]);
    // The mock enforces the same predicate the real query does, so a repository
    // that dropped its client_id filter would surface here.
    return store.assets.find((a) => a.id === id && a.clientId === clientId) ?? null;
  },
  listChunksForAsset: async () => (store.chunksFail ? null : store.chunks),
}));

const { makeEquipmentDispatch, EQUIPMENT_TOOLS } = await import("./tools");

const dispatch = makeEquipmentDispatch({ clientId: "vitality", today: "2026-09-03" });
const parse = async (name: string, input: Record<string, unknown> = {}) =>
  JSON.parse(await dispatch(name, input)) as Record<string, unknown>;

const ASSET = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  clientId: "vitality",
  name: "SteriPro 22B",
  category: "sterilisation",
  make: "W&H",
  model: "Lisa 500",
  serial: "A1400273",
  room: "Decon room",
  siteId: "site-cc",
  supplier: "DentalTech",
  supplierPhone: "020 7000 0000",
  purchasedOn: null,
  lastServicedOn: null,
  nextServiceDue: "2027-03-02",
  notes: null,
  createdAt: "",
  updatedAt: "",
  ...over,
});

beforeEach(() => {
  store.assets = [ASSET()];
  store.assetsFail = false;
  store.chunks = [{ pageFrom: 3, pageTo: 3, ordinal: 0, body: "E04 - Door not sealed. Reseat the load and wipe the gasket." }];
  store.chunksFail = false;
  store.getAssetCalls = [];
});

describe("1. the tool set is read-only and small", () => {
  it("has exactly the four read tools, and nothing that writes or sends", () => {
    expect(EQUIPMENT_TOOLS.map((t) => t.name).sort()).toEqual([
      "find_asset",
      "list_assets",
      "search_manual",
      "service_due",
    ]);
  });

  it("no tool describes a send, a booking or a Dentally write", () => {
    const text = JSON.stringify(EQUIPMENT_TOOLS).toLowerCase();
    for (const word of ["send", "text the", "book ", "dentally", "message the patient"]) {
      expect(text).not.toContain(word);
    }
  });
});

describe("2. an unknown tool name gets a refusal, not data and not an error", () => {
  it("refuses a name the model invented", async () => {
    const result = await parse("send_sms", { to: "07700900000" });
    expect(String(result.error)).toMatch(/not available to the equipment desk/i);
  });

  it("refuses a name borrowed from another module's vocabulary", async () => {
    expect(String((await parse("patient_record", { query: "smith" })).error)).toMatch(/not available/i);
  });
});

describe("3. tenancy is enforced in the READ, on an id the model produced", () => {
  it("scopes getAsset by client, and refuses an asset from another practice", async () => {
    store.assets = [ASSET({ id: "a9", clientId: "some-other-practice" })];
    const result = await parse("search_manual", { assetId: "a9", query: "E04" });
    expect(String(result.error)).toMatch(/not on this practice's register/i);
    expect(store.getAssetCalls).toEqual([["vitality", "a9"]]);
  });

  it("refuses an empty asset id rather than searching everything", async () => {
    expect(String((await parse("search_manual", { query: "E04" })).error)).toMatch(/no asset id/i);
  });
});

describe("4. search_manual", () => {
  it("returns the matching passage with the page it came from", async () => {
    const result = (await parse("search_manual", { assetId: "a1", query: "E04" })) as {
      passages: { page: number | string; text: string }[];
    };
    expect(result.passages).toHaveLength(1);
    expect(result.passages[0].page).toBe(3);
    expect(result.passages[0].text).toMatch(/Door not sealed/);
  });

  it("says there is NO manual, and where to add one, rather than returning nothing", async () => {
    store.chunks = [];
    const result = await parse("search_manual", { assetId: "a1", query: "E04" });
    expect(result.manualUploaded).toBe(false);
    expect(String(result.note)).toMatch(/Manuals tab/);
  });

  it("tells the model NOT to answer from general knowledge when nothing matched", async () => {
    const result = await parse("search_manual", { assetId: "a1", query: "wifi password" });
    expect((result.passages as unknown[]).length).toBe(0);
    expect(String(result.note)).toMatch(/does not cover this/i);
    expect(String(result.note)).toMatch(/not answer from general knowledge/i);
  });

  it("a FAILED chunk read is reported as a failure, never as 'nothing found'", async () => {
    store.chunksFail = true;
    const result = await parse("search_manual", { assetId: "a1", query: "E04" });
    expect(String(result.error)).toMatch(/could not be read/i);
    expect(String(result.error)).toMatch(/rather than answering from memory/i);
  });
});

describe("5. service_due is honest about what it does not know", () => {
  it("splits overdue from due-soon against the day it was given", async () => {
    store.assets = [
      ASSET({ id: "a1", name: "Overdue one", nextServiceDue: "2026-01-01" }),
      ASSET({ id: "a2", name: "Due soon", nextServiceDue: "2026-10-01" }),
      ASSET({ id: "a3", name: "Far off", nextServiceDue: "2027-10-01" }),
    ];
    const result = (await parse("service_due", {})) as {
      overdue: { name: string }[];
      dueSoon: { name: string }[];
    };
    expect(result.overdue.map((a) => a.name)).toEqual(["Overdue one"]);
    expect(result.dueSoon.map((a) => a.name)).toEqual(["Due soon"]);
  });

  it("COUNTS the assets with no service date rather than leaving them out silently", async () => {
    // "Nothing is overdue" and "we do not know when four of these are due" are
    // different answers, and the practice needs the second one.
    store.assets = [ASSET({ nextServiceDue: null }), ASSET({ id: "a2", nextServiceDue: null })];
    const result = await parse("service_due", {});
    expect(result.noServiceDateRecorded).toBe(2);
    expect(result.overdue).toEqual([]);
  });

  it("carries the supplier's number, which is what an overdue answer is FOR", async () => {
    store.assets = [ASSET({ nextServiceDue: "2026-01-01" })];
    const result = (await parse("service_due", {})) as { overdue: { supplierPhone: string }[] };
    expect(result.overdue[0].supplierPhone).toBe("020 7000 0000");
  });

  it("a FAILED register read is reported as a failure", async () => {
    store.assetsFail = true;
    for (const tool of ["find_asset", "list_assets", "service_due"]) {
      const result = await parse(tool, { query: "x" });
      expect(String(result.error), tool).toMatch(/could not be read/i);
    }
  });
});

describe("6. find_asset searches the fields a person would search by", () => {
  it("finds by name, make, model, serial and room", async () => {
    for (const query of ["steripro", "W&H", "Lisa 500", "A1400273", "Decon"]) {
      const result = (await parse("find_asset", { query })) as { found: number };
      expect(result.found, query).toBe(1);
    }
  });

  it("reports the manual state on every match", async () => {
    const result = (await parse("find_asset", { query: "steripro" })) as {
      assets: { manualUploaded: boolean }[];
    };
    expect(result.assets[0].manualUploaded).toBe(true);
  });
});
