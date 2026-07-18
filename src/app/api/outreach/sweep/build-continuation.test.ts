// Finding #1: a campaign created purely through the co-pilot runs a SINGLE build tick at
// creation, so a large base is left in status 'building' with nothing to finish it but
// the Campaigns UI loop. The sweep now advances 'building' campaigns to 'ready' via an
// UNGATED build-continuation pass at the TOP of the route (BEFORE the send kill switch),
// so a co-pilot-built campaign completes on the 24/7 schedule even with the SEND switch
// OFF. This test pins: (1) builds advance across ticks with the send switch off, (2) the
// send section stays gated, (3) a rate-limit/failed tick ends that campaign's turn, and
// (4) a missing Dentally key skips the pass rather than erroring.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OutreachCampaign } from "@/lib/outreach/types";

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabledForSend: vi.fn(async () => false) }));
vi.mock("@/lib/dentally/read", () => ({ dentallyReadKey: vi.fn(() => "test-key") }));
vi.mock("@/lib/outreach/build", () => ({ runOutreachBuildTickById: vi.fn() }));
vi.mock("@/lib/outreach/draft", () => ({
  draftOutreach: vi.fn(async () => ({ body: "Come back and see us", usedFallback: false })),
}));
vi.mock("@/lib/outreach/repository", () => ({
  listRunningCampaigns: vi.fn(async () => []),
  listBuildingCampaigns: vi.fn(async () => []),
  listDueTargets: vi.fn(async () => []),
  getTarget: vi.fn(async () => null),
  listTouches: vi.fn(async () => []),
  insertTouch: vi.fn(async () => ({ id: "t" })),
  approveTouch: vi.fn(async () => ({})),
  enqueueOutbox: vi.fn(async () => ({})),
  advanceTarget: vi.fn(async () => {}),
  countContactedToday: vi.fn(async () => 0),
}));

import { POST } from "./route";
import { listBuildingCampaigns, listRunningCampaigns, enqueueOutbox } from "@/lib/outreach/repository";
import { runOutreachBuildTickById } from "@/lib/outreach/build";
import { dentallyReadKey } from "@/lib/dentally/read";
import { isSystemEnabledForSend } from "@/lib/systems/repository";

function building(id = "camp-b1"): OutreachCampaign {
  return {
    id,
    clientId: "vitality",
    siteId: "site-cc",
    name: "Co-pilot hygiene list",
    status: "building",
    filters: {},
    practitionerId: null,
    practitionerName: null,
    messageAngle: "a hygiene visit",
    dailyCap: 25,
    buildCursor: null,
    counts: null,
    createdBy: "owner",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

// Minimal BuildTickResult: the continuation only reads ok/done/stopped.
function tick(over: { ok?: boolean; done?: boolean; stopped?: "403" | "429" | null } = {}) {
  return {
    ok: over.ok ?? true,
    done: over.done ?? false,
    stopped: over.stopped ?? null,
    scannedThisRun: 0,
    appointmentReads: 0,
    insertedThisRun: 0,
    counts: {},
    cursor: null,
  };
}

async function sweep() {
  const res = await POST(new Request("http://test/api/outreach/sweep", { method: "POST" }));
  return (await res.json()) as {
    ok: boolean;
    skipped?: string;
    build: { campaigns: number; ticks: number; completed: number; skipped?: string };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET; // authorized() passes outside production
  vi.mocked(dentallyReadKey).mockReturnValue("test-key");
  vi.mocked(isSystemEnabledForSend).mockResolvedValue(false); // SEND off by default
  vi.mocked(listBuildingCampaigns).mockResolvedValue([]);
  vi.mocked(listRunningCampaigns).mockResolvedValue([]);
});

describe("outreach sweep build-continuation (finding #1)", () => {
  it("advances a building campaign across ticks until done — with the SEND switch OFF", async () => {
    vi.mocked(listBuildingCampaigns).mockResolvedValue([building()]);
    vi.mocked(runOutreachBuildTickById)
      .mockResolvedValueOnce(tick({ done: false }))
      .mockResolvedValueOnce(tick({ done: false }))
      .mockResolvedValueOnce(tick({ done: true })); // build path flips it to 'ready'

    const out = await sweep();

    // Send stayed gated (system off), but the build pass still ran to completion.
    expect(out.skipped).toBe("system off");
    expect(vi.mocked(runOutreachBuildTickById)).toHaveBeenCalledTimes(3);
    expect(out.build.ticks).toBe(3);
    expect(out.build.completed).toBe(1);
    // Never reached the send section.
    expect(vi.mocked(listRunningCampaigns)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueOutbox)).not.toHaveBeenCalled();
  });

  it("is NOT gated by the send kill switch (checks build before isSystemEnabledForSend)", async () => {
    vi.mocked(listBuildingCampaigns).mockResolvedValue([building()]);
    vi.mocked(runOutreachBuildTickById).mockResolvedValue(tick({ done: true }));
    await sweep();
    // The build tick ran even though the send switch is off.
    expect(vi.mocked(runOutreachBuildTickById)).toHaveBeenCalled();
  });

  it("ends a campaign's turn on a rate-limit stop and resumes next sweep", async () => {
    vi.mocked(listBuildingCampaigns).mockResolvedValue([building()]);
    vi.mocked(runOutreachBuildTickById)
      .mockResolvedValueOnce(tick({ done: false }))
      .mockResolvedValueOnce(tick({ done: false, stopped: "429" }));

    const out = await sweep();

    expect(vi.mocked(runOutreachBuildTickById)).toHaveBeenCalledTimes(2); // stopped -> break
    expect(out.build.completed).toBe(0);
  });

  it("skips the pass (no ticks) when the Dentally key is missing", async () => {
    vi.mocked(dentallyReadKey).mockReturnValue(""); // no key
    vi.mocked(listBuildingCampaigns).mockResolvedValue([building()]);

    const out = await sweep();

    expect(vi.mocked(runOutreachBuildTickById)).not.toHaveBeenCalled();
    expect(out.build.skipped).toBe("no dentally key");
  });

  it("runs the build pass and then the send pass when the switch is ON", async () => {
    vi.mocked(isSystemEnabledForSend).mockResolvedValue(true);
    vi.mocked(listBuildingCampaigns).mockResolvedValue([]); // nothing building
    vi.mocked(listRunningCampaigns).mockResolvedValue([]); // nothing running

    const out = await sweep();

    expect(out.skipped).toBeUndefined();
    expect(vi.mocked(listRunningCampaigns)).toHaveBeenCalled(); // reached the send section
    expect(out.build.campaigns).toBe(0);
  });
});
