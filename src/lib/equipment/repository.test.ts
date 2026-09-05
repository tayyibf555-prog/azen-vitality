import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ===========================================================================
// THE IMPORTER'S DEDUPE KEY, DRIVEN AGAINST A DATABASE DOUBLE THAT IMPLEMENTS
// THE TWO THINGS THAT MATTER: SQL `ILIKE` PATTERN SEMANTICS, AND THE REGISTER'S
// OWN UNIQUE INDEX.
//
// WHY A DOUBLE WITH REAL LIKE SEMANTICS RATHER THAN A SPY. The defect this file
// exists for was invisible to every stub: the importer resolved "is this asset
// already registered?" with `.ilike("serial", serial)`, handing a spreadsheet
// cell to PostgREST as the SQL pattern itself. In SQL, `_` matches any single
// character and `%` matches any run of them (and PostgREST reads `*` as `%`
// besides), so an asset tag of "SN_1234" matched a REGISTERED "SN-1234" — one
// row came back, the importer UPDATED it, and the autoclave silently took on
// another machine's name, supplier and next service date, reported to the
// practice as `updated: 1`. A mock whose `ilike` behaves like `eq` cannot see
// any of that; it agrees with the bug. So the double below turns the pattern
// into a regular expression the way Postgres would, which is what makes these
// tests evidence rather than decoration.
//
// The schema's real key is `unique (client_id, lower(serial))` (migration 0098),
// which is a plain case-folded equality — so the match key and the constraint
// disagreed, and the importer could match a row the database would never have
// considered a duplicate. The double enforces the constraint too, so the fail
// direction is visible: what the in-memory match misses, the index still stops.
// ===========================================================================

interface Row {
  id: string;
  client_id: string;
  serial: string | null;
  name: string;
  next_service_due: string | null;
  supplier: string | null;
  [key: string]: unknown;
}

const db = vi.hoisted(() => ({
  rows: [] as Row[],
  /** Every filter every query applied, so "which operator was used" is provable. */
  operators: [] as { table: string; column: string; op: string; value: unknown }[],
  nextId: 0,
  /** Set to make the serial-index read fail, which must not fail the whole import. */
  indexReadFails: false,
  /** Every `.limit(n)` any query applied, so "is the read bounded" is provable. */
  limits: [] as { table: string; n: number }[],
}));

/** Postgres LIKE/ILIKE, as PostgREST hands it on: `_` any char, `%` and `*` any run. */
function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const translated = escaped.replace(/[*%]/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${translated}$`, "i");
}

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from(table: string) {
      let op: "select" | "insert" | "update" | "delete" = "select";
      let payload: Record<string, unknown> | null = null;
      const filters: { column: string; op: string; value: unknown }[] = [];
      let cap = Number.POSITIVE_INFINITY;

      const matches = (row: Row) =>
        filters.every((f) => {
          if (f.op === "eq") return row[f.column] === f.value;
          if (f.op === "ilike") {
            const value = row[f.column];
            return typeof value === "string" && likeToRegExp(String(f.value)).test(value);
          }
          if (f.op === "not.is") return row[f.column] !== f.value;
          throw new Error(`the double does not implement operator ${f.op}`);
        });

      const key = (clientId: unknown, serial: unknown) =>
        typeof serial === "string" && serial !== "" ? `${String(clientId)}::${serial.toLowerCase()}` : null;

      function run(): { data: unknown; error: unknown } {
        if (op === "select") {
          if (db.indexReadFails) return { data: null, error: { code: "XXAAA", message: "read failed" } };
          return { data: db.rows.filter(matches).slice(0, cap), error: null };
        }
        if (op === "insert") {
          const row = payload as unknown as Row;
          const k = key(row.client_id, row.serial);
          // THE REGISTER'S OWN CONSTRAINT: unique (client_id, lower(serial)),
          // partial on a non-empty serial. 0098 is what actually stops a
          // duplicate; the importer's match is an optimisation over it.
          if (k && db.rows.some((r) => key(r.client_id, r.serial) === k)) {
            return {
              data: null,
              error: { code: "23505", message: 'duplicate key value violates unique constraint "idx_equipment_asset_serial"' },
            };
          }
          const stored = { ...row, id: `row-${db.nextId++}` };
          db.rows.push(stored);
          return { data: [{ id: stored.id }], error: null };
        }
        if (op === "update") {
          for (const row of db.rows.filter(matches)) Object.assign(row, payload);
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }

      const chain = {
        select() {
          // Columns are irrelevant to the double: the rows it holds are already
          // the two the importer asks for.
          return chain;
        },
        insert(values: Record<string, unknown>) {
          op = "insert";
          payload = values;
          return chain;
        },
        update(values: Record<string, unknown>) {
          op = "update";
          payload = values;
          return chain;
        },
        delete() {
          op = "delete";
          return chain;
        },
        eq(column: string, value: unknown) {
          db.operators.push({ table, column, op: "eq", value });
          filters.push({ column, op: "eq", value });
          return chain;
        },
        ilike(column: string, value: unknown) {
          db.operators.push({ table, column, op: "ilike", value });
          filters.push({ column, op: "ilike", value });
          return chain;
        },
        not(column: string, operator: string, value: unknown) {
          db.operators.push({ table, column, op: `not.${operator}`, value });
          filters.push({ column, op: `not.${operator}`, value });
          return chain;
        },
        order() {
          return chain;
        },
        limit(n: number) {
          db.limits.push({ table, n });
          cap = n;
          return chain;
        },
        maybeSingle() {
          const result = run() as { data: unknown; error: unknown };
          if (result.error) return Promise.resolve(result);
          const rows = (result.data ?? []) as unknown[];
          if (rows.length > 1) {
            // What postgrest-js actually does with more than one row.
            return Promise.resolve({ data: null, error: { code: "PGRST116", message: "multiple rows returned" } });
          }
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        single() {
          const result = run() as { data: unknown; error: unknown };
          if (result.error) return Promise.resolve(result);
          const rows = (result.data ?? []) as unknown[];
          if (rows.length !== 1) {
            return Promise.resolve({ data: null, error: { code: "PGRST116", message: "expected exactly one row" } });
          }
          return Promise.resolve({ data: rows[0], error: null });
        },
        then(resolve: (value: unknown) => void) {
          resolve(run());
        },
      };
      return chain;
    },
  }),
}));

const { importAssets, SERIAL_INDEX_CAP } = await import("./repository");

type ImportRow = Parameters<typeof importAssets>[1][number];

const ROW = (over: Partial<ImportRow> = {}): ImportRow => ({
  name: "SteriPro 22B",
  category: "sterilisation",
  siteId: "site-cc",
  make: "W&H",
  model: "Lisa 500",
  serial: "SN-1234",
  room: "Decon room",
  supplier: "DentalTech",
  supplierPhone: "020 7000 0000",
  purchasedOn: null,
  lastServicedOn: null,
  nextServiceDue: "2027-03-02",
  notes: null,
  ...over,
});

/** Seed a registered asset the way the register really holds one. */
function registered(over: Partial<Row> = {}): Row {
  const row: Row = {
    id: `row-${db.nextId++}`,
    client_id: "vitality",
    serial: "SN-1234",
    name: "Autoclave",
    next_service_due: "2026-11-01",
    supplier: "DentalTech",
    ...over,
  };
  db.rows.push(row);
  return row;
}

const find = (id: string) => db.rows.find((r) => r.id === id)!;

beforeEach(() => {
  db.rows = [];
  db.operators = [];
  db.limits = [];
  db.nextId = 0;
  db.indexReadFails = false;
});

describe("1. a serial with a SQL wildcard in it cannot claim another machine's row", () => {
  it("'SN_1234' does not match a registered 'SN-1234' — it becomes its own asset", async () => {
    // THE DEFECT, in one case. `_` is a single-character wildcard in SQL LIKE,
    // so the old `.ilike("serial", serial)` matched the hyphen, updated the
    // autoclave with the new machine's identity — name, supplier, and the next
    // service date the register exists to hold — and reported `updated: 1` with
    // no warning at all. The double above implements those LIKE semantics, so
    // this test is red the moment the pattern comes back.
    const autoclave = registered({ serial: "SN-1234", name: "Autoclave", next_service_due: "2026-11-01" });

    const result = await importAssets(
      "vitality",
      [ROW({ serial: "SN_1234", name: "Bench compressor", nextServiceDue: "2028-01-01" })],
      "user-1",
    );

    expect(result).toMatchObject({ inserted: 1, updated: 0, failed: [] });
    // The autoclave is untouched: same name, same supplier, and above all the
    // same service date.
    expect(find(autoclave.id)).toMatchObject({
      name: "Autoclave",
      serial: "SN-1234",
      next_service_due: "2026-11-01",
    });
    // And the new machine really landed, rather than vanishing into the update.
    expect(db.rows.map((r) => r.name).sort()).toEqual(["Autoclave", "Bench compressor"]);
  });

  it("neither does '%' nor '*' — the other two wildcards, including PostgREST's own", async () => {
    // `*` is not a SQL wildcard; PostgREST translates it to `%` on the way in,
    // which is why escaping the three SQL metacharacters would not have been
    // enough on its own and why the match is done on a normalised value instead.
    registered({ serial: "SN-1234", name: "Autoclave" });
    registered({ serial: "SN-9999", name: "Compressor" });

    const result = await importAssets(
      "vitality",
      [ROW({ serial: "SN%", name: "Wildcard one" }), ROW({ serial: "*", name: "Wildcard two" })],
      "user-1",
    );

    expect(result.updated).toBe(0);
    expect(result.inserted).toBe(2);
    expect(find(db.rows[0].id).name).toBe("Autoclave");
    expect(find(db.rows[1].id).name).toBe("Compressor");
  });

  it("no query ever puts a serial through an ilike pattern", async () => {
    // The behavioural tests above are the proof; this one names the mechanism,
    // so a future rewrite that reintroduces a raw pattern is caught even if it
    // happens to pass on the values these fixtures use (programme ruling W3/12).
    registered({ serial: "SN-1234" });
    await importAssets("vitality", [ROW({ serial: "SN-1234" })], "user-1");
    expect(db.operators.filter((o) => o.op === "ilike")).toEqual([]);
  });
});

describe("2. the key the importer matches on is the key the database enforces", () => {
  it("a re-import with different casing UPDATES, it does not duplicate", async () => {
    // The behaviour 0098's own comment promises and the reason the index is on
    // `lower(serial)`: the spreadsheet is corrected and imported again, and the
    // second import must update the autoclave rather than create a second one —
    // even when somebody typed the serial in lower case the second time.
    const autoclave = registered({ serial: "SN-1234", name: "Autoclave", next_service_due: "2026-11-01" });

    const result = await importAssets(
      "vitality",
      [ROW({ serial: "sn-1234", name: "Autoclave (decon)", nextServiceDue: "2027-06-01" })],
      "user-1",
    );

    expect(result).toMatchObject({ inserted: 0, updated: 1, failed: [] });
    expect(db.rows).toHaveLength(1);
    expect(find(autoclave.id)).toMatchObject({
      name: "Autoclave (decon)",
      next_service_due: "2027-06-01",
    });
  });

  it("a row with NO serial is always inserted, never merged with another", async () => {
    // There is nothing to match an unnamed cabinet on, and quietly merging two
    // of them would lose one.
    registered({ serial: null, name: "Cabinet A" });
    const result = await importAssets(
      "vitality",
      [ROW({ serial: null, name: "Cabinet B" }), ROW({ serial: "", name: "Cabinet C" })],
      "user-1",
    );
    expect(result.inserted).toBe(2);
    expect(result.updated).toBe(0);
    expect(db.rows).toHaveLength(3);
  });

  it("another practice's identical serial is not touched", async () => {
    const theirs = registered({ client_id: "other-practice", serial: "SN-1234", name: "Their autoclave" });
    const result = await importAssets("vitality", [ROW({ serial: "SN-1234", name: "Our autoclave" })], "user-1");
    expect(result).toMatchObject({ inserted: 1, updated: 0 });
    expect(find(theirs.id).name).toBe("Their autoclave");
  });

  it("the same serial twice in ONE file updates the row the first line created", async () => {
    const result = await importAssets(
      "vitality",
      [ROW({ serial: "SN-1234", name: "First pass" }), ROW({ serial: "sn-1234", name: "Second pass" })],
      "user-1",
    );
    expect(result).toMatchObject({ inserted: 1, updated: 1, failed: [] });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].name).toBe("Second pass");
  });
});

describe("3. the fail direction is closed, and the practice is told which row and why", () => {
  it("a serial-index read failure does not fail the import: the constraint still holds the line", async () => {
    // The in-memory index is an optimisation over `idx_equipment_asset_serial`,
    // never a substitute for it. With the index read broken, every row is
    // attempted as an insert and the database refuses the duplicate — which is
    // the safe direction: a row reported as unsaved, not a row silently written
    // over the top of a different machine.
    registered({ serial: "SN-1234", name: "Autoclave", next_service_due: "2026-11-01" });
    db.indexReadFails = true;

    const result = await importAssets(
      "vitality",
      [ROW({ serial: "SN-1234", name: "Autoclave", nextServiceDue: "2028-01-01" }), ROW({ serial: "SN-5555", name: "Compressor" })],
      "user-1",
    );

    // The clashing row is refused by name, and the innocent row still lands.
    expect(result.inserted).toBe(1);
    expect(result.failed).toEqual([
      { name: "Autoclave", reason: "another asset on the register already has that serial number" },
    ]);
    expect(db.rows.find((r) => r.serial === "SN-1234")!.next_service_due).toBe("2026-11-01");
  });

  it("one bad row does not reject the rest of the file", async () => {
    registered({ serial: "SN-1234", name: "Autoclave" });
    db.indexReadFails = true;
    const result = await importAssets(
      "vitality",
      [ROW({ serial: "SN-1234" }), ROW({ serial: "SN-2" }), ROW({ serial: "SN-3" })],
      "user-1",
    );
    expect(result.inserted).toBe(2);
    expect(result.failed).toHaveLength(1);
  });

  it("the serial index read is BOUNDED and scoped to the practice", async () => {
    // Every read in this module is bounded by rule, and this one is no exception
    // — but being short here corrupts nothing, because the constraint is what
    // actually enforces the key.
    //
    // ASSERTED BEHAVIOURALLY, on the limit the query actually applied, rather
    // than on `SERIAL_INDEX_CAP > 0` — which was true of every number the
    // constant could ever hold, including the 5,000 that sat ABOVE PostgREST's
    // 1,000-row ceiling and so was never the bound the code was reading at
    // (programme ruling W3/17: always-true guards are rewritten).
    registered({ serial: "SN-1234" });
    await importAssets("vitality", [ROW({ serial: "SN-1234" })], "user-1");
    expect(db.limits).toContainEqual({ table: "equipment_asset", n: SERIAL_INDEX_CAP });
    expect(db.operators).toContainEqual({
      table: "equipment_asset",
      column: "client_id",
      op: "eq",
      value: "vitality",
    });
  });
});
