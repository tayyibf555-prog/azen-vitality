import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createFakeSupabase } from "@/lib/test-support/fake-supabase";

vi.mock("server-only", () => ({}));

// ===========================================================================
// THE CONFIGURATION PRODUCTION IS PERMANENTLY IN — the write-back migration's
// OWN SEEDED ROW, present, with the deployment unarmed.
//
// WHY THIS FILE EXISTS. Every test that had ever driven the gate or the Sync
// Status assembly modelled a database in which the write-back migration had NOT
// run: `write-gate.test.ts`'s `gateOffAgainstLiveDentally()` only deletes
// environment variables and leaves `system_toggle` empty, and every other file
// stubs `@/lib/systems/repository` outright. The suite therefore agreed with
// itself and disagreed with the only database that matters, because that
// migration seeds `('vitality','dentally-write-back',false,'migration:0096')`
// (the seed itself is pinned by `sync-ledger.test.ts`, and the row was read live
// in production on 3 September 2026). With that row present:
//
//   * `isSystemExplicitlyDisabled` answers TRUE, so the gate's step 2 — the
//     owner's master switch — fires ahead of step 4, the deployment arming, and
//     every refused write is filed `master_off` rather than the `writes_disabled`
//     ruling W1-A/1 (restated by W3/16) describes;
//   * the same boolean drives the owner-facing prose, which used to read
//     "because you have switched it off … turn it back on whenever you are
//     ready" to an owner who had never touched it, about a flip that would send
//     nothing (the connection is the agency's half) while arming their half of a
//     two-key lock over 51,000 real patient records.
//
// The prose is fixed here (see `syncHeadline`). The REASON needs the row's
// `updated_by` to tell an owner's decision from a migration's seed, which lives
// behind `@/lib/systems/repository` and is handed off — so this file asserts
// what the tree actually does, with the divergence named, rather than leaving
// the whole state untested a second time.
//
// NOTHING IS STUBBED THAT MATTERS. The real `isSystemExplicitlyDisabled`, the
// real `isSystemEnabled`, the real `recordWriteIntent`, the real
// `assembleSyncStatus` and the real gate all run against an in-memory database
// carrying the migrations' own column defaults. Only the network client and the
// clock-free bits are doubled.
// ===========================================================================

const fake = createFakeSupabase();

vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => fake.client }));

// The five write METHODS are doubled so that nothing here can put a request on a
// wire even if a refusal ever stopped happening — which is the failure this file
// would otherwise be blind to.
const h = vi.hoisted(() => ({
  client: {
    createPatient: vi.fn(async () => ({ patient: { id: "pat-1" } })),
    updatePatient: vi.fn(async () => ({ patient: { id: "pat-1" } })),
    createAppointment: vi.fn(async () => ({ appointment: { id: "appt-1" } })),
    updateAppointment: vi.fn(async () => ({ appointment: { id: "appt-1" } })),
    cancelAppointment: vi.fn(async () => ({ appointment: { id: "appt-1", state: "cancelled" } })),
  },
  agentClient: vi.fn(),
}));
h.agentClient.mockImplementation(() => h.client);

vi.mock("./write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./write")>();
  return { ...actual, dentallyAgentClient: h.agentClient };
});

import { SyncStatusPanel, type SyncStatusPayloadShape } from "@/components/client/systems/sync-status-view";
import { assembleSyncStatus } from "./sync-status";
import { DentallyWriteRefused, dentallyWrite, precheckDentallyWrite } from "./write-gate";

const ENV_KEYS = [
  "DENTALLY_WRITE_ENABLED",
  "DENTALLY_WRITE_API_KEY",
  "DENTALLY_WRITE_BASE_URL",
  "DENTALLY_BASE_URL",
  "DENTALLY_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

/** Production: a read key, no write arming, and the live practice book as target. */
function productionToday(): void {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.DENTALLY_API_KEY = "read-key";
}

/** The row the write-back migration seeds, exactly as production holds it. */
function seedTheMigrationsRow(): void {
  fake.seed("system_toggle", {
    client_id: "vitality",
    module_slug: "dentally-write-back",
    enabled: false,
    updated_by: "migration:0096",
  });
}

const render = (data: SyncStatusPayloadShape): string =>
  renderToStaticMarkup(createElement(SyncStatusPanel, { data }));

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  fake.reset();
  h.client.cancelAppointment.mockClear();
  h.client.createAppointment.mockClear();
  productionToday();
  seedTheMigrationsRow();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("the write-back migration's seeded row is what every deployment runs on", () => {
  it("seeded-master-row-matches-the-migration-file", () => {
    // The premise of every test below. If the seed is ever dropped or reworded,
    // this file is modelling a database that no longer exists and says so here
    // rather than by quietly passing.
    const sql = readFileSync(
      fileURLToPath(new URL("../../../supabase/migrations/0096_dentally_write_intent.sql", import.meta.url)),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(sql).toContain("insert into system_toggle (client_id, module_slug, enabled, updated_by)");
    expect(sql).toContain("values ('vitality', 'dentally-write-back', false, 'migration:0096')");
  });

  it("seeded-master-row-refuses-a-desk-cancel-and-files-a-blocked-row", async () => {
    // The receptionist's cancel. Recorded first, refused second (W1-A/1), and
    // nothing reaches Dentally.
    const refusal = await precheckDentallyWrite({
      ctx: { source: "patient-status", clientId: "vitality", actor: "u-owner" },
      kind: "appointment.cancel",
      appointmentId: "appt-77",
    });

    expect(refusal, "the gate let a write through on the deployment production runs").toBeInstanceOf(
      DentallyWriteRefused,
    );
    const rows = fake.rows("dentally_write_intent");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "appointment.cancel",
      status: "blocked",
      target: "api.dentally.co",
    });
    // WHAT IT ACTUALLY FILES. W1-A/1 and W3/16 name `writes_disabled`; the seeded
    // row makes step 2 answer first, so the tree files `master_off`. Both are
    // refusals and the fail direction is identical — this asserts the tree's real
    // behaviour so a future `updated_by` fix has a test to flip rather than a
    // silent change of meaning on the practice's own record.
    expect(rows[0].blocked_reason).toBe("master_off");
    expect(h.client.cancelAppointment).not.toHaveBeenCalled();
  });

  it("seeded-master-row-refuses-an-agent-booking-too", async () => {
    // Same gate, a different door: nothing is constructed and nothing is called.
    await expect(
      dentallyWrite.createAppointment(
        { source: "booking-agent", clientId: "vitality", actor: "agent:booking-agent" },
        { patient_id: "pat-9", start_time: "2026-09-10T09:00:00.000Z" },
      ),
    ).rejects.toBeInstanceOf(DentallyWriteRefused);
    expect(h.client.createAppointment).not.toHaveBeenCalled();
    expect(fake.rows("dentally_write_intent")).toHaveLength(1);
  });
});

describe("the Sync Status page never tells an owner they switched off a lever they never touched", () => {
  it("seeded-master-row-headline-names-both-halves-not-just-the-owner", async () => {
    const payload = await assembleSyncStatus("vitality");

    // The switch really is off, and the page still says so — this agrees with
    // the System controls grid, which reads the same row.
    expect(payload.master.off).toBe(true);

    // ...but not as something the owner did, and not as something one flip ends.
    expect(
      payload.headline,
      "an owner was told they had switched off a lever the migration seeded",
    ).not.toMatch(/because you have switched it off/i);
    expect(payload.headline).toMatch(/two separate things are holding it back/i);
    expect(payload.headline).toMatch(/System controls/);
    expect(payload.headline).toMatch(/connection to your Dentally book is not in place/i);
    expect(payload.headline).toMatch(/will not start sending them on its own/i);
  });

  it("seeded-master-row-bullets-do-not-promise-one-flip-sends-anything", async () => {
    const payload = await assembleSyncStatus("vitality");
    const booking = payload.facts.find((f) => f.id === "appointment.create");

    expect(booking?.group).toBe("pending_on_key");
    expect(booking?.detail, "the bullets still said ONE thing you control").not.toMatch(
      /ONE thing you control/,
    );
    expect(booking?.detail).toMatch(/Two things have to be in place/i);
    expect(payload.facts.filter((f) => f.group === "mirrored")).toEqual([]);
  });

  it("seeded-master-row-heading-states-the-switch-without-promising-it-is-enough", async () => {
    // The heading is composed in the browser from `master.off` alone and cannot
    // tell this state from the armed one, so it may stand as a fact and may not
    // give an instruction. Rendered, because that is where a practice meets it.
    const html = render((await assembleSyncStatus("vitality")) as SyncStatusPayloadShape);
    expect(html).toContain("Ready — your write-back switch in System controls is off");
    expect(html).not.toContain("Ready, waiting on your switch in System controls");
  });

  it("CONTROL: armed at the practice's own book, the owner's switch IS the one thing in the way", async () => {
    // The state the three-sentence design was written for. Here the instruction
    // is true and immediately actionable, and it must survive untouched.
    process.env.DENTALLY_WRITE_ENABLED = "true";
    process.env.DENTALLY_WRITE_API_KEY = "write-key";
    process.env.DENTALLY_WRITE_BASE_URL = "https://api.dentally.co";

    const payload = await assembleSyncStatus("vitality");
    expect(payload.master.off).toBe(true);
    expect(payload.headline).toMatch(/because you have switched it off/i);
    expect(payload.headline).toMatch(/Turn Dentally write-back back on in System controls/);
    expect(payload.facts.find((f) => f.id === "appointment.create")?.detail).toMatch(/ONE thing you control/);
  });

  it("CONTROL: with no seeded row at all the page says only the connection is missing", async () => {
    // A database the migration never reached (a developer's machine). The master
    // question is "has somebody turned it off", nobody has, and the sentence is
    // the plain one — so the both-halves wording above is answering the seeded
    // row rather than firing on every dry run.
    fake.reset();
    const payload = await assembleSyncStatus("vitality");
    expect(payload.master.off).toBe(false);
    expect(payload.headline).toMatch(/Nothing this platform does reaches your Dentally book/);
    expect(payload.headline).not.toMatch(/two separate things/i);
  });
});
