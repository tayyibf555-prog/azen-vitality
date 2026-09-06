// ===========================================================================
// THE FAKE KNOWS EXACTLY WHICH COLUMNS EXIST, BECAUSE THE REAL DATABASE DOES.
//
// The sibling file fake-supabase-max-rows.test.ts pins how MANY rows come back.
// This one pins WHICH COLUMNS ARE THERE, which was the other half of the same
// rule (charter §0/11, "the mock must be at least as strict as live") and stayed
// open a great deal longer.
//
// TWO DEFECTS, ONE SEAM. Both were found in the wave-3 review and both are here:
//
//   1. THE MIGRATION READER LOST COLUMNS. `alter table t add column a …, add
//      column b …` was read as ONE column, so every column after the first comma
//      was invisible to this fake and the first column's `default` expression ran
//      on through the comma and came out unrecognised — meaning `rota_shift.origin`
//      had no default here while being `not null default 'generated'` live. And
//      because the reader searched the RAW file, an `alter table` statement whose
//      first `add column` sat behind a comment (0078, 0079 and 0082 all explain
//      the column before adding it) was skipped in its entirety, while an `alter
//      table … add column …` written INSIDE a comment was read as real.
//
//   2. NOTHING CHECKED COLUMN EXISTENCE AT ALL. A write naming a column no
//      migration declares was hydrated onto a plain JS object; a read naming one
//      came back `undefined`; a filter naming one silently matched nothing, or —
//      for `.is(col, null)` — silently matched EVERYTHING. Live PostgREST answers
//      PGRST204 to the write and 42703 to the read, and both fail the whole
//      statement. That is the fake being more generous than live in the one
//      direction its own header says it must never be.
//
// THE COST OF (2), PAID ALREADY: `sync_state.backfill_page` and `backfill_done`
// are read first thing every tick by three registered syncs and were declared by
// no migration anywhere until 0106. The whole suite was green against a schema
// the code cannot run on. src/lib/coordinator/sync-state-backfill-columns.test.ts
// closes that for that module; this closes it for the tree.
//
// THE COST OF (1), NEARLY PAID: 0075_staff_hr_profile.sql spends three paragraphs
// on why pay must NEVER be a column on `rota_staff` — and opens them with the
// words `alter table rota_staff add column hourly_pence int`, as the shape it is
// refusing. The reader believed it. Until this change the fake held a
// `rota_staff.hourly_pence`, so a test writing pay onto the staff row would have
// been green while live answered PGRST204. The last test in the first block is
// that exact column, by name.
//
// CALIBRATION, READ LIVE AND NOT ASSUMED. On 6 September 2026 every column of
// every table held by BOTH supabase/migrations and the live database (project
// qoiyaiiajdqydyrccixt, read-only information_schema) was compared. With the
// reader fixed the two agree EXACTLY, in both directions, with no exceptions —
// which is why the guard ships with no allowlist. A column that exists live and
// in no migration is a real defect with a known correct fix: write the migration,
// as 0106 did.
// ===========================================================================
import { describe, it, expect, beforeEach } from "vitest";

import {
  createFakeSupabase,
  defaultsFor,
  knownColumns,
  migrationSchema,
} from "@/lib/test-support/fake-supabase";

const world = createFakeSupabase();

beforeEach(() => {
  world.reset();
});

/** The declared columns of a table, as a plain sorted list. */
function declared(table: string): string[] {
  const known = knownColumns(table);
  expect(known, `supabase/migrations declares no "${table}"`).toBeTruthy();
  return [...known!].sort();
}

// ---------------------------------------------------------------------------
// 1. The migration reader.
// ---------------------------------------------------------------------------

describe("the migration reader sees every column the migrations declare", () => {
  // MUTATION: in migrationSchema()'s ALTER loop, stop splitting the statement on
  // top-level commas and take only the first `add column` clause.
  it("reads EVERY column of a multi-column alter, not just the first", () => {
    // 0074_rota_manual_publish.sql adds five in one statement; live has all five
    // (information_schema, 6 Sep 2026).
    for (const column of ["origin", "paired_staff_id", "note", "published_at", "published_version"]) {
      expect(
        declared("rota_shift"),
        `rota_shift.${column} is added by 0074 and must not be lost after the first comma`,
      ).toContain(column);
    }
    // 0064_patient_note_pinning.sql adds five more, in one statement, on another table.
    for (const column of ["pinned_at", "pinned_by", "colour", "updated_at", "updated_by"]) {
      expect(declared("patient_note")).toContain(column);
    }
    // 0045_deliverability_nurture.sql — the second of two.
    expect(declared("speed_to_lead_lead")).toContain("nurture_next_at");
  });

  // MUTATION: in migrationSchema()'s ALTER loop, hand parseColumnDefinition the
  // whole statement instead of one clause of it.
  it("keeps the DEFAULT on the first column of a multi-column alter", () => {
    // Before the fix the default expression ran on past the comma and through the
    // columns behind it, so parseDefault refused the whole string and the column
    // came out with no default at all.
    const shift = defaultsFor("rota_shift");
    expect(shift.origin, "rota_shift.origin is `not null default 'generated'` live").toBe("generated");
    const lead = defaultsFor("speed_to_lead_lead");
    expect(lead.nurture_step, "speed_to_lead_lead.nurture_step is `not null default 0` live").toBe(0);
  });

  // MUTATION: run the ALTER scan over `sql` instead of `stripSqlComments(sql)`.
  it("reads an alter whose first `add column` sits behind a comment", () => {
    // 0078, 0079 and 0082 all write a paragraph between `alter table
    // smile_assessment_campaign` and the first `add column`. All three statements
    // were skipped entirely, so seven live columns were missing from this fake.
    const campaign = declared("smile_assessment_campaign");
    for (const column of [
      "flow",
      "flow_version",
      "flow_published",
      "theme",
      "follow_up_enabled",
      "follow_up_trigger",
      "follow_up_template",
    ]) {
      expect(campaign, `smile_assessment_campaign.${column} exists live and must be declared here`).toContain(column);
    }
    const defaults = defaultsFor("smile_assessment_campaign");
    expect(defaults.flow_version, "`flow_version int not null default 0` (0078)").toBe(0);
    expect(defaults.flow_published, "`flow_published boolean not null default false` (0078)").toBe(false);
    expect(defaults.follow_up_enabled, "`follow_up_enabled boolean not null default false` (0082)").toBe(false);
  });

  // MUTATION: same one — the comment strip is what keeps this column out.
  it("never reads a column out of a SQL comment", () => {
    // 0075_staff_hr_profile.sql:7 — "The obvious shape is `alter table rota_staff
    // add column hourly_pence int`. It leaks on the day it is added" — followed by
    // three paragraphs on why the tree refuses it and put pay in staff_pay_rate
    // instead. Live rota_staff has eleven columns and this is not one of them.
    expect(
      declared("rota_staff"),
      "the fake read rota_staff.hourly_pence out of the comment that forbids it",
    ).not.toContain("hourly_pence");
    expect(declared("staff_pay_rate"), "pay lives on its own table, which a query has to name").toContain(
      "hourly_pence",
    );
  });

  it("still reads plain create-table columns and their defaults", () => {
    // The shared parseColumnDefinition serves both paths; this is the create half,
    // so a change made for the alter half cannot quietly break it.
    const outbox = defaultsFor("previsit_outbox");
    expect(outbox.status, "an outbox insert defaults to 'queued' — the drain's whole premise").toBe("queued");
    expect(declared("previsit_outbox")).toContain("not_before_at");
  });
});

// ---------------------------------------------------------------------------
// 2. The column guard.
// ---------------------------------------------------------------------------

/** The message every direction of the guard shares, so one assertion names it. */
const UNDECLARED = /no migration in supabase\/migrations\/ declares/;

// THE REFUSAL IS SYNCHRONOUS, AT THE POINT THE COLUMN IS NAMED — `.insert({…})`,
// `.select("…")`, `.is("…", null)` — rather than at the point the query is
// awaited. Live cannot do that (PostgREST only answers once asked), so this is
// STRICTER than live, which is the direction this file is allowed to differ in,
// and it puts the stack trace on the line that wrote the name.

describe("a column no migration declares is refused, in every direction", () => {
  // MUTATION: delete the assertColumnsDeclared call in insert().
  it("refuses a WRITE naming an undeclared column, as PostgREST does with PGRST204", () => {
    // review_request holds `send_at`, not `sent_at` (information_schema, 6 Sep
    // 2026) — a real near-miss, and the shape live answers PGRST204 to.
    expect(() =>
      world.client.from("review_request").insert({ id: "r1", site_id: "s", sent_at: "2026-09-06T09:00:00.000Z" }),
    ).toThrow(UNDECLARED);
    expect(world.rows("review_request"), "nothing may land, exactly as nothing lands live").toHaveLength(0);
  });

  // MUTATION: delete the assertColumnsDeclared call in update().
  it("refuses an UPDATE naming an undeclared column", () => {
    world.seed("review_request", { id: "r1", site_id: "s", status: "queued" });
    expect(() =>
      world.client.from("review_request").update({ status: "sent", sent_at: "2026-09-06T09:00:00.000Z" }),
    ).toThrow(UNDECLARED);
    expect(world.rows("review_request")[0].status, "the row is untouched, as it would be live").toBe("queued");
  });

  // MUTATION: delete the assertColumnsDeclared call in upsert().
  it("refuses an UPSERT naming an undeclared column, payload or conflict target", () => {
    expect(() => world.client.from("sync_state").upsert({ site_id: "s", resource: "patients", cursor_page: 3 })).toThrow(
      UNDECLARED,
    );
    expect(() =>
      world.client
        .from("sync_state")
        .upsert({ site_id: "s", resource: "patients" }, { onConflict: "site_id,resource_name" }),
    ).toThrow(UNDECLARED);
  });

  // MUTATION: delete the assertColumnsDeclared call in seed().
  it("refuses a SEED naming an undeclared column, so a fixture cannot invent a schema", () => {
    // treatment_opportunity is scoped by site_id and has no client_id; the seed in
    // src/lib/offset-paging-ceiling.test.ts carried one until this guard was added.
    expect(() => world.seed("treatment_opportunity", { id: "o1", site_id: "s", client_id: "vitality" })).toThrow(
      UNDECLARED,
    );
  });

  // MUTATION: delete the assertColumnsDeclared call in select().
  it("refuses a READ whose projection names an undeclared column, as 42703 does", async () => {
    world.seed("sync_state", { site_id: "s", resource: "patients" });
    expect(() => world.client.from("sync_state").select("site_id, resource, backfill_cursor")).toThrow(UNDECLARED);
    // The declared shape still reads, so the guard is about the name and not the read.
    const ok = await world.client.from("sync_state").select("site_id, resource, backfill_page, backfill_done");
    expect((ok.data as unknown[]).length).toBe(1);
  });

  // MUTATION: delete the filterOn call in is().
  it("refuses a FILTER naming an undeclared column — the fail-OPEN direction", () => {
    // This one was worse than merely permitted. A column that is not on the row
    // reads `undefined`, so `.is(col, null)` matched EVERY row: a read live would
    // refuse outright instead came back silently WIDENED.
    world.seed("recall_target", { id: "t1", site_id: "s", dentally_patient_id: "p1", status: "due" });
    world.seed("recall_target", { id: "t2", site_id: "s", dentally_patient_id: "p2", status: "sent" });
    expect(() => world.client.from("recall_target").select("id").is("suppressed_at", null)).toThrow(UNDECLARED);
    expect(() => world.client.from("recall_target").select("id").eq("patient_status", "x")).toThrow(UNDECLARED);
    expect(() => world.client.from("recall_target").select("id").order("suppressed_at")).toThrow(UNDECLARED);
    // …and the rows are still both there, so the filter never ran at all.
    expect(world.rows("recall_target")).toHaveLength(2);
  });

  it("lets every declared column through, so the guard costs nothing on a green day", async () => {
    // The whole width of a real table, seeded and read back. A guard that reddened
    // correct code would be a worse defect than the one it closes, because it would
    // be paid every day rather than once.
    const columns = declared("previsit_target");
    const row: Record<string, unknown> = {};
    for (const c of columns) row[c] = row[c] ?? null;
    row.id = "t1";
    row.site_id = "s";
    expect(() => world.seed("previsit_target", row)).not.toThrow();
    const read = await world.client.from("previsit_target").select(columns.join(", ")).eq("id", "t1");
    expect(read.error).toBeNull();
    expect((read.data as unknown[]).length).toBe(1);
  });

  it("does not guess at shapes it cannot read: json paths and embedded resources", async () => {
    world.seed("recall_target", { id: "t1", site_id: "s", dentally_patient_id: "p1", consent: { sms: true } });
    // An embedded resource in the projection — the reader claims nothing at all
    // rather than reading `patient` or `id` out of `patient(id,name)`.
    await expect(
      world.client.from("recall_target").select("id, patient(id,name)").eq("id", "t1"),
    ).resolves.toBeTruthy();
    // A json path is not a column name and is left alone.
    await expect(world.client.from("recall_target").select("id").eq("consent->>sms", "true")).resolves.toBeTruthy();
  });

  it("does not guard the four tables whose real shape the repo cannot see", () => {
    // MISSING_FROM_MIGRATIONS says in a paragraph of its own that reactivation_*
    // was created out of band and its constraints are invisible from the codebase.
    // Guarding a shape nobody can read would be inventing strictness, not modelling it.
    expect(knownColumns("reactivation_touch"), "no migration declares this table's columns").toBeNull();
    expect(() => world.seed("reactivation_touch", { id: "x", site_id: "s", anything_at_all: 1 })).not.toThrow();
  });

  it("is a rule over the whole schema, not a list of the columns that were wrong", () => {
    // Without this the guard could be reduced to the handful of names above and
    // nothing would go red. Every table the migrations declare must be readable
    // as a column set, and no table may come back empty.
    const tables = [...migrationSchema().keys()];
    expect(tables.length, "the migration reader found no tables at all").toBeGreaterThan(100);
    const empty = tables.filter((t) => (knownColumns(t) ?? new Set()).size === 0);
    expect(empty, "a table parsed with zero columns would be unguardable and silently permissive").toEqual([]);
  });
});
