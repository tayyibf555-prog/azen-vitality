/**
 * A tiny in-memory stand-in for the two tables the correspondence timeline reads.
 *
 * TEST SUPPORT ONLY. Nothing in the application imports this; it exists so the
 * "does this message reach the patient's record?" tests can run the REAL write
 * (`recordOutbound` -> `findOrCreateConversation` -> `appendMessage`) and the REAL
 * read (`getThreadForPatient`) against one store.
 *
 * That end-to-endness is the point. A test that mocks `recordOutbound` and asserts
 * it was called proves a function was invoked, not that a coordinator opening the
 * record will see the message — and "we called the logger" is exactly the belief
 * that let four send paths go missing from the tab in the first place. Here the
 * only thing faked is Postgres.
 *
 * UNKNOWN TABLES RETURN EMPTY, NOT AN ERROR. `getThreadForPatient` also reads
 * eleven `*_touch` sources; they are irrelevant to these tests and returning an
 * error for them would make every assertion run against a partially-failed read.
 * They come back empty, so the thread under test contains exactly what was written.
 */

interface Row {
  [column: string]: unknown;
}

interface Filter {
  op: "eq" | "in";
  column: string;
  value: unknown;
}

export interface AgentStoreFake {
  tables: Record<string, Row[]>;
  /** Set a table name here to make every query against it throw, for fail-soft tests. */
  failTables: Set<string>;
  /** Every insert, in order, so a test can assert exactly one row was written. */
  inserts: Array<{ table: string; row: Row }>;
  seq: number;
}

export const agentStore: AgentStoreFake = {
  tables: {},
  failTables: new Set<string>(),
  inserts: [],
  seq: 0,
};

export function resetAgentStore(): void {
  agentStore.tables = { agent_conversation: [], agent_message: [] };
  agentStore.failTables = new Set<string>();
  agentStore.inserts = [];
  agentStore.seq = 0;
}

/** Rows currently in a table, in insertion order. */
export function rowsIn(table: string): Row[] {
  return agentStore.tables[table] ?? [];
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) =>
    f.op === "in" ? (f.value as unknown[]).includes(row[f.column]) : row[f.column] === f.value,
  );
}

function nowIso(offsetMs: number): string {
  // A fixed base plus a monotonic offset, so ordering is deterministic and two rows
  // written in the same millisecond still sort in the order they were written.
  return new Date(Date.UTC(2026, 7, 21, 9, 0, 0) + offsetMs).toISOString();
}

interface QueryState {
  table: string;
  filters: Filter[];
  orderBy: { column: string; ascending: boolean } | null;
  limitTo: number | null;
  inserted: Row[] | null;
}

function runSelect(q: QueryState): { data: Row[] | null; error: { message: string } | null } {
  if (agentStore.failTables.has(q.table)) {
    return { data: null, error: { message: `simulated outage on ${q.table}` } };
  }
  // An insert followed by .select() returns what was just written.
  if (q.inserted) return { data: q.inserted.map((r) => ({ ...r })), error: null };
  let rows = (agentStore.tables[q.table] ?? []).filter((r) => matches(r, q.filters));
  if (q.orderBy) {
    const { column, ascending } = q.orderBy;
    rows = [...rows].sort((a, b) => {
      const av = String(a[column] ?? "");
      const bv = String(b[column] ?? "");
      return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }
  if (q.limitTo !== null) rows = rows.slice(0, q.limitTo);
  return { data: rows.map((r) => ({ ...r })), error: null };
}

/** A `serviceClient()` replacement carrying just enough PostgREST surface. */
export function serviceClientFake(): { from: (table: string) => Record<string, unknown> } {
  return {
    from(table: string) {
      const q: QueryState = { table, filters: [], orderBy: null, limitTo: null, inserted: null };
      const api: Record<string, unknown> = {
        select: () => api,
        eq: (column: string, value: unknown) => {
          q.filters.push({ op: "eq", column, value });
          return api;
        },
        in: (column: string, value: unknown[]) => {
          q.filters.push({ op: "in", column, value });
          return api;
        },
        // `.not("status", "in", "(closed)")` — the only `not` the write path uses.
        not: () => api,
        order: (column: string, opts?: { ascending?: boolean }) => {
          q.orderBy = { column, ascending: opts?.ascending !== false };
          return api;
        },
        limit: (n: number) => {
          q.limitTo = n;
          return api;
        },
        overrideTypes: () => api,
        insert: (row: Row) => {
          if (agentStore.failTables.has(table)) {
            // Rejects on await, exactly as a PostgREST error surfaces through the
            // repository's `if (error) throw error`.
            q.inserted = null;
            const failing: Record<string, unknown> = {
              select: () => failing,
              single: () => Promise.resolve({ data: null, error: { message: `simulated outage on ${table}` } }),
              maybeSingle: () => Promise.resolve({ data: null, error: { message: `simulated outage on ${table}` } }),
              then: (resolve: (r: unknown) => unknown) =>
                Promise.resolve({ data: null, error: { message: `simulated outage on ${table}` } }).then(resolve),
            };
            return failing;
          }
          agentStore.seq += 1;
          const stored: Row = {
            id: `${table}-${agentStore.seq}`,
            status: "active",
            treatment: null,
            funding_type: null,
            tool_name: null,
            last_inbound_at: null,
            created_at: nowIso(agentStore.seq * 1000),
            updated_at: nowIso(agentStore.seq * 1000),
            ...row,
          };
          agentStore.tables[table] = [...(agentStore.tables[table] ?? []), stored];
          agentStore.inserts.push({ table, row: stored });
          q.inserted = [stored];
          return api;
        },
        maybeSingle: () => {
          const { data, error } = runSelect(q);
          return Promise.resolve({ data: data && data.length > 0 ? data[0] : null, error });
        },
        single: () => {
          const { data, error } = runSelect(q);
          return Promise.resolve({ data: data && data.length > 0 ? data[0] : null, error });
        },
        then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(runSelect(q)).then(resolve, reject),
      };
      return api;
    },
  };
}
