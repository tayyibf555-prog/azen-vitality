// The scheduled landing-page auto-promotion sweep. It must promote a settled winner
// on the SAME criteria the results-card read path uses (the real decideAutoPromotion,
// left unmocked here), only for eligible pages, and be idempotent + cron-authed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LandingPage } from "@/lib/landing/types";
import type { VariantCounters } from "@/lib/landing/winner";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/landing/repository", () => ({
  listPages: vi.fn(async () => []),
  getPageBySlug: vi.fn(async () => null),
  promoteWinner: vi.fn(async () => {}),
}));
vi.mock("@/lib/funnel/events", () => ({
  funnelVariantSummary: vi.fn(async () => ({
    a: { views: 0, ctaClicks: 0, leads: 0 },
    b: { views: 0, ctaClicks: 0, leads: 0 },
  })),
}));

import { POST } from "./route";
import { listPages, getPageBySlug, promoteWinner } from "@/lib/landing/repository";
import { funnelVariantSummary } from "@/lib/funnel/events";

function landingPage(overrides: Partial<LandingPage>): LandingPage {
  return {
    id: "page-x",
    clientId: "vitality",
    siteId: null,
    slug: "slug-x",
    treatment: "invisalign",
    campaignRef: null,
    status: "live",
    winnerVariant: null,
    autoPromote: true,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// A clear win for A (both variants clear the 800-view floor; A's lead rate is far
// higher, and 25 combined leads keep this on the lead-rate signal).
const CLEAR_WIN: { a: VariantCounters; b: VariantCounters } = {
  a: { views: 1000, ctaClicks: 40, leads: 20 },
  b: { views: 1000, ctaClicks: 10, leads: 5 },
};
// Too close to call (relative lift well under the 25% gate), also above the floor.
const TOO_CLOSE: { a: VariantCounters; b: VariantCounters } = {
  a: { views: 1000, ctaClicks: 22, leads: 11 },
  b: { views: 1000, ctaClicks: 20, leads: 10 },
};

function arrangePages(pages: LandingPage[]) {
  vi.mocked(listPages).mockResolvedValue(pages);
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  vi.mocked(getPageBySlug).mockImplementation(async (_clientId: string, slug: string) =>
    bySlug.has(slug) ? { page: bySlug.get(slug)!, variants: [] } : null,
  );
}

function arrangeCounters(map: Record<string, { a: VariantCounters; b: VariantCounters }>) {
  vi.mocked(funnelVariantSummary).mockImplementation(
    async (args: { landingSlug: string }) =>
      map[args.landingSlug] ?? { a: { views: 0, ctaClicks: 0, leads: 0 }, b: { views: 0, ctaClicks: 0, leads: 0 } },
  );
}

async function sweep(request?: Request) {
  const res = await POST(request ?? new Request("http://test/api/landing-pages/promote-sweep", { method: "POST" }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET; // cronUnauthorized: authorized outside production when unset
});

describe("landing promote sweep", () => {
  it("promotes the winner when the criteria are met", async () => {
    arrangePages([landingPage({ id: "p1", slug: "invisalign" })]);
    arrangeCounters({ invisalign: CLEAR_WIN });

    const { body } = await sweep();

    expect(vi.mocked(promoteWinner)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(promoteWinner)).toHaveBeenCalledWith("p1", "vitality", "a");
    expect(body).toMatchObject({ ok: true, scanned: 1, promoted: 1 });
  });

  it("does NOT promote when the variants are too close to call", async () => {
    arrangePages([landingPage({ id: "p1", slug: "invisalign" })]);
    arrangeCounters({ invisalign: TOO_CLOSE });

    const { body } = await sweep();

    expect(vi.mocked(promoteWinner)).not.toHaveBeenCalled();
    expect(body).toMatchObject({ ok: true, scanned: 1, promoted: 0 });
  });

  it("skips ineligible pages: auto_promote off, already-won (idempotent), and not-live", async () => {
    arrangePages([
      landingPage({ id: "manual", slug: "veneers", autoPromote: false }),
      landingPage({ id: "won", slug: "whitening", winnerVariant: "a" }),
      landingPage({ id: "draft", slug: "implants", status: "draft" }),
    ]);
    // Every page would be a clear win IF it were eligible — proving the skip is the
    // eligibility filter, not the decision.
    arrangeCounters({ veneers: CLEAR_WIN, whitening: CLEAR_WIN, implants: CLEAR_WIN });

    const { body } = await sweep();

    expect(vi.mocked(funnelVariantSummary)).not.toHaveBeenCalled();
    expect(vi.mocked(promoteWinner)).not.toHaveBeenCalled();
    expect(body).toMatchObject({ ok: true, scanned: 0, promoted: 0 });
  });

  it("only evaluates the eligible candidate among a mixed set", async () => {
    arrangePages([
      landingPage({ id: "p1", slug: "invisalign" }), // eligible
      landingPage({ id: "manual", slug: "veneers", autoPromote: false }),
      landingPage({ id: "won", slug: "whitening", winnerVariant: "b" }),
    ]);
    arrangeCounters({ invisalign: CLEAR_WIN, veneers: CLEAR_WIN, whitening: CLEAR_WIN });

    await sweep();

    expect(vi.mocked(funnelVariantSummary)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(funnelVariantSummary)).toHaveBeenCalledWith(
      expect.objectContaining({ landingSlug: "invisalign", surface: "landing" }),
    );
    expect(vi.mocked(promoteWinner)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(promoteWinner)).toHaveBeenCalledWith("p1", "vitality", "a");
  });

  it("rejects an unauthorized cron call and does no work", async () => {
    process.env.CRON_SECRET = "top-secret";
    arrangePages([landingPage({ id: "p1", slug: "invisalign" })]);
    arrangeCounters({ invisalign: CLEAR_WIN });

    const { status } = await sweep(
      new Request("http://test/api/landing-pages/promote-sweep", { method: "POST" }), // no Authorization header
    );

    expect(status).toBe(401);
    expect(vi.mocked(listPages)).not.toHaveBeenCalled();
    expect(vi.mocked(promoteWinner)).not.toHaveBeenCalled();
    delete process.env.CRON_SECRET;
  });
});
