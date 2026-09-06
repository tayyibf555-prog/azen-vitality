import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ===========================================================================
// REPLACING A MANUAL MUST NEVER DESTROY THE ONE THAT IS ALREADY STORED.
//
// `replaceManual` is three separate PostgREST calls with no transaction around
// them, and it used to open with a DELETE of the asset's existing manual —
// which takes every one of its passages with it through 0098's cascade — before
// writing anything. So any failure after that first call (the chunk insert
// rejected on a ~1 MB body, a statement timeout, a dropped connection) returned
// `{ok:false, reason:"We could not store that manual. Please try again."}`, a
// sentence the route renders verbatim as a 500 and which says that nothing
// changed, while the practice's previously ingested, searchable manual was gone
// for good: the PDF's bytes are never stored (0098's copyright note), so the
// extracted text was the only copy the platform held. The register then said
// "No manual uploaded" about a machine the desk had been answering from minutes
// earlier, and no read in the module can tell that state from a machine that
// never had a manual at all.
//
// WHY A DATABASE DOUBLE RATHER THAN SPIES ON THE CALLS. The defect is not which
// statements were issued, it is what is left in the two tables when one of them
// fails, so the double holds rows, applies the filters to them, and implements
// the ONE piece of schema behaviour that makes the loss visible: deleting an
// `equipment_manual` row deletes its `equipment_manual_chunk` rows, because 0098
// declares `manual_id ... on delete cascade`. A double without that cascade
// agrees with the bug — the header row vanishes and the passages appear to
// survive, so nothing looks lost.
//
// The double also snapshots the manual table at the instant the new passages are
// written, which is how the ordering rule is asserted as a state ("the old
// manual was still there") rather than as a sequence of mocked call names.
// ===========================================================================

interface ManualRow {
  id: string;
  client_id: string;
  asset_id: string;
  filename: string;
  status: string;
  [key: string]: unknown;
}

interface ChunkRow {
  id: string;
  manual_id: string;
  client_id: string;
  asset_id: string;
  ordinal: number;
  body: string;
  [key: string]: unknown;
}

const db = vi.hoisted(() => ({
  manuals: [] as ManualRow[],
  chunks: [] as ChunkRow[],
  nextId: 0,
  /** The manual row insert is rejected — nothing of ours ever reaches the table. */
  failManualInsert: false,
  /** The passages are rejected: the real-world case is a body too big for PostgREST. */
  failChunkInsert: false,
  /** The delete that retires the PREVIOUS revision (the one carrying a `neq`) fails. */
  failRetire: false,
  /** The compensating delete of the half-written NEW revision fails too. */
  failRollback: false,
  /** The manual table as it stood when the new passages were written. */
  manualsWhenPassagesWritten: null as ManualRow[] | null,
}));

const ERROR = { code: "XXAAA", message: "rejected by the database" };

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from(table: string) {
      let op: "select" | "insert" | "delete" = "select";
      let payload: Record<string, unknown>[] = [];
      const filters: { column: string; op: "eq" | "neq"; value: unknown }[] = [];

      const rows = (): (ManualRow | ChunkRow)[] =>
        table === "equipment_manual" ? db.manuals : db.chunks;

      const matches = (row: Record<string, unknown>) =>
        filters.every((f) => (f.op === "eq" ? row[f.column] === f.value : row[f.column] !== f.value));

      function run(): { data: unknown; error: unknown } {
        if (op === "insert") {
          if (table === "equipment_manual") {
            if (db.failManualInsert) return { data: null, error: ERROR };
            const stored = payload.map((r) => ({ ...r, id: `manual-${db.nextId++}` })) as ManualRow[];
            db.manuals.push(...stored);
            return { data: stored.map((r) => ({ id: r.id })), error: null };
          }
          if (db.failChunkInsert) return { data: null, error: ERROR };
          // The snapshot that proves the previous revision was still standing
          // when the new one's passages landed.
          db.manualsWhenPassagesWritten = db.manuals.map((r) => ({ ...r }));
          const stored = payload.map((r) => ({ ...r, id: `chunk-${db.nextId++}` })) as ChunkRow[];
          db.chunks.push(...stored);
          return { data: null, error: null };
        }
        if (op === "delete") {
          // Which delete this is, told apart the way the database would: the
          // retire excludes the row just written (`neq`), the rollback names it.
          const isRetire = filters.some((f) => f.op === "neq");
          if (table === "equipment_manual" && isRetire && db.failRetire) return { data: null, error: ERROR };
          if (table === "equipment_manual" && !isRetire && db.failRollback) return { data: null, error: ERROR };
          const doomed = rows().filter(matches);
          if (table === "equipment_manual") {
            db.manuals = db.manuals.filter((r) => !doomed.includes(r));
            // 0098: `manual_id uuid not null references equipment_manual (id)
            // on delete cascade`. The passages go with the header row.
            const gone = new Set(doomed.map((r) => r.id));
            db.chunks = db.chunks.filter((c) => !gone.has(c.manual_id));
          } else {
            db.chunks = db.chunks.filter((r) => !doomed.includes(r));
          }
          return { data: null, error: null };
        }
        return { data: rows().filter(matches), error: null };
      }

      const chain = {
        insert(values: Record<string, unknown> | Record<string, unknown>[]) {
          op = "insert";
          payload = Array.isArray(values) ? values : [values];
          return chain;
        },
        delete() {
          op = "delete";
          return chain;
        },
        select() {
          return chain;
        },
        eq(column: string, value: unknown) {
          filters.push({ column, op: "eq", value });
          return chain;
        },
        neq(column: string, value: unknown) {
          filters.push({ column, op: "neq", value });
          return chain;
        },
        single() {
          const result = run();
          if (result.error) return Promise.resolve(result);
          const list = (result.data ?? []) as unknown[];
          if (list.length !== 1) {
            return Promise.resolve({ data: null, error: { code: "PGRST116", message: "expected exactly one row" } });
          }
          return Promise.resolve({ data: list[0], error: null });
        },
        then(resolve: (value: unknown) => void) {
          resolve(run());
        },
      };
      return chain;
    },
  }),
}));

const { replaceManual } = await import("./repository");

/** The manual the practice already has: ingested, indexed, answering questions. */
function seedExistingManual(): void {
  db.manuals.push({
    id: "manual-old",
    client_id: "vitality",
    asset_id: "asset-autoclave",
    filename: "steripro-22b.pdf",
    status: "ready",
  });
  db.chunks.push(
    { id: "chunk-old-1", manual_id: "manual-old", client_id: "vitality", asset_id: "asset-autoclave", ordinal: 0, body: "Fault E27: replace the door seal." },
    { id: "chunk-old-2", manual_id: "manual-old", client_id: "vitality", asset_id: "asset-autoclave", ordinal: 1, body: "Annual pressure vessel test." },
  );
}

const INPUT = {
  clientId: "vitality",
  assetId: "asset-autoclave",
  filename: "steripro-22b-rev-c.pdf",
  byteSize: 3_400_000,
  pageCount: 380,
  extractor: "unpdf@1.8.1",
  extractedChars: 900_000,
  status: "ready" as const,
  actor: "owner",
};

const NEW_CHUNKS = [
  { pageFrom: 1, pageTo: 1, ordinal: 0, body: "Revision C: fault E27 now means the water sensor." },
  { pageFrom: 2, pageTo: 2, ordinal: 1, body: "Revision C: annual pressure vessel test." },
];

/** The sentence the route renders as a 500; it asserts that nothing changed. */
const NOTHING_STORED = "We could not store that manual. Please try again.";

beforeEach(() => {
  db.manuals = [];
  db.chunks = [];
  db.nextId = 0;
  db.failManualInsert = false;
  db.failChunkInsert = false;
  db.failRetire = false;
  db.failRollback = false;
  db.manualsWhenPassagesWritten = null;
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("replaceManual never destroys the manual that is already stored", () => {
  it("leaves the existing manual and every one of its passages in place when the new passages are rejected", async () => {
    seedExistingManual();
    db.failChunkInsert = true;

    const result = await replaceManual(INPUT, NEW_CHUNKS);

    expect(result).toEqual({ ok: false, reason: NOTHING_STORED });
    // The practice still has exactly what it had, which is what that sentence
    // claims. Before this rule the table was empty here and the register said
    // "No manual uploaded" about a machine it had been answering from.
    expect(db.manuals.map((m) => m.id)).toEqual(["manual-old"]);
    expect(db.chunks.map((c) => c.body)).toEqual([
      "Fault E27: replace the door seal.",
      "Annual pressure vessel test.",
    ]);
  });

  it("leaves the existing manual in place when the new manual row itself is rejected", async () => {
    seedExistingManual();
    db.failManualInsert = true;

    const result = await replaceManual(INPUT, NEW_CHUNKS);

    expect(result).toEqual({ ok: false, reason: NOTHING_STORED });
    expect(db.manuals.map((m) => m.id)).toEqual(["manual-old"]);
    expect(db.chunks).toHaveLength(2);
  });

  it("still has the previous manual standing at the moment the new passages are written", async () => {
    seedExistingManual();

    await replaceManual(INPUT, NEW_CHUNKS);

    // The ordering rule as a state rather than a call sequence: the old row was
    // readable while the new revision was being written, so a failure at that
    // point had something to fall back to.
    expect(db.manualsWhenPassagesWritten?.map((m) => m.id)).toContain("manual-old");
  });

  it("leaves exactly one manual — the new one — and none of the old passages when it succeeds", async () => {
    seedExistingManual();

    const result = await replaceManual(INPUT, NEW_CHUNKS);

    expect(result.ok).toBe(true);
    // REPLACE, not append: one current manual per asset, or the desk quotes a
    // superseded procedure.
    expect(db.manuals).toHaveLength(1);
    expect(db.manuals[0].filename).toBe("steripro-22b-rev-c.pdf");
    expect(db.chunks.map((c) => c.manual_id)).toEqual([db.manuals[0].id, db.manuals[0].id]);
    expect(db.chunks.every((c) => c.body.startsWith("Revision C"))).toBe(true);
  });

  it("stores a scan with no passages and still retires the previous revision", async () => {
    seedExistingManual();

    const result = await replaceManual({ ...INPUT, status: "no_text" }, []);

    expect(result.ok).toBe(true);
    expect(db.manuals).toHaveLength(1);
    expect(db.manuals[0].status).toBe("no_text");
    // The old manual's passages went with its header row; nothing of the old
    // revision is left to be searched.
    expect(db.chunks).toHaveLength(0);
  });

  it("rolls the new revision back rather than leaving two in the index when the retire is refused", async () => {
    seedExistingManual();
    db.failRetire = true;

    const result = await replaceManual(INPUT, NEW_CHUNKS);

    expect(result).toEqual({ ok: false, reason: NOTHING_STORED });
    // Exactly what the practice had before it pressed upload — and no mixed
    // index, which is the state this function exists to prevent.
    expect(db.manuals.map((m) => m.id)).toEqual(["manual-old"]);
    expect(db.chunks.map((c) => c.manual_id)).toEqual(["manual-old", "manual-old"]);
  });

  it("names the two-revision state instead of claiming nothing was stored when even the rollback fails", async () => {
    seedExistingManual();
    db.failRetire = true;
    db.failRollback = true;

    const result = await replaceManual(INPUT, NEW_CHUNKS);

    expect(result.ok).toBe(false);
    const reason = (result as { ok: false; reason: string }).reason;
    // "Nothing was stored" would be the same lie in the other direction: the new
    // manual IS in the table and IS searchable.
    expect(reason).not.toBe(NOTHING_STORED);
    expect(reason).toContain("both");
    expect(reason).toContain("Manuals tab");
    expect(db.manuals).toHaveLength(2);
  });
});
