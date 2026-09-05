import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InterestRecord } from "@/lib/triage/types";

// ===========================================================================
// THE INTEREST LIST EXPORT (ruling W3/10).
//
// Every "yes" on the pre-visit form lands on a per-treatment list, and nothing in
// the platform could target one: the outreach segment builder pages Dentally and
// never reads treatment_interest, and its `treatmentContains` matches PAST
// appointment reason text — the inverse population. W3/10's minimum is this file
// of named patients, per treatment, for the owner and the practice manager.
//
// A FILE OF NAMED PATIENTS IS NOT A PAGE VIEW, so the guards are tested as hard
// as the contents: the REAL requireModuleApiAccess, requireApproverRole and
// requireClientAccess run here, and only the session read and the database are
// faked.
// ===========================================================================

vi.mock("server-only", () => ({}));

const store = vi.hoisted(() => ({
  user: null as unknown,
  systemOn: true,
  rows: [] as unknown[],
  readThrows: false,
  listArgs: null as null | Record<string, unknown>,
  scope: { siteIds: ["site-cc"], selection: "site-cc", isAllSites: false, siteName: "N15 Vitality Dental", label: "N15 Vitality Dental" },
}));

// PARTIAL mock: the real guards run — they are what this file is about — and only
// the session read is faked.
vi.mock("@/lib/auth/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guard")>();
  return { ...actual, requireUser: async () => store.user };
});
vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
  getSite: (id: string) =>
    id === "site-cc" ? { id, clientId: "vitality", name: "N15 Vitality Dental" } : undefined,
}));
vi.mock("@/lib/site-view", () => ({ getViewScope: async () => store.scope }));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => store.systemOn }));
vi.mock("@/lib/triage/repository", () => ({
  listInterest: async (args: Record<string, unknown>) => {
    store.listArgs = args;
    if (store.readThrows) throw new Error("db down");
    return store.rows;
  },
}));

import { GET } from "./route";

function owner() {
  return { id: "u1", role: "client_owner", clientId: "vitality", siteIds: ["site-cc"] };
}

function row(over: Partial<InterestRecord> = {}): InterestRecord {
  return {
    id: "i-1",
    siteId: "site-cc",
    dentallyPatientId: "p-1",
    patientName: "Alex Berry",
    treatment: "whitening",
    answer: "yes",
    responseId: "r-1",
    createdAt: "2026-09-03T09:00:00.000Z",
    ...over,
  };
}

async function get(query = "client=vitality&treatment=whitening"): Promise<Response> {
  return GET(new Request(`http://localhost/api/previsit/interest/export?${query}`));
}

/** The CSV body, split into lines, with the BOM stripped. */
async function lines(res: Response): Promise<string[]> {
  const text = await res.text();
  return text.replace(/^﻿/, "").trimEnd().split("\r\n");
}

beforeEach(() => {
  store.user = owner();
  store.systemOn = true;
  store.readThrows = false;
  store.listArgs = null;
  store.rows = [row()];
  store.scope = {
    siteIds: ["site-cc"],
    selection: "site-cc",
    isAllSites: false,
    siteName: "N15 Vitality Dental",
    label: "N15 Vitality Dental",
  };
});

describe("who may take a file of named patients out of the platform", () => {
  it("the OWNER may", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
  });

  it("the PRACTICE MANAGER may, because working these lists is her job", async () => {
    store.user = { ...owner(), role: "client_coordinator" };
    expect((await get()).status).toBe(200);
  });

  it.each(["client_clinician", "client_staff"])("a %s login is refused", async (role) => {
    store.user = { ...owner(), role };
    const res = await get();
    expect(res.status).toBe(403);
    // Refused BEFORE the list is read: a forbidden caller costs no query.
    expect(store.listArgs).toBeNull();
  });

  it("a signed-in user of ANOTHER practice is refused", async () => {
    store.user = { ...owner(), clientId: "other", siteIds: [] };
    expect((await get()).status).toBe(403);
    expect(store.listArgs).toBeNull();
  });

  it("an unauthenticated caller is refused with the session's own 401", async () => {
    store.user = Response.json({ error: "unauthorized" }, { status: 401 });
    expect((await get()).status).toBe(401);
    expect(store.listArgs).toBeNull();
  });

  it("an unknown practice is a 404 and reads nothing", async () => {
    expect((await get("client=nope&treatment=whitening")).status).toBe(404);
    expect(store.listArgs).toBeNull();
  });
});

describe("the kill switch governs the export too", () => {
  it("an off module exports nothing, and says so in the platform's own words", async () => {
    // Ruling W2-C/4 named the switch-exempt surfaces as a CLOSED list of three
    // (bank editor, /api/previsit/bank, the module page) and W3/21 kept it closed
    // when it gated the mining button on this same screen. Not on the list means
    // gated.
    store.systemOn = false;
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, skipped: "system off" });
    expect(store.listArgs, "an off module still read the list").toBeNull();
  });
});

describe("what the file says", () => {
  it("asks for the YES rows of the treatment, scoped to the selected site", async () => {
    await get();
    expect(store.listArgs).toMatchObject({
      siteIds: ["site-cc"],
      treatment: "whitening",
      answer: "yes",
    });
  });

  it("refuses a treatment the form never offered", async () => {
    const res = await get("client=vitality&treatment=gold-teeth");
    expect(res.status).toBe(404);
    expect(store.listArgs).toBeNull();
  });

  it("exports EVERY treatment when none is named", async () => {
    store.rows = [row(), row({ id: "i-2", dentallyPatientId: "p-2", treatment: "implants" })];
    const res = await get("client=vitality");
    expect(store.listArgs?.treatment).toBeUndefined();
    const out = await lines(res);
    expect(out[0]).toContain("All treatments");
    expect(out.length).toBe(4); // stamp + header + two people
  });

  it("carries a BOM, CRLF line endings and the column header", async () => {
    const res = await get();
    // READ AS BYTES. `res.text()` decodes UTF-8 and a TextDecoder SWALLOWS the
    // BOM, so a string assertion here would fail on a correct file and pass on a
    // file whose BOM had been dropped — the wire is the only place to check it.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(
      [bytes[0], bytes[1], bytes[2]],
      "Excel will mangle an accented name without a UTF-8 BOM",
    ).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("\r\n");
    expect(text).toContain("Patient name,Dentally patient ID,Site,Treatment,Said yes on");
  });

  it("quotes a name holding a comma rather than splitting it into two columns", async () => {
    store.rows = [row({ patientName: 'Berry, Alex "AB"' })];
    const out = await lines(await get());
    expect(out[2]).toBe('"Berry, Alex ""AB""",p-1,N15 Vitality Dental,Whitening,2026-09-03T09:00:00.000Z');
  });

  it("never lets a patient name become a SPREADSHEET FORMULA", async () => {
    // Every value here is text somebody else typed, and a cell starting `=`, `+`,
    // `-` or `@` is executed by Excel, Numbers and Sheets. The leading apostrophe
    // is the standard mitigation, and it is applied only where it is needed —
    // the same guard the on-screen export uses (previsit-workspace.tsx csvCell).
    store.rows = [
      row({ id: "i-1", dentallyPatientId: "p-1", patientName: "=HYPERLINK(\"http://x\",\"click\")" }),
      row({ id: "i-2", dentallyPatientId: "p-2", patientName: "@SUM(1)" }),
      row({ id: "i-3", dentallyPatientId: "p-3", patientName: "-2+3" }),
      row({ id: "i-4", dentallyPatientId: "p-4", patientName: "Alex Berry" }),
    ];
    const out = await lines(await get());
    expect(out[2]).toMatch(/^"'=HYPERLINK/);
    expect(out[3]).toBe("'@SUM(1),p-2,N15 Vitality Dental,Whitening,2026-09-03T09:00:00.000Z");
    expect(out[4]).toMatch(/^'-2\+3,/);
    expect(out[5], "an ordinary name was mangled").toMatch(/^Alex Berry,/);
  });

  it("stamps the file with when it was taken and which sites it covers", async () => {
    // An exported list with no date claims the present tense for ever.
    const out = await lines(await get());
    expect(out[0]).toContain("Interest list");
    expect(out[0]).toContain("Whitening");
    expect(out[0]).toContain("N15 Vitality Dental");
    expect(out[0]).toContain("Exported");
  });

  it("lists ONE ROW PER PERSON, keeping their most recent yes", async () => {
    // A patient who answered before two appointments is one person to ring. The
    // list arrives newest first, so the row kept is the newer one.
    store.rows = [
      row({ id: "i-new", createdAt: "2026-09-03T09:00:00.000Z" }),
      row({ id: "i-old", createdAt: "2026-01-01T09:00:00.000Z" }),
    ];
    const out = await lines(await get());
    expect(out.length).toBe(3); // stamp + header + one person
    expect(out[2]).toContain("2026-09-03T09:00:00.000Z");
  });

  it("keeps the same person once PER TREATMENT when every treatment is exported", async () => {
    store.rows = [row(), row({ id: "i-2", treatment: "implants" })];
    const out = await lines(await get("client=vitality"));
    expect(out.length).toBe(4);
    expect(out[2]).toContain("Whitening");
    expect(out[3]).toContain("Implants");
  });

  it("an EMPTY list is still a file with both header rows, not an empty download", async () => {
    // An empty file is indistinguishable from a failed export.
    store.rows = [];
    const out = await lines(await get());
    expect(out.length).toBe(2);
    expect(out[0]).toContain("People,0");
  });

  it("names the file after the treatment and the moment", async () => {
    const res = await get();
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="interest-whitening-\d{8}-\d{4}\.csv"/,
    );
  });

  it("is never cached: it is a list of named patients", async () => {
    expect((await get()).headers.get("cache-control")).toBe("no-store");
  });
});

describe("honest numbers when the read is capped (charter 0/5, W3/11)", () => {
  it("says AT LEAST rather than a figure when the bound bit", async () => {
    // PostgREST clips at 1,000 rows with error: null, so a full response is a
    // truncated read whichever bound produced it. A campaign sized off a floor
    // wearing a total's clothes is the harm this sentence prevents.
    store.rows = Array.from({ length: 1000 }, (_, i) =>
      row({ id: `i-${i}`, dentallyPatientId: `p-${i}` }),
    );
    const res = await get();
    const out = await lines(res);
    expect(out[0]).toContain("People,at least 999");
    expect(out[0]).toContain("there are more behind them");
    expect(res.headers.get("x-interest-people")).toBe("at least 999");
    expect(out.length).toBe(2 + 999);
  });

  it("asks for exactly one row more than it will print, so truncation is PROVED", async () => {
    await get();
    expect(store.listArgs?.limit).toBe(1000);
  });

  it("says a plain figure when the list simply ended", async () => {
    store.rows = Array.from({ length: 3 }, (_, i) => row({ id: `i-${i}`, dentallyPatientId: `p-${i}` }));
    const res = await get();
    expect((await lines(res))[0]).toContain("People,3");
    expect(res.headers.get("x-interest-people")).toBe("3");
    expect((await lines(await get()))[0]).toContain("This is the whole list.");
  });
});

describe("failure modes", () => {
  it("never claims an empty list when the read FAILED", async () => {
    // A zero-row CSV would be read as "nobody is interested", which is the worst
    // possible answer to a database outage.
    store.readThrows = true;
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false });
  });
});
