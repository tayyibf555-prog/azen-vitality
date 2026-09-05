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
  /** TRUE makes `listManuals` return null — the read FAILED, which is not "no manuals". */
  manualsFail: false,
  /** Every (clientId, assetId) pair getAsset was called with. */
  getAssetCalls: [] as [string, string][],
}));

vi.mock("./repository", () => ({
  listAssets: async () => (store.assetsFail ? null : store.assets),
  listManuals: async () => (store.manualsFail ? null : [{ assetId: "a1", status: "ready" }]),
  getAsset: async (clientId: string, id: string) => {
    store.getAssetCalls.push([clientId, id]);
    // The mock enforces the same predicate the real query does, so a repository
    // that dropped its client_id filter would surface here.
    return store.assets.find((a) => a.id === id && a.clientId === clientId) ?? null;
  },
  listChunksForAsset: async () => (store.chunksFail ? null : store.chunks),
}));

import { readFileSync } from "node:fs";
import { MANUAL_CHUNK_READ_CAP, REGISTER_READ_CAP } from "./types";

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
  store.manualsFail = false;
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

// ---------------------------------------------------------------------------
// 4b. A CAPPED MANUAL READ NEVER SAYS "THE MANUAL DOES NOT COVER THIS".
//
// `listChunksForAsset` stops at MANUAL_CHUNK_READ_CAP passages, in page order,
// and hands back a bare array — so on a long manual the ranking never saw the
// back of the book. The ordinary empty-result note tells the model to say,
// plainly, that the practice's own manual does not cover the thing asked about,
// which is only true when the whole manual was searched. "The manual does not
// cover E27" about a fault table on page 361 is not a hedge; it is a false
// statement about a document the practice uploaded, and it sends a nurse away
// from the answer she is holding (W3/11, charter §0/5).
//
// The old cap was 1,200 — ABOVE PostgREST's 1,000-row ceiling — so the read
// could never come back at its own bound and `capped` was structurally false.
// The arithmetic pin below is what stops that being reintroduced.
// ---------------------------------------------------------------------------
describe("4b. a manual read at its own bound is reported as partial, not as absence", () => {
  const chunkFill = (n: number, body: string) =>
    new Array(n).fill(0).map((_, i) => ({ pageFrom: i + 1, pageTo: i + 1, ordinal: i, body }));

  it("swaps 'does not cover this' for the sentence that says which part was searched", async () => {
    store.chunks = chunkFill(MANUAL_CHUNK_READ_CAP, "Daily operation. Load the chamber and close the door.");
    const result = await parse("search_manual", { assetId: "a1", query: "E27" });
    expect((result.passages as unknown[]).length).toBe(0);
    // The false sentence must be GONE, not merely accompanied.
    expect(String(result.note)).not.toMatch(/does not cover this/i);
    expect(String(result.note)).toMatch(/only its first 900 passages were searched/i);
    expect(String(result.note)).toMatch(/Never say the manual does not cover something/i);
    expect(result.searchedFirstPassages).toBe(MANUAL_CHUNK_READ_CAP);
  });

  it("says so even when something DID rank, because the best passage may be past the bound", async () => {
    const chunks = chunkFill(MANUAL_CHUNK_READ_CAP - 1, "Daily operation.");
    chunks.push({ pageFrom: 900, pageTo: 900, ordinal: 899, body: "E04 - Door not sealed." });
    store.chunks = chunks;
    const result = await parse("search_manual", { assetId: "a1", query: "E04" });
    expect((result.passages as unknown[]).length).toBe(1);
    expect(String(result.note)).toMatch(/only its first 900 passages were searched/i);
  });

  it("a manual BELOW the bound keeps the plain sentence, with no caveat", async () => {
    // The other direction, which is what stops this being "fixed" by hedging
    // every answer: a short manual really was searched to the end, and "the
    // manual does not cover this" is then a fact worth saying.
    store.chunks = chunkFill(MANUAL_CHUNK_READ_CAP - 1, "Daily operation.");
    const result = await parse("search_manual", { assetId: "a1", query: "E27" });
    expect(String(result.note)).toMatch(/does not cover this/i);
    expect(result.searchedFirstPassages).toBeUndefined();
  });

  it("the manual bound is the REPOSITORY's bound, read out of its source", () => {
    // Two literals, for the reason types.ts states: `tools.ts` may not import a
    // `server-only` module, and this file mocks `./repository` wholesale — so an
    // import of the cap from there would resolve to `undefined` and every
    // assertion above would pass on a desk that had quietly stopped hedging.
    const source = readFileSync("src/lib/equipment/repository.ts", "utf8").match(
      /CHUNK_ROW_CAP\s*=\s*([\d_]+)/,
    );
    expect(source, "the CHUNK_ROW_CAP scan went stale").toBeTruthy();
    expect(MANUAL_CHUNK_READ_CAP, "types.ts drifted from the repository's chunk cap").toBe(
      Number(source![1].replace(/_/g, "")),
    );
  });

  it("every equipment read cap sits BELOW PostgREST's own row ceiling", () => {
    // ARITHMETIC, because no behavioural test can catch this: the doubles in
    // this suite honour `.limit(n)` literally, so a cap above the ceiling
    // behaves exactly like one below it in every test while being unreachable
    // in production. Supabase applies a server-side max-rows ceiling to every
    // REST request, measured at 1,000 on this project with the service-role key
    // (limit=1500 and limit=2001 both returned exactly 1,000 rows,
    // `content-range: 0-999/*`, no error) — see src/lib/dentally/sync-ledger.ts,
    // where the same measurement forced COUNT_CAP from 2,000 to 900.
    //
    // A cap ABOVE it can never be observed: `rows.length >= CAP` is structurally
    // false, so the read comes back clipped, silently, wearing a whole read's
    // clothes. CHUNK_ROW_CAP was 1,200 and SERIAL_INDEX_CAP was 5,000.
    const POSTGREST_MAX_ROWS = 1000;
    const source = readFileSync("src/lib/equipment/repository.ts", "utf8");
    const caps = [...source.matchAll(/\.limit\((\w+)\)/g)].map((m) => m[1]);
    expect(caps.length, "the .limit() scan went stale").toBeGreaterThan(0);
    for (const name of new Set(caps)) {
      const declared = source.match(new RegExp(`${name}\\s*=\\s*([\\d_]+)`));
      expect(declared, `${name} is not a literal this scan can read`).toBeTruthy();
      expect(
        Number(declared![1].replace(/_/g, "")),
        `${name} is above PostgREST's row ceiling, so its bound can never be observed`,
      ).toBeLessThanOrEqual(POSTGREST_MAX_ROWS);
    }
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

// ---------------------------------------------------------------------------
// 7. THE REGISTER READ IS BOUNDED, AND THE TOOL RESULTS SAY SO AT THE BOUND.
//
// `listAssets` stops at REGISTER_READ_CAP rows and hands back a bare array, so
// a count taken off it is a FLOOR the moment the read is at its own bound
// (programme ruling W3/11). Left alone the model reads `total: 400`, repeats it
// to the practice as a total, and answers "we have no such machine" about
// everything in the unread tail — and because the read is ordered by category
// then name, the tail is whole trailing categories, not a random scattering.
// ---------------------------------------------------------------------------
describe("7. a capped register read is reported as a floor, never as a total", () => {
  const fill = (n: number, over: Record<string, unknown> = {}) =>
    new Array(n).fill(0).map((_, i) => ASSET({ id: `a${i}`, ...over }));

  it("list_assets swaps `total` for `atLeast` and carries the caveat", async () => {
    store.assets = fill(REGISTER_READ_CAP);
    const capped = await parse("list_assets", {});
    expect(capped.atLeast).toBe(REGISTER_READ_CAP);
    // The key CHANGES rather than gaining a sibling flag: a model that ignores
    // an unfamiliar `truncated: true` still prints whatever `total` says, so
    // there must be no `total` left for it to print.
    expect(capped.total).toBeUndefined();
    expect(String(capped.note)).toMatch(/larger than this desk reads in one go/i);
    expect(String(capped.note)).toMatch(/never tell anyone a machine is not registered/i);
  });

  it("list_assets BELOW the bound still gives a real total, with no caveat", async () => {
    store.assets = fill(REGISTER_READ_CAP - 1);
    const under = await parse("list_assets", {});
    expect(under.total).toBe(REGISTER_READ_CAP - 1);
    expect(under.atLeast).toBeUndefined();
    expect(under.note).toBeUndefined();
  });

  it("find_asset's match count is a floor too, and says which of its matches it returned", async () => {
    store.assets = fill(REGISTER_READ_CAP, { name: "Handpiece" });
    const result = await parse("find_asset", { query: "handpiece" });
    expect(result.found).toBeUndefined();
    expect(result.foundAtLeast).toBe(REGISTER_READ_CAP);
    // 25 is the slice this tool returns; a bare `found: 400` beside 25 rows is
    // the same lie in miniature.
    expect(result.showing).toBe(25);
    expect((result.assets as unknown[]).length).toBe(25);
    expect(String(result.note)).toMatch(/floor and not a total/i);
  });

  it("service_due says an EMPTY overdue list is not proof nothing is overdue", async () => {
    // The question W1-D/2 says is ALWAYS answered. When the read was capped, an
    // empty `overdue` means "nothing overdue in the part I can see" — and the
    // difference is a statutory test nobody is told about.
    store.assets = fill(REGISTER_READ_CAP, { nextServiceDue: "2999-01-01" });
    const capped = await parse("service_due", {});
    expect(capped.overdue).toEqual([]);
    expect(capped.registerCapped).toBe(true);
    expect(String(capped.note)).toMatch(/nothing overdue in the part of the register I can read/i);

    store.assets = fill(REGISTER_READ_CAP - 1, { nextServiceDue: "2999-01-01" });
    const under = await parse("service_due", {});
    expect(under.registerCapped).toBeUndefined();
    expect(under.note).toBeUndefined();
  });

  it("no tool result carries a bare figure once the read is at the bound", async () => {
    // The rule stated once, over every tool that counts: at the cap there is no
    // key called `total` or `found` anywhere, in any of them.
    store.assets = fill(REGISTER_READ_CAP);
    for (const tool of ["list_assets", "find_asset", "service_due"]) {
      const result = await parse(tool, { query: "steripro" });
      expect(result.total, tool).toBeUndefined();
      expect(result.found, tool).toBeUndefined();
      expect(String(result.note), tool).toMatch(/at least/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. AN UNREADABLE MANUAL INDEX IS UNKNOWN, NEVER "NO MANUAL".
//
// `listManuals` returns null when its read fails, distinct from the empty array
// on purpose, and this dispatch used to collapse the two with `?? []`. That is
// not a missing caveat — it is a false statement about every asset at once
// (`manualUploaded: false` on all of them), from which the model tells a nurse
// there is no manual for the autoclave and invites her to upload one the
// platform already holds.
//
// AND THE TURN CONTRADICTS ITSELF. `search_manual` reads the chunk table
// directly and is untouched by this failure, so the same conversation can quote
// page 3 of the manual it has just said does not exist.
// ---------------------------------------------------------------------------
describe("8. a failed manual read is reported as unknown, never as 'no manual'", () => {
  it("find_asset OMITS manualUploaded rather than stamping false on every match", async () => {
    store.manualsFail = true;
    const result = (await parse("find_asset", { query: "steripro" })) as {
      assets: Record<string, unknown>[];
      note?: string;
    };
    expect(result.assets).toHaveLength(1);
    // The key is ABSENT, not false: `false` is an answer, absence is a question.
    expect("manualUploaded" in result.assets[0]).toBe(false);
    expect(String(result.note)).toMatch(/Whether each machine has a manual could not be read just now/i);
    expect(String(result.note)).toMatch(/never tell anyone a machine has no manual/i);
    // The next step, not just the hedge: the tool that still works is named.
    expect(String(result.note)).toContain("search_manual");
  });

  it("list_assets omits it too, and the register's own facts still come through", async () => {
    store.manualsFail = true;
    const result = (await parse("list_assets", {})) as {
      total: number;
      assets: Record<string, unknown>[];
      note?: string;
    };
    expect(result.total).toBe(1);
    expect("manualUploaded" in result.assets[0]).toBe(false);
    expect(result.assets[0].name).toBe("SteriPro 22B");
    expect(result.assets[0].supplierPhone).toBe("020 7000 0000");
    expect(String(result.note)).toMatch(/could not be read just now/i);
  });

  it("search_manual still answers from the chunks, so the two halves of one turn cannot contradict each other", async () => {
    // THE PROPERTY THE OMISSION EXISTS FOR. The manual index is unreadable and
    // the manual itself is not: the desk must not have said "no manual" a
    // moment before quoting page 3 of it.
    store.manualsFail = true;
    const result = (await parse("search_manual", { assetId: "a1", query: "E04" })) as {
      manualUploaded: boolean;
      passages: { page: number }[];
    };
    expect(result.manualUploaded).toBe(true);
    expect(result.passages[0].page).toBe(3);
  });

  it("a READABLE index still reports manualUploaded, so the fix bought nothing with silence", async () => {
    // The other direction. `manualUploaded: false` on a readable index is a
    // fact the practice needs — the fix must not have dropped the column for
    // everybody.
    store.assets = [ASSET(), ASSET({ id: "a2", name: "Durr Tyscor" })];
    const result = (await parse("list_assets", {})) as {
      assets: { id: string; manualUploaded: boolean }[];
      note?: string;
    };
    expect(result.assets.find((a) => a.id === "a1")?.manualUploaded).toBe(true);
    expect(result.assets.find((a) => a.id === "a2")?.manualUploaded).toBe(false);
    expect(result.note).toBeUndefined();
  });

  it("a capped register read AND a failed manual read carry BOTH sentences, in one note", async () => {
    // Two caveats, one key. A second key beside `note` is a key a model may
    // never read, and losing either sentence loses a different true thing.
    store.assets = new Array(REGISTER_READ_CAP).fill(0).map((_, i) => ASSET({ id: `a${i}` }));
    store.manualsFail = true;
    const result = (await parse("list_assets", {})) as { atLeast: number; note?: string };
    expect(result.atLeast).toBe(REGISTER_READ_CAP);
    expect(String(result.note)).toMatch(/larger than this desk reads in one go/i);
    expect(String(result.note)).toMatch(/Whether each machine has a manual could not be read just now/i);
  });
});
