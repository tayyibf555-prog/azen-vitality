import { describe, it, expect, vi, beforeEach } from "vitest";

// recordPublishResult and insertMetaCampaignInsight against a captured, chainable mock of
// the service-role client. The key guarantees: on SUCCESS the row advances to 'published'
// with the refs + published_at; on FAILURE the status is NEVER touched (it stays ready)
// and publish_error carries the honest reason, while partial refs are still stored.

const captured = vi.hoisted(() => ({
  updates: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
}));

function baseRow(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "camp-uuid",
    client_id: "vitality",
    site_id: "site-cc",
    name: "Invisalign (leads)",
    treatment: "invisalign",
    objective: "leads",
    status: "ready",
    radius_miles: null,
    daily_budget_gbp: 20,
    audience_notes: null,
    transparent_pricing: false,
    from_price_gbp: null,
    negative_keywords: [],
    landing_slug: "invisalign-demo",
    copy: {},
    created_by: "owner",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    meta_campaign_ref: null,
    meta_adset_ref: null,
    meta_ad_ref: null,
    published_at: null,
    publish_error: null,
    ...patch,
  };
}

vi.mock("@/lib/supabase/server", () => {
  function from() {
    let lastPatch: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      update(patch: Record<string, unknown>) {
        lastPatch = patch;
        captured.updates.push(patch);
        return builder;
      },
      insert(row: Record<string, unknown>) {
        captured.inserts.push(row);
        return builder;
      },
      eq() {
        return builder;
      },
      select() {
        return builder;
      },
      not() {
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle() {
        return Promise.resolve({ data: baseRow(lastPatch), error: null });
      },
      // Thenable so `await db.from(t).insert(...)` resolves to {error:null}.
      then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
        return resolve({ data: null, error: null });
      },
    };
    return builder;
  }
  return { serviceClient: () => ({ from }) };
});

import { recordPublishResult, insertMetaCampaignInsight } from "./repository";

beforeEach(() => {
  captured.updates.length = 0;
  captured.inserts.length = 0;
});

describe("recordPublishResult - success", () => {
  it("advances to 'published' with refs, published_at, and note as publish_error", async () => {
    await recordPublishResult("camp-uuid", {
      ok: true,
      metaCampaignRef: "camp_1",
      metaAdsetRef: "adset_1",
      metaAdRef: "ad_1",
      note: "Radius targeting was not applied.",
    });
    const patch = captured.updates[0];
    expect(patch.status).toBe("published");
    expect(patch.meta_campaign_ref).toBe("camp_1");
    expect(patch.meta_adset_ref).toBe("adset_1");
    expect(patch.meta_ad_ref).toBe("ad_1");
    expect(patch.published_at).toBeTruthy();
    expect(patch.publish_error).toBe("Radius targeting was not applied.");
  });

  it("stores a null publish_error when there is no note", async () => {
    await recordPublishResult("camp-uuid", { ok: true, metaCampaignRef: "camp_1", note: null });
    expect(captured.updates[0].publish_error).toBeNull();
  });
});

describe("recordPublishResult - failure", () => {
  it("NEVER advances status to published and records the honest error + partial refs", async () => {
    await recordPublishResult("camp-uuid", {
      ok: false,
      metaCampaignRef: "camp_1", // created before the failure
      metaAdsetRef: null,
      error: "Meta: Invalid parameter (code 100)",
    });
    const patch = captured.updates[0];
    // status is deliberately absent from the patch: it stays whatever it was ('ready').
    expect(patch.status).toBeUndefined();
    expect(patch.published_at).toBeNull();
    expect(patch.publish_error).toBe("Meta: Invalid parameter (code 100)");
    // The partial campaign ref is kept so the object is not orphaned invisibly.
    expect(patch.meta_campaign_ref).toBe("camp_1");
    expect(patch.meta_adset_ref).toBeNull();
  });

  it("defaults publish_error to a generic message when none is given", async () => {
    await recordPublishResult("camp-uuid", { ok: false });
    expect(captured.updates[0].publish_error).toBe("publish failed");
  });
});

describe("insertMetaCampaignInsight", () => {
  it("inserts one snapshot row with the mapped columns", async () => {
    await insertMetaCampaignInsight({
      campaignId: "camp-uuid",
      spendGbp: 123.45,
      impressions: 10000,
      clicks: 250,
      leads: 7,
      raw: { data: [] },
    });
    expect(captured.inserts).toHaveLength(1);
    expect(captured.inserts[0]).toEqual({
      campaign_id: "camp-uuid",
      spend_gbp: 123.45,
      impressions: 10000,
      clicks: 250,
      leads: 7,
      raw: { data: [] },
    });
  });
});
