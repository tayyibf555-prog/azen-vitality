// AREA 9 (no-show defence): inbound offer resolution must be SITE-SCOPED.
//
// One practice number can serve several sites, so the same patient number may
// hold a live waitlist offer on more than one site at once. A YES/NO reply must
// resolve ONLY against an offer belonging to the site the reply is for, and must
// never flip another site's live offer. We drive the real
// findOpenOfferByAddress against an in-memory Supabase fake (outbox +
// slot_offer rows tagged with site_id) so the query filters are exercised, not
// mocked away.
import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory tables the fake serviceClient reads from.
const db = vi.hoisted(() => ({
  outbox: [] as Array<{ touch_id: string; site_id: string; to_address: string; created_at: string }>,
  offers: [] as Array<Record<string, unknown>>,
}));

// A tiny chainable query builder that honours .eq / .in / .order / .limit
// against one of the in-memory tables, mirroring the subset of the Supabase
// client that findOpenOfferByAddress uses.
function makeBuilder(table: "noshow_outbox" | "noshow_slot_offer") {
  let rows: Array<Record<string, unknown>> =
    table === "noshow_outbox" ? [...db.outbox] : [...db.offers];
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = (col: string, val: unknown) => {
    rows = rows.filter((r) => r[col] === val);
    return builder;
  };
  builder.in = (col: string, vals: unknown[]) => {
    rows = rows.filter((r) => vals.includes(r[col]));
    return builder;
  };
  builder.order = (col: string, opts: { ascending: boolean }) => {
    rows = [...rows].sort((a, b) => {
      const av = String(a[col] ?? "");
      const bv = String(b[col] ?? "");
      return opts.ascending ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    return builder;
  };
  builder.limit = (n: number) => {
    rows = rows.slice(0, n);
    return Promise.resolve({ data: rows, error: null });
  };
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from: (table: string) => makeBuilder(table as "noshow_outbox" | "noshow_slot_offer"),
  }),
}));

import { findOpenOfferByAddress } from "./repository";

const NUMBER = "+447700900001";

function seedTwoSitesSharingNumber() {
  // Site A messaged this number FIRST; site B most recently. Both have a live
  // offer to the same patient number.
  db.outbox = [
    { touch_id: "touch-A", site_id: "site-a", to_address: NUMBER, created_at: "2026-07-01T09:00:00Z" },
    { touch_id: "touch-B", site_id: "site-b", to_address: NUMBER, created_at: "2026-07-01T10:00:00Z" },
  ];
  db.offers = [
    {
      id: "offer-A", site_id: "site-a", waitlist_id: "w-A", dentally_patient_id: "pat-1",
      freed_appointment_id: "appt-A", freed_start_at: "2026-07-02T09:00:00Z", duration_min: 30,
      practitioner: null, touch_id: "touch-A", status: "offered",
      offered_at: "2026-07-01T09:00:00Z", expires_at: "2026-07-01T21:00:00Z", responded_at: null,
    },
    {
      id: "offer-B", site_id: "site-b", waitlist_id: "w-B", dentally_patient_id: "pat-1",
      freed_appointment_id: "appt-B", freed_start_at: "2026-07-02T14:00:00Z", duration_min: 30,
      practitioner: null, touch_id: "touch-B", status: "offered",
      offered_at: "2026-07-01T10:00:00Z", expires_at: "2026-07-01T22:00:00Z", responded_at: null,
    },
  ];
}

beforeEach(() => {
  db.outbox = [];
  db.offers = [];
});

describe("findOpenOfferByAddress site scoping", () => {
  it("resolves the correct site's offer when siteId is given, ignoring the other site's live offer", async () => {
    seedTwoSitesSharingNumber();

    const forA = await findOpenOfferByAddress(NUMBER, "site-a");
    expect(forA?.id).toBe("offer-A");
    expect(forA?.siteId).toBe("site-a");

    const forB = await findOpenOfferByAddress(NUMBER, "site-b");
    expect(forB?.id).toBe("offer-B");
    expect(forB?.siteId).toBe("site-b");
  });

  it("a reply scoped to site A can NEVER flip site B's offer (no cross-site leak)", async () => {
    seedTwoSitesSharingNumber();

    // Site B has NO offer of its own here, only site A does. A reply arriving for
    // site B must resolve nothing rather than grabbing site A's live offer.
    db.offers = db.offers.filter((o) => o.site_id === "site-a");

    const forB = await findOpenOfferByAddress(NUMBER, "site-b");
    expect(forB).toBeNull();

    // Site A still resolves its own offer.
    const forA = await findOpenOfferByAddress(NUMBER, "site-a");
    expect(forA?.id).toBe("offer-A");
  });

  it("when the site is unknown, pins to the most-recent offer SMS's own site (deterministic, single site)", async () => {
    seedTwoSitesSharingNumber();

    // Most recent outbox row is site B's. Without a siteId, resolution must pin
    // to site B and never mix in site A's touch_ids.
    const resolved = await findOpenOfferByAddress(NUMBER);
    expect(resolved?.id).toBe("offer-B");
    expect(resolved?.siteId).toBe("site-b");
  });

  it("unknown-site resolution never returns another site's offer when the pinned site has none", async () => {
    seedTwoSitesSharingNumber();

    // Most recent SMS is site B's, but only site A holds a live offer. Because we
    // pin to site B (the latest SMS), we must return null rather than leaking
    // site A's offer to a reply that most-recently belonged to site B.
    db.offers = db.offers.filter((o) => o.site_id === "site-a");

    const resolved = await findOpenOfferByAddress(NUMBER);
    expect(resolved).toBeNull();
  });
});
