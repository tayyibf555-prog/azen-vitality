import { describe, it, expect, beforeEach, vi } from "vitest";

// ===========================================================================
// DELIVERY: in-app, through the feed that already exists, and NOWHERE ELSE.
//
// The requirement was to surface these in-app by reusing what is there rather
// than building a second alerting surface, so they arrive as items in the
// notifications feed alongside no-show risk, onboarding and new enquiries.
//
// Three things about that path need pinning, and none of them is obvious:
//
//   1. The stored sentence reaches the screen VERBATIM. It is the wording that
//      was true against readings that no longer exist; recomposing or trimming
//      it would quietly change what the practice was told.
//   2. The kill switch hides alerts ALREADY RAISED, not just future ones. A
//      half-revert that stops the pass but leaves yesterday's alerts on screen
//      is not a revert.
//   3. An alert about a headless system arrives with NO link rather than a link
//      to a page that does not show it.
// ===========================================================================

vi.mock("server-only", () => ({}));

let enabled = true;
let openAlerts: Array<Record<string, unknown>> = [];
let alertReadThrows = false;

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async (_client: string, slug: string) =>
    slug === "anomaly-alerts" ? enabled : true,
}));

vi.mock("@/lib/anomaly/repository", () => ({
  listOpenAlerts: async () => {
    if (alertReadThrows) throw new Error("anomaly_alert unreachable");
    return openAlerts;
  },
}));

// The other feed sources are silent here so the assertions are about this one.
vi.mock("@/lib/noshow/repository", () => ({ listTargets: async () => [] }));
vi.mock("@/lib/onboarding/repository", () => ({
  countNewSubmissions: async () => ({ count: 0, newestAt: null }),
}));
vi.mock("@/lib/smile-assessment/repository", () => ({ listResponses: async () => [] }));

import { buildNotifications } from "@/lib/notifications/build";

const CTX = { clientId: "vitality", clientSlug: "vitality", siteIds: ["site-ng"] };

const SENTENCE =
  "Takings over the last 6 days are running at £374 a day, 25% below the £500 a day of the 23 days before that. " +
  "That is about £756 less than the same stretch would normally take. " +
  "Worth checking the diary and the payments page.";

function stored(over: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    kind: "takings_trend",
    severity: "medium",
    dedupeKey: "takings_trend:last7",
    sentence: SENTENCE,
    href: "payments",
    at: "2026-08-21T10:00:00.000Z",
    firstRaisedAt: "2026-08-21T10:00:00.000Z",
    lastSeenAt: "2026-08-21T10:00:00.000Z",
    resolvedAt: null,
    ...over,
  };
}

beforeEach(() => {
  enabled = true;
  alertReadThrows = false;
  openAlerts = [stored()];
});

describe("anomaly alerts in the notifications feed", () => {
  it("carries the stored sentence to the screen, character for character", async () => {
    const [item] = await buildNotifications(CTX);
    expect(item.detail).toBe(SENTENCE);
    expect(item.type).toBe("anomaly");
    expect(item.title).toBe("Worth a look today");
    expect(item.at).toBe("2026-08-21T10:00:00.000Z");
  });

  it("deep-links to the screen that shows the evidence", async () => {
    const [item] = await buildNotifications(CTX);
    expect(item.href).toBe("/c/vitality/payments");
  });

  it("carries NO link for a system with no worklist page yet", async () => {
    openAlerts = [
      stored({
        kind: "approval_backlog",
        dedupeKey: "approval_backlog:balance-reminders",
        href: null,
        sentence: "11 messages are waiting for someone to approve them in Balance reminders.",
      }),
    ];
    const [item] = await buildNotifications(CTX);
    expect(item.href).toBeUndefined();
    expect(item.detail).toContain("Balance reminders");
  });

  it("maps severity onto the feed's own urgency, and titles each band", async () => {
    openAlerts = [
      stored({ id: "a", dedupeKey: "k1", severity: "high" }),
      stored({ id: "b", dedupeKey: "k2", severity: "medium" }),
      stored({ id: "c", dedupeKey: "k3", severity: "low" }),
    ];
    const items = await buildNotifications(CTX);
    expect(items.map((i) => i.urgency)).toEqual(["high", "medium", "low"]);
    expect(items.map((i) => i.title)).toEqual([
      "Needs a look now",
      "Worth a look today",
      "Worth knowing",
    ]);
  });

  it("takes its id from the CONDITION, so a dismiss sticks to the condition", async () => {
    const [item] = await buildNotifications(CTX);
    expect(item.id).toBe("anomaly:takings_trend:last7");
  });

  it("is never sample-tagged: every one of these is real or it is not there", async () => {
    const [item] = await buildNotifications(CTX);
    expect(item.sample).toBeUndefined();
  });

  it("THE KILL SWITCH HIDES ALERTS ALREADY RAISED, not just future ones", async () => {
    expect(await buildNotifications(CTX)).toHaveLength(1);
    enabled = false;
    expect(await buildNotifications(CTX)).toEqual([]);
  });

  it("a failed alert read costs this source and not the whole feed", async () => {
    alertReadThrows = true;
    // safe() in build.ts: the feed still renders, without these items.
    expect(await buildNotifications(CTX)).toEqual([]);
  });

  it("shows nothing at all when there is nothing wrong", async () => {
    openAlerts = [];
    expect(await buildNotifications(CTX)).toEqual([]);
  });
});
