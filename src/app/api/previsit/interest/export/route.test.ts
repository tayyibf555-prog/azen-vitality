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
//
// AND IT IS THE ONLY EXPORT (ruling W3/29). The screen's own browser-built CSV is
// retired, so this route serves BOTH controls: the Download (text/csv) and the
// Copy-as-audience (text/plain). Its read is `listInterestToCompletion`, which
// walks the table to its end with a keyset cursor — the bounded `listInterest` is
// deliberately absent from the mock below, so a route that went back to a single
// page fails to import rather than quietly exporting the first thousand people.
// The walk itself is pinned where it lives, in src/lib/triage/repository.test.ts.
// ===========================================================================

vi.mock("server-only", () => ({}));

const store = vi.hoisted(() => ({
  user: null as unknown,
  systemOn: true,
  rows: [] as unknown[],
  /** What the WALK says about itself: true means "these are the most recent N". */
  capped: false,
  readThrows: false,
  /** See the guard mock: hands the caller the module key so only the approver lock is left. */
  moduleGateOpen: false,
  listArgs: null as null | Record<string, unknown>,
  scope: { siteIds: ["site-cc"], selection: "site-cc", isAllSites: false, siteName: "N15 Vitality Dental", label: "N15 Vitality Dental" },
}));

// PARTIAL mock: the real guards run — they are what this file is about — and only
// the session read is faked.
//
// `moduleGateOpen` exists for ONE test, and the reason is that TWO GUARDS THAT
// DENY THE SAME SET CANNOT BE TOLD APART BY A STATUS CODE. The nav item's roles
// (src/lib/nav.ts) and APPROVER_ROLES (src/lib/absence/rules.ts) are the same pair
// today, so `requireModuleApiAccess` alone answers 403 for every role the approver
// guard would have refused — and `if (false && roleDenied)` survives the whole
// suite. Handing the caller the FIRST key leaves only the second lock standing, so
// the test observes the guard that the route's own header says is here for the day
// pre-visit widens to the clinician. Same technique as
// src/app/api/systems/systems-route-owner-lock.test.ts. Off by default: every
// other test in this file runs the real module gate.
vi.mock("@/lib/auth/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guard")>();
  return {
    ...actual,
    requireUser: async () => store.user,
    requireModuleApiAccess: (...args: Parameters<typeof actual.requireModuleApiAccess>) =>
      store.moduleGateOpen ? null : actual.requireModuleApiAccess(...args),
  };
});
vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
  getSite: (id: string) =>
    id === "site-cc" ? { id, clientId: "vitality", name: "N15 Vitality Dental" } : undefined,
}));
vi.mock("@/lib/site-view", () => ({ getViewScope: async () => store.scope }));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => store.systemOn }));
// NOTE: the bounded `listInterest` is deliberately NOT on this mock. A route that
// goes back to it fails to import rather than exporting one PostgREST page of a
// marketing list as though it were the list (ruling W3/29).
vi.mock("@/lib/triage/repository", () => ({
  listInterestToCompletion: async (args: Record<string, unknown>) => {
    store.listArgs = args;
    if (store.readThrows) throw new Error("db down");
    return { rows: store.rows, capped: store.capped, scanned: store.rows.length };
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
  store.moduleGateOpen = false;
  store.listArgs = null;
  store.capped = false;
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

  it("previsit-interest-export-approver-lock-refuses-a-clinician-who-clears-the-module-gate", async () => {
    // THE SECOND LOCK, OBSERVED (ruling W3/17, charter 0/11). Both guards deny the
    // same two roles today, so the test above passes on the module gate alone and
    // `if (false && roleDenied) return roleDenied;` — an inert approver guard with
    // the literal call still on the line above it — survives the entire suite: the
    // route's only other pins are a `toContain("requireApproverRole(auth)")` in
    // destructive-route-capability-coverage.test.ts and a module-slug match in
    // client-api-module-guard-coverage.test.ts, and a text match cannot tell a
    // guard from a guard whose answer is thrown away.
    //
    // So this test enacts the scenario the route's own header names: "the day
    // pre-visit widens to the clinician so he can read the pre-visit SUMMARY on the
    // record, the module gate alone would hand him the whole practice's marketing
    // list as a file." The module gate is opened; the approver guard is the real
    // one; the clinician is still refused and the list is still never read.
    store.moduleGateOpen = true;
    store.user = { ...owner(), role: "client_clinician" };
    const res = await get();
    expect(res.status).toBe(403);
    expect(store.listArgs, "a clinician read the marketing list").toBeNull();
  });

  it("and the manager still gets through with the module gate open", async () => {
    // The other direction, so the test above cannot be satisfied by a guard that
    // refuses everybody: working these lists is the practice manager's job.
    store.moduleGateOpen = true;
    store.user = { ...owner(), role: "client_coordinator" };
    expect((await get()).status).toBe(200);
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

  it("previsit-interest-export-counts-one-patient-once-across-treatments", async () => {
    // THE ROW SHAPE ABOVE IS RIGHT AND THE WORD "PEOPLE" WAS NOT (charter 0/5,
    // W3/11). The tick grid submits an answer for every treatment at once, so a
    // patient routinely holds three or four `yes` rows; counting those rows and
    // printing them as people made "Export everyone" claim an audience equal to the
    // SUM of the per-treatment cells in the grid above it, each of which is
    // `count(distinct ti.dentally_patient_id)`. The existing all-treatments case
    // seeds two DIFFERENT patients, so the dedupe key's second half was never
    // exercised on the one path where it is wrong. This is that path: ONE patient,
    // three treatments.
    store.rows = [
      row({ id: "i-1", treatment: "whitening" }),
      row({ id: "i-2", treatment: "implants" }),
      row({ id: "i-3", treatment: "straightening" }),
    ];
    const res = await get("client=vitality");
    expect(res.headers.get("x-interest-people"), "one person was counted three times").toBe("1");
    // ...and the FILE still carries a row per treatment, because that column is
    // what makes it workable.
    expect((await lines(res)).length).toBe(5);
  });

  it("previsit-interest-export-audience-never-repeats-one-patient", async () => {
    // A pasted audience is a column of ids somebody uploads. The same id on three
    // lines is one person uploaded three times, and the paste then holds more rows
    // than the count printed beside the button.
    store.rows = [
      row({ id: "i-1", treatment: "whitening" }),
      row({ id: "i-2", treatment: "implants" }),
      row({ id: "i-3", dentallyPatientId: "p-2", patientName: "Sam Okafor", treatment: "implants" }),
    ];
    const res = await get("client=vitality&format=audience");
    expect(await res.text()).toBe("p-1\tAlex Berry\np-2\tSam Okafor");
    expect(res.headers.get("x-interest-people")).toBe("2");
  });

  it("a per-treatment export is unchanged: the two keys agree there", async () => {
    // The correction is a no-op wherever a treatment is named, which is every
    // control the screen offers today.
    store.rows = [row({ id: "i-1" }), row({ id: "i-2", dentallyPatientId: "p-2" })];
    const res = await get();
    expect(res.headers.get("x-interest-people")).toBe("2");
    expect((await lines(res)).length).toBe(4);
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

describe("honest numbers when the read is capped (charter 0/5, W3/11, W3/29)", () => {
  it("says AT LEAST rather than a figure when the WALK stopped at its ceiling", async () => {
    // The walk reads to the end of the table, so `capped` no longer means "a page
    // was full": it means the 20,000-row ceiling was reached and these are the
    // most recent people. A campaign sized off a floor wearing a total's clothes
    // is the harm this sentence prevents, at either bound.
    store.rows = Array.from({ length: 4 }, (_, i) => row({ id: `i-${i}`, dentallyPatientId: `p-${i}` }));
    store.capped = true;
    const res = await get();
    const out = await lines(res);
    expect(out[0]).toContain("People,at least 4");
    expect(out[0]).toContain("there are more behind them");
    expect(res.headers.get("x-interest-people")).toBe("at least 4");
  });

  it("asks the reader that WALKS TO THE END, and hands it no row bound to stop at", async () => {
    // The defect this replaced: one `listInterest` call at limit 1,000, which is
    // PostgREST's own max-rows — a clipped page with `error: null` and no way for
    // the file to know. There is no limit to pass any more, and passing one would
    // be re-introducing the ceiling by the back door.
    await get();
    expect(store.listArgs, "the export did not read anything").not.toBeNull();
    expect(store.listArgs?.limit, "a row bound came back").toBeUndefined();
    expect(store.listArgs).toMatchObject({ answer: "yes", treatment: "whitening" });
  });

  it("prints a large complete list in full rather than cutting it at a page", async () => {
    store.rows = Array.from({ length: 1200 }, (_, i) =>
      row({ id: `i-${i}`, dentallyPatientId: `p-${i}` }),
    );
    const res = await get();
    const out = await lines(res);
    expect(out.length).toBe(2 + 1200);
    // Quoted, because the figure carries a thousands separator — the cell rule
    // doing its job on the platform's own text as well as on a patient's name.
    expect(out[0]).toContain('People,"1,200"');
    expect(res.headers.get("x-interest-people")).toBe("1,200");
  });

  it("says a plain figure when the list simply ended", async () => {
    store.rows = Array.from({ length: 3 }, (_, i) => row({ id: `i-${i}`, dentallyPatientId: `p-${i}` }));
    const res = await get();
    expect((await lines(res))[0]).toContain("People,3");
    expect(res.headers.get("x-interest-people")).toBe("3");
    expect((await lines(await get()))[0]).toContain("This is the whole list.");
  });
});

describe("the copy-as-audience control has a server door too (W3/29)", () => {
  it("hands back the Dentally id and the name, tab separated, with no header row", async () => {
    // This is the thing that gets pasted into somebody else's tool, so a
    // provenance row at the top of it would become a row in their campaign.
    store.rows = [row(), row({ id: "i-2", dentallyPatientId: "p-2", patientName: "Sam Okafor" })];
    const res = await get("client=vitality&treatment=whitening&format=audience");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-disposition"), "a paste was offered as a download").toBeNull();
    expect(await res.text()).toBe("p-1\tAlex Berry\np-2\tSam Okafor");
  });

  it("carries the SAME honest count as the file does", async () => {
    store.rows = Array.from({ length: 4 }, (_, i) => row({ id: `i-${i}`, dentallyPatientId: `p-${i}` }));
    store.capped = true;
    const res = await get("client=vitality&format=audience");
    expect(res.headers.get("x-interest-people")).toBe("at least 4");
  });

  it("is one line per PERSON, like the file", async () => {
    store.rows = [row({ id: "i-new" }), row({ id: "i-old", createdAt: "2026-01-01T09:00:00.000Z" })];
    expect((await (await get("client=vitality&format=audience")).text()).split("\n")).toHaveLength(1);
  });

  it("is never cached either: it is the same named patients", async () => {
    expect((await get("client=vitality&format=audience")).headers.get("cache-control")).toBe("no-store");
  });

  it("obeys the switch in the same words the file does", async () => {
    store.systemOn = false;
    const res = await get("client=vitality&format=audience");
    expect(await res.json()).toMatchObject({ ok: false, skipped: "system off" });
    expect(store.listArgs).toBeNull();
  });

  it("refuses a format it does not have rather than serving a CSV to a paste box", async () => {
    const res = await get("client=vitality&format=xlsx");
    expect(res.status).toBe(404);
    expect(store.listArgs).toBeNull();
  });
});

describe("the sites are the CALLER'S sites, not the switcher's alone", () => {
  it("narrows the read to the sites this session actually holds", async () => {
    // Inert today — a session's siteIds are every site of its client — and it is
    // the house pattern (inbox/threads, inbox/reply, reviews/today) because this
    // is a file of named patients: the day a per-site login exists, scoping by the
    // cookie alone would hand a coordinator another practice site's list by
    // flipping a switcher.
    store.scope = { ...store.scope, siteIds: ["site-cc", "site-n17"] };
    store.user = { ...owner(), siteIds: ["site-cc"] };
    await get();
    expect(store.listArgs?.siteIds).toEqual(["site-cc"]);
  });

  it("reads the switcher's whole scope when the session holds it all", async () => {
    store.scope = { ...store.scope, siteIds: ["site-cc", "site-n17"] };
    store.user = { ...owner(), siteIds: ["site-cc", "site-n17"] };
    await get();
    expect(store.listArgs?.siteIds).toEqual(["site-cc", "site-n17"]);
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
