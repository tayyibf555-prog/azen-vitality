import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The twelve-source correspondence read, against a SCHEMA-STRICT fake database.
 *
 * WHY STRICT. Every defect this test exists to catch is a column-name defect, and a
 * permissive fake catches none of them: selecting `direction` from a table that has
 * no such column, or filtering `site_id` on a table that is scoped only through its
 * parent, both succeed against a loose mock and both return a Postgres error in
 * production — where the read is caught per source and degrades into "part of this
 * patient's message history could not be read", quietly, forever.
 *
 * So TABLE_COLUMNS below is transcribed from supabase/migrations (and, for
 * reactivation_touch, which was created out-of-band, from the row interface in
 * src/lib/reactivation/repository.ts). The fake refuses any select or filter naming a
 * column outside it, exactly as Postgres would. That makes this file a check of the
 * source registry against the real schema, not just of the mapping code.
 */

const store = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  failTables: new Set<string>(),
  queries: [] as Array<{ table: string; columns: string[]; filters: Array<[string, string, unknown]> }>,
}));

/** Column lists, from the migrations. Only what this read touches has to be here. */
const TABLE_COLUMNS: Record<string, string[]> = {
  agent_conversation: ["id", "site_id", "dentally_patient_id", "patient_name", "channel", "updated_at"],
  agent_message: ["id", "conversation_id", "role", "body", "created_at"],

  reactivation_touch: ["id", "target_id", "cadence_id", "site_id", "step", "channel", "direction", "body", "drafted_by", "status", "approved_by", "created_at", "sent_at"],
  reactivation_target: ["id", "site_id", "dentally_patient_id", "patient_name"],

  recall_touch: ["id", "target_id", "cadence_id", "site_id", "step", "channel", "direction", "body", "drafted_by", "status", "approved_by", "created_at", "sent_at"],
  recall_target: ["id", "site_id", "dentally_patient_id", "patient_name"],

  noshow_touch: ["id", "target_id", "cadence_id", "site_id", "step", "channel", "direction", "body", "drafted_by", "status", "approved_by", "created_at", "sent_at"],
  noshow_target: ["id", "site_id", "dentally_patient_id", "patient_name"],

  coordinator_touch: ["id", "opportunity_id", "site_id", "channel", "direction", "body", "drafted_by", "status", "approved_by", "created_at", "sent_at"],
  closer_touch: ["id", "opportunity_id", "site_id", "step", "channel", "direction", "body", "drafted_by", "status", "approved_by", "created_at", "sent_at"],
  treatment_opportunity: ["id", "site_id", "dentally_patient_id", "dentally_plan_id", "patient_name", "treatment", "status"],

  postop_touch: ["id", "target_id", "site_id", "channel", "direction", "body", "status", "actioned_by", "created_at", "sent_at"],
  postop_target: ["id", "site_id", "dentally_patient_id", "appointment_id", "patient_name", "status"],

  // NOTE: no actor column at all. The pre-visit link has no approval step (see
  // migration 0097), so there is no person to name and the source declares
  // actorCol: null rather than inventing one.
  previsit_touch: ["id", "target_id", "site_id", "channel", "direction", "body", "status", "created_at", "sent_at"],
  previsit_target: ["id", "site_id", "dentally_patient_id", "appointment_id", "patient_name", "fork", "status"],

  review_touch: ["id", "request_id", "site_id", "step", "channel", "direction", "body", "drafted_by", "status", "approved_by", "created_at", "sent_at"],
  review_request: ["id", "site_id", "dentally_appointment_id", "dentally_patient_id", "patient_name", "channel", "status"],

  collection_touch: ["id", "patient_id", "site_id", "step", "channel", "direction", "body", "drafted_by", "status", "approved_by", "discard_reason", "amount_pence", "created_at", "sent_at"],

  outreach_touch: ["id", "target_id", "campaign_id", "site_id", "step", "channel", "direction", "body", "drafted_by", "status", "approved_by", "created_at", "sent_at"],
  outreach_target: ["id", "campaign_id", "patient_id", "name", "phone", "site_id", "status"],

  diary_touch: ["id", "move_id", "site_id", "channel", "direction", "body", "drafted_by", "status", "approved_by", "created_at", "sent_at"],
  diary_move: ["id", "client_id", "site_id", "appointment_id", "patient_id", "outcome", "created_at"],

  // NOTE: no site_id and no direction. This is the shape that breaks a uniform reader.
  speed_to_lead_attempt: ["id", "lead_id", "channel", "to_address", "body", "status", "provider", "provider_message_id", "created_at"],
  speed_to_lead_lead: ["id", "site_id", "dentally_patient_id", "name", "email", "phone", "channel", "stage", "updated_at"],
};

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from(table: string) {
      const q = { table, columns: [] as string[], filters: [] as Array<[string, string, unknown]> };
      const api: Record<string, unknown> = {
        select(cols: string) {
          q.columns = cols.split(",").map((c) => c.trim()).filter(Boolean);
          return api;
        },
        in(k: string, v: unknown[]) {
          q.filters.push(["in", k, v]);
          return api;
        },
        eq(k: string, v: unknown) {
          q.filters.push(["eq", k, v]);
          return api;
        },
        order: () => api,
        limit: () => api,
        overrideTypes: () => api,
        then(resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve(run(q)).then(resolve, reject);
        },
      };
      return api;
    },
  }),
}));

function run(q: { table: string; columns: string[]; filters: Array<[string, string, unknown]> }) {
  store.queries.push(q);
  if (store.failTables.has(q.table)) {
    return { data: null, error: { message: `simulated outage on ${q.table}` } };
  }
  const known = TABLE_COLUMNS[q.table];
  if (!known) return { data: null, error: { message: `relation "${q.table}" does not exist` } };
  for (const c of q.columns) {
    if (!known.includes(c)) {
      return { data: null, error: { message: `column ${q.table}.${c} does not exist` } };
    }
  }
  for (const [, col] of q.filters) {
    if (!known.includes(col)) {
      return { data: null, error: { message: `column ${q.table}.${col} does not exist` } };
    }
  }
  const rows = (store.tables[q.table] ?? []).filter((r) =>
    q.filters.every(([op, col, val]) =>
      op === "in" ? (val as unknown[]).includes(r[col]) : r[col] === val,
    ),
  );
  return { data: rows.map((r) => ({ ...r })), error: null };
}

import { getThreadForPatient } from "./repository";

const SITE = "site-n15";
const PATIENT = "pat-001";

function seed(tables: Record<string, Array<Record<string, unknown>>>) {
  store.tables = tables;
}

beforeEach(() => {
  store.tables = {};
  store.failTables = new Set();
  store.queries = [];
});

describe("every module the platform can message from", () => {
  it("reads a message from ALL thirteen sources for one patient", async () => {
    seed({
      agent_conversation: [{ id: "c1", site_id: SITE, dentally_patient_id: PATIENT, patient_name: "Sarah", channel: "sms", updated_at: "2026-06-01T09:00:00Z" }],
      agent_message: [{ id: "m1", conversation_id: "c1", role: "patient", body: "agent-msg", created_at: "2026-06-01T09:00:00Z" }],

      reactivation_target: [{ id: "rt1", site_id: SITE, dentally_patient_id: PATIENT, patient_name: "Sarah" }],
      reactivation_touch: [{ id: "t1", target_id: "rt1", site_id: SITE, channel: "sms", direction: "outbound", body: "reactivation-msg", status: "sent", approved_by: "Blerta", created_at: "2026-06-02T09:00:00Z", sent_at: "2026-06-02T09:05:00Z" }],

      recall_target: [{ id: "rc1", site_id: SITE, dentally_patient_id: PATIENT, patient_name: "Sarah" }],
      recall_touch: [{ id: "t2", target_id: "rc1", site_id: SITE, channel: "sms", direction: "outbound", body: "recall-msg", status: "sent", approved_by: null, created_at: "2026-06-03T09:00:00Z", sent_at: null }],

      noshow_target: [{ id: "ns1", site_id: SITE, dentally_patient_id: PATIENT, patient_name: "Sarah" }],
      noshow_touch: [{ id: "t3", target_id: "ns1", site_id: SITE, channel: "sms", direction: "outbound", body: "noshow-msg", status: "sent", approved_by: null, created_at: "2026-06-04T09:00:00Z", sent_at: null }],

      treatment_opportunity: [{ id: "op1", site_id: SITE, dentally_patient_id: PATIENT, patient_name: "Sarah" }],
      coordinator_touch: [{ id: "t4", opportunity_id: "op1", site_id: SITE, channel: "sms", direction: "outbound", body: "coordinator-msg", status: "sent", approved_by: "Blerta", created_at: "2026-06-05T09:00:00Z", sent_at: null }],
      closer_touch: [{ id: "t5", opportunity_id: "op1", site_id: SITE, channel: "sms", direction: "outbound", body: "closer-msg", status: "sent", approved_by: "Jawad", created_at: "2026-06-06T09:00:00Z", sent_at: null }],

      postop_target: [{ id: "po1", site_id: SITE, dentally_patient_id: PATIENT, patient_name: "Sarah" }],
      postop_touch: [{ id: "t6", target_id: "po1", site_id: SITE, channel: "sms", direction: "outbound", body: "postop-msg", status: "sent", actioned_by: "Blerta", created_at: "2026-06-07T09:00:00Z", sent_at: null }],

      previsit_target: [{ id: "pv1", site_id: SITE, dentally_patient_id: PATIENT, patient_name: "Sarah", fork: "brief" }],
      previsit_touch: [{ id: "t11", target_id: "pv1", site_id: SITE, channel: "sms", direction: "outbound", body: "previsit-msg", status: "sent", created_at: "2026-06-13T09:00:00Z", sent_at: null }],

      review_request: [{ id: "rr1", site_id: SITE, dentally_patient_id: PATIENT, patient_name: "Sarah" }],
      review_touch: [{ id: "t7", request_id: "rr1", site_id: SITE, channel: "sms", direction: "outbound", body: "reviews-msg", status: "sent", approved_by: null, created_at: "2026-06-08T09:00:00Z", sent_at: null }],

      collection_touch: [{ id: "t8", patient_id: PATIENT, site_id: SITE, channel: "sms", direction: "outbound", body: "collection-msg", status: "sent", approved_by: "Blerta", created_at: "2026-06-09T09:00:00Z", sent_at: null }],

      outreach_target: [{ id: "ot1", site_id: SITE, patient_id: PATIENT, name: "Sarah" }],
      outreach_touch: [{ id: "t9", target_id: "ot1", site_id: SITE, channel: "email", direction: "outbound", body: "outreach-msg", status: "sent", approved_by: null, created_at: "2026-06-10T09:00:00Z", sent_at: null }],

      diary_move: [{ id: "dm1", site_id: SITE, patient_id: PATIENT }],
      diary_touch: [{ id: "t10", move_id: "dm1", site_id: SITE, channel: "sms", direction: "outbound", body: "diary-msg", status: "sent", approved_by: "Blerta", created_at: "2026-06-11T09:00:00Z", sent_at: null }],

      speed_to_lead_lead: [{ id: "l1", site_id: SITE, dentally_patient_id: PATIENT, name: "Sarah" }],
      speed_to_lead_attempt: [{ id: "a1", lead_id: "l1", channel: "sms", body: "speed-to-lead-msg", status: "sent", created_at: "2026-06-12T09:00:00Z" }],
    });

    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.failedSourceNames, "a source errored against the real schema").toEqual([]);
    expect(read.totalSources).toBe(13);
    const sources = (read.thread?.messages ?? []).map((m) => m.source).sort();
    expect(sources).toEqual([
      "agent", "closer", "collection", "coordinator", "diary", "noshow",
      "outreach", "postop", "previsit", "reactivation", "recall", "reviews", "speed-to-lead",
    ]);
  });

  it("never asks speed_to_lead_attempt for a site_id it does not have", async () => {
    // The single most likely production break in this change: the attempt log is
    // site-scoped ONLY through its lead, and a uniform reader that filters site_id
    // on every touch table would error here and nowhere else.
    seed({
      speed_to_lead_lead: [{ id: "l1", site_id: SITE, dentally_patient_id: PATIENT, name: "Sarah" }],
      speed_to_lead_attempt: [{ id: "a1", lead_id: "l1", channel: "sms", body: "hello", status: "sent", created_at: "2026-06-12T09:00:00Z" }],
    });
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.failedSourceNames).toEqual([]);
    const attemptQueries = store.queries.filter((q) => q.table === "speed_to_lead_attempt");
    expect(attemptQueries.length).toBeGreaterThan(0);
    for (const q of attemptQueries) {
      expect(q.columns).not.toContain("site_id");
      expect(q.columns).not.toContain("direction");
      expect(q.filters.map(([, col]) => col)).not.toContain("site_id");
    }
    // Still correctly scoped: the LEAD carried the site filter.
    const leadQueries = store.queries.filter((q) => q.table === "speed_to_lead_lead");
    expect(leadQueries.some((q) => q.filters.some(([, col]) => col === "site_id"))).toBe(true);
  });

  it("reads outreach through its own column names, not the older modules'", async () => {
    seed({
      outreach_target: [{ id: "ot1", site_id: SITE, patient_id: PATIENT, name: "Sarah Lindqvist" }],
      outreach_touch: [{ id: "t9", target_id: "ot1", site_id: SITE, channel: "email", direction: "outbound", body: "campaign", status: "sent", approved_by: null, created_at: "2026-06-10T09:00:00Z", sent_at: null }],
    });
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.failedSourceNames).toEqual([]);
    expect(read.thread?.messages[0].contactName).toBe("Sarah Lindqvist");
  });

  it("reads the balance reminder straight off the touch row, which has no parent", async () => {
    seed({
      collection_touch: [{ id: "t8", patient_id: PATIENT, site_id: SITE, channel: "sms", direction: "outbound", body: "You have £240 outstanding.", status: "sent", approved_by: "Blerta", created_at: "2026-06-09T09:00:00Z", sent_at: null }],
    });
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.failedSourceNames).toEqual([]);
    expect(read.thread?.messages[0].body).toContain("£240");
    expect(read.thread?.messages[0].actionedBy).toBe("Blerta");
  });
});

describe("what a message row is allowed to claim", () => {
  function seedOneCloser(status: string, extra: Record<string, unknown> = {}) {
    seed({
      treatment_opportunity: [{ id: "op1", site_id: SITE, dentally_patient_id: PATIENT, patient_name: "Sarah" }],
      closer_touch: [{ id: "t5", opportunity_id: "op1", site_id: SITE, channel: "sms", direction: "outbound", body: "the message", status, approved_by: "Jawad", created_at: "2026-06-06T09:00:00Z", sent_at: null, ...extra }],
    });
  }

  it("shows a FAILED message, and says it was not delivered", async () => {
    // Before this change a failed message rendered byte-for-byte like a delivered
    // one, so a coordinator read the words and concluded the patient had been told.
    seedOneCloser("failed");
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.thread?.messages[0].status).toBe("failed");
  });

  it("hides a DRAFT: it was never said to the patient", async () => {
    seedOneCloser("draft");
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.thread).toBeNull();
  });

  it("hides a DISCARDED draft: a human deliberately killed it", async () => {
    seedOneCloser("discarded");
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.thread).toBeNull();
  });

  it("shows an approved-but-unsent message as waiting, not as sent", async () => {
    seedOneCloser("approved");
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.thread?.messages[0].status).toBe("queued");
  });

  it("keeps an unrecognised status rather than dropping the message or upgrading it", async () => {
    seedOneCloser("delivered_probably");
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.thread?.messages[0].status).toBe("unknown");
  });

  it("dates a message by when it LEFT, not when it was drafted", async () => {
    // A draft written Monday and approved Wednesday belongs on Wednesday in a
    // record of what was said to the patient.
    seedOneCloser("sent", { sent_at: "2026-06-08T14:00:00Z" });
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.thread?.messages[0].at).toBe("2026-06-08T14:00:00Z");
  });

  it("falls back to created_at when the message never left", async () => {
    seedOneCloser("failed");
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.thread?.messages[0].at).toBe("2026-06-06T09:00:00Z");
  });

  it("carries the approver, which is the question a complaint actually asks", async () => {
    seedOneCloser("sent");
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.thread?.messages[0].actionedBy).toBe("Jawad");
  });

  it("reads the aftercare check-in's actioned_by, which is named differently", async () => {
    seed({
      postop_target: [{ id: "po1", site_id: SITE, dentally_patient_id: PATIENT, patient_name: "Sarah" }],
      postop_touch: [{ id: "t6", target_id: "po1", site_id: SITE, channel: "sms", direction: "outbound", body: "How are you healing?", status: "sent", actioned_by: "Blerta", created_at: "2026-06-07T09:00:00Z", sent_at: null }],
    });
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.failedSourceNames).toEqual([]);
    expect(read.thread?.messages[0].actionedBy).toBe("Blerta");
  });
});

describe("scoping and failure reporting", () => {
  it("does not leak another site's messages onto the record", async () => {
    seed({
      collection_touch: [
        { id: "mine", patient_id: PATIENT, site_id: SITE, channel: "sms", direction: "outbound", body: "mine", status: "sent", approved_by: null, created_at: "2026-06-09T09:00:00Z", sent_at: null },
        { id: "theirs", patient_id: PATIENT, site_id: "site-other", channel: "sms", direction: "outbound", body: "theirs", status: "sent", approved_by: null, created_at: "2026-06-09T10:00:00Z", sent_at: null },
      ],
    });
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.thread?.messages.map((m) => m.body)).toEqual(["mine"]);
  });

  it("does not put another patient's messages on this record", async () => {
    seed({
      collection_touch: [
        { id: "mine", patient_id: PATIENT, site_id: SITE, channel: "sms", direction: "outbound", body: "mine", status: "sent", approved_by: null, created_at: "2026-06-09T09:00:00Z", sent_at: null },
        { id: "theirs", patient_id: "pat-999", site_id: SITE, channel: "sms", direction: "outbound", body: "theirs", status: "sent", approved_by: null, created_at: "2026-06-09T10:00:00Z", sent_at: null },
      ],
    });
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.thread?.messages.map((m) => m.body)).toEqual(["mine"]);
  });

  it("NAMES the source that failed, and keeps the rest", async () => {
    seed({
      collection_touch: [{ id: "t8", patient_id: PATIENT, site_id: SITE, channel: "sms", direction: "outbound", body: "balance", status: "sent", approved_by: null, created_at: "2026-06-09T09:00:00Z", sent_at: null }],
      recall_target: [{ id: "rc1", site_id: SITE, dentally_patient_id: PATIENT, patient_name: "Sarah" }],
      recall_touch: [{ id: "t2", target_id: "rc1", site_id: SITE, channel: "sms", direction: "outbound", body: "recall", status: "sent", approved_by: null, created_at: "2026-06-03T09:00:00Z", sent_at: null }],
    });
    store.failTables.add("recall_touch");
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.failedSourceNames).toEqual(["recall"]);
    expect(read.thread?.messages.map((m) => m.body)).toEqual(["balance"]);
  });

  it("reports a total failure as a failure, not as 'nothing was ever sent'", async () => {
    seed({ collection_touch: [] });
    for (const t of Object.keys(TABLE_COLUMNS)) store.failTables.add(t);
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.thread).toBeNull();
    expect(read.failedSources).toBe(read.totalSources);
    expect(read.failedSourceNames).toHaveLength(13);
  });

  it("distinguishes a genuine empty from a failure", async () => {
    seed({});
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.thread).toBeNull();
    expect(read.failedSourceNames).toEqual([]);
  });

  it("drops a diary notification whose move carries no patient, rather than guessing", async () => {
    seed({
      diary_move: [{ id: "dm1", site_id: SITE, patient_id: null }],
      diary_touch: [{ id: "t10", move_id: "dm1", site_id: SITE, channel: "sms", direction: "outbound", body: "moved", status: "sent", approved_by: null, created_at: "2026-06-11T09:00:00Z", sent_at: null }],
    });
    const read = await getThreadForPatient([SITE], PATIENT);
    expect(read.failedSourceNames).toEqual([]);
    expect(read.thread).toBeNull();
  });
});
