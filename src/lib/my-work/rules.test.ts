import { describe, it, expect } from "vitest";
import {
  clockActionLabel,
  clockStateSentence,
  describeFailure,
  groupShiftsByDay,
  isPublishedShift,
  linkMissingCopy,
  mineOnly,
  myClockRow,
  myDocuments,
  myPolicies,
  myRota,
  panelStateFor,
  selfRequestStaffId,
  type PanelInput,
  type SelfClockRow,
  type SelfShift,
} from "./rules";
import type { StaffDocument } from "@/lib/hr/documents";
import type { StaffPolicy, StaffPolicySignatureSummary } from "@/lib/hr/esign";

// The three claims this module exists to make, tested as claims:
//   a draft never renders, a failed read never becomes an empty state, and
//   nothing renders at all without a resolved staff link.

function shift(over: Partial<SelfShift> = {}): SelfShift {
  return {
    id: "shift-1",
    staffId: "staff-1",
    shiftDate: "2026-08-17",
    startTime: "09:00",
    endTime: "17:00",
    role: "nurse",
    siteId: "site-n15",
    status: "scheduled",
    publishedAt: "2026-08-14T10:00:00.000Z",
    publishedVersion: 1,
    ...over,
  };
}

function panel(over: Partial<PanelInput> = {}): PanelInput {
  return {
    subject: "your shifts",
    consequence: "there are no shifts to show",
    loading: false,
    linked: true,
    failure: null,
    count: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Loud failure.
// ---------------------------------------------------------------------------

describe("describeFailure", () => {
  const statuses: (number | null)[] = [null, 400, 401, 403, 404, 409, 418, 500, 502, 503];

  it("never returns an empty message, whatever the status", () => {
    // A blank message renders as a blank panel, which is the confident empty
    // state this whole module exists to prevent.
    for (const status of statuses) {
      const message = describeFailure("your shifts", { status });
      expect(message.length, `status ${status} produced no message`).toBeGreaterThan(20);
    }
  });

  it("always says we could not load it, so no failure ever reads as a result", () => {
    for (const status of statuses) {
      expect(describeFailure("your documents", { status })).toContain("We could not load your documents");
    }
  });

  it("names the subject in the sentence", () => {
    expect(describeFailure("your holiday", { status: 500 })).toContain("your holiday");
  });

  it("says the server could not be reached when the request never completed", () => {
    const message = describeFailure("your shifts", { status: null });
    expect(message).toContain("could not be reached");
    // And says out loud WHY nothing is shown, rather than showing nothing.
    expect(message).toContain("rather than an empty list");
  });

  it("reads a 404 as 'not switched on yet', not as 'you have nothing'", () => {
    // The concrete case: the rota lane's read route is not deployed. "You have no
    // shifts" would be a lie; "it is not switched on yet" is the truth.
    expect(describeFailure("your shifts", { status: 404 })).toContain("not switched on for this practice yet");
  });

  it("repeats the server's own message where the server explained itself", () => {
    expect(
      describeFailure("your holiday", {
        status: 503,
        serverMessage: "Holiday and absence is not set up on this database yet.",
      }),
    ).toBe("Holiday and absence is not set up on this database yet.");
  });

  it("falls back to its own words when the server's message is blank", () => {
    const message = describeFailure("your holiday", { status: 503, serverMessage: "   " });
    expect(message).toContain("We could not load your holiday");
  });

  it("NEVER shows a machine token as if it were an explanation", () => {
    // The role guards answer `{"error":"forbidden"}`. Rendering the word
    // "forbidden" to a nurse looking at her own page is an error code, not a
    // sentence, and this is the concrete case: a client_staff calling a route
    // that still carries requireApproverRole.
    const message = describeFailure("your shifts", { status: 403, serverMessage: "forbidden" });
    expect(message).not.toBe("forbidden");
    expect(message).toContain("not allowed to see it");
    expect(message).toContain("practice manager");
    // Same for the other one-word guard answers, on any status.
    expect(describeFailure("your shifts", { status: 500, serverMessage: "unauthorized" })).toContain(
      "We could not load your shifts",
    );
  });

  it("includes the status code on an unrecognised failure so it is debuggable", () => {
    expect(describeFailure("your shifts", { status: 500 })).toContain("(500)");
  });
});

describe("panelStateFor", () => {
  it("A FAILED READ IS NEVER A READY EMPTY STATE", () => {
    // THE headline. count is 0 and linked is true, i.e. everything else says
    // "show an empty list" — and the failure still wins.
    const state = panelStateFor(panel({ failure: { status: 500 }, count: 0 }));
    expect(state.kind).toBe("failed");
  });

  it("a failure outranks a stale loading flag", () => {
    expect(panelStateFor(panel({ loading: true, failure: { status: 500 } })).kind).toBe("failed");
  });

  it("a failure outranks a missing staff link", () => {
    expect(panelStateFor(panel({ linked: false, failure: { status: 500 } })).kind).toBe("failed");
  });

  it("is loading before the first answer arrives", () => {
    expect(panelStateFor(panel({ loading: true })).kind).toBe("loading");
  });

  it("says the login is not linked rather than showing an empty list", () => {
    const state = panelStateFor(panel({ linked: false }));
    expect(state.kind).toBe("unlinked");
    if (state.kind === "unlinked") {
      expect(state.message).toContain("not linked to a staff record");
      expect(state.message).toContain("there are no shifts to show");
    }
  });

  it("is ready, with the count, once a good answer is in", () => {
    expect(panelStateFor(panel({ count: 3 }))).toEqual({ kind: "ready", count: 3 });
  });
});

describe("linkMissingCopy", () => {
  it("keeps the clocking route's wording, so the message is the same one twice", () => {
    expect(linkMissingCopy("there is nothing to sign")).toContain(
      "Your login is not linked to a staff record, so there is nothing to sign.",
    );
  });

  it("always says who can fix it", () => {
    expect(linkMissingCopy("there are no documents to show")).toContain("practice manager");
  });
});

// ---------------------------------------------------------------------------
// My rota: the draft must never render.
// ---------------------------------------------------------------------------

describe("isPublishedShift", () => {
  it("AN UNPUBLISHED DRAFT IS NOT PUBLISHED", () => {
    expect(isPublishedShift(shift({ publishedAt: null }))).toBe(false);
  });

  it("a shift with no publish field at all is not published (fail closed)", () => {
    // The state before the publish migration lands, and the state if a read ever
    // forgets to select the column. Both must withhold, not show.
    const { publishedAt: _dropped, ...withoutTheColumn } = shift();
    void _dropped;
    expect(isPublishedShift(withoutTheColumn as SelfShift)).toBe(false);
  });

  it("an empty publish stamp is not a publish stamp", () => {
    expect(isPublishedShift(shift({ publishedAt: "   " }))).toBe(false);
  });

  it("a published shift is published", () => {
    expect(isPublishedShift(shift())).toBe(true);
  });

  it("a cancelled or removed shift is never shown, published or not", () => {
    expect(isPublishedShift(shift({ status: "cancelled" }))).toBe(false);
    expect(isPublishedShift(shift({ status: "removed" }))).toBe(false);
    expect(isPublishedShift(shift({ status: "REMOVED" }))).toBe(false);
  });

  it("a notified shift is still a published shift", () => {
    expect(isPublishedShift(shift({ status: "notified" }))).toBe(true);
  });
});

describe("myRota", () => {
  it("shows nothing at all when the login has no staff record", () => {
    expect(myRota([shift()], null)).toEqual({ shifts: [], withheld: 0 });
  });

  it("never shows somebody else's shift", () => {
    const view = myRota([shift({ id: "a", staffId: "staff-2" }), shift({ id: "b" })], "staff-1");
    expect(view.shifts.map((s) => s.id)).toEqual(["b"]);
  });

  it("counts unpublished shifts as withheld rather than hiding them silently", () => {
    const view = myRota(
      [shift({ id: "a" }), shift({ id: "b", publishedAt: null }), shift({ id: "c", publishedAt: null })],
      "staff-1",
    );
    expect(view.shifts.map((s) => s.id)).toEqual(["a"]);
    expect(view.withheld).toBe(2);
  });

  it("does not count a cancelled shift as waiting to be published", () => {
    // "1 shift not published yet" about a cancelled shift would be a lie.
    const view = myRota([shift({ id: "a", status: "cancelled", publishedAt: null })], "staff-1");
    expect(view.shifts).toEqual([]);
    expect(view.withheld).toBe(0);
  });

  it("does not count somebody else's unpublished shift as mine", () => {
    const view = myRota([shift({ id: "a", staffId: "staff-2", publishedAt: null })], "staff-1");
    expect(view.withheld).toBe(0);
  });

  it("orders by day then start time", () => {
    const view = myRota(
      [
        shift({ id: "late", shiftDate: "2026-08-18", startTime: "14:00" }),
        shift({ id: "early-pm", shiftDate: "2026-08-17", startTime: "13:00" }),
        shift({ id: "early-am", shiftDate: "2026-08-17", startTime: "09:00" }),
      ],
      "staff-1",
    );
    expect(view.shifts.map((s) => s.id)).toEqual(["early-am", "early-pm", "late"]);
  });
});

describe("groupShiftsByDay", () => {
  it("groups into ordered days", () => {
    const groups = groupShiftsByDay([
      shift({ id: "b", shiftDate: "2026-08-18" }),
      shift({ id: "a2", shiftDate: "2026-08-17", startTime: "14:00" }),
      shift({ id: "a1", shiftDate: "2026-08-17", startTime: "09:00" }),
    ]);
    expect(groups.map((g) => g.dayKey)).toEqual(["2026-08-17", "2026-08-18"]);
    expect(groups[0].shifts.map((s) => s.id)).toEqual(["a1", "a2"]);
  });

  it("is empty for no shifts", () => {
    expect(groupShiftsByDay([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// My holiday.
// ---------------------------------------------------------------------------

describe("mineOnly", () => {
  it("shows nothing when there is no staff link", () => {
    expect(mineOnly([{ staffId: "staff-1", id: "a" }], null)).toEqual([]);
  });

  it("keeps only the caller's rows, even if the server sent more", () => {
    const rows = [
      { staffId: "staff-1", id: "mine" },
      { staffId: "staff-2", id: "theirs" },
    ];
    expect(mineOnly(rows, "staff-1").map((r) => r.id)).toEqual(["mine"]);
  });
});

describe("selfRequestStaffId", () => {
  it("is the session's staff id", () => {
    expect(selfRequestStaffId({ id: "staff-1" })).toBe("staff-1");
  });

  it("is null with no link, so the caller has to handle it", () => {
    expect(selfRequestStaffId(null)).toBeNull();
    expect(selfRequestStaffId(undefined)).toBeNull();
    expect(selfRequestStaffId({ id: "" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// My documents.
// ---------------------------------------------------------------------------

function doc(over: Partial<StaffDocument> = {}): StaffDocument {
  return {
    id: "doc-1",
    clientId: "vitality",
    staffId: "staff-1",
    kind: "dbs",
    label: "DBS certificate",
    storagePath: "staff-docs/vitality/staff-1/uuid/dbs.pdf",
    mime: "application/pdf",
    sizeBytes: 12_345,
    expiresOn: "2027-01-01",
    retainUntil: null,
    uploadedBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const TODAY = "2026-08-14";

describe("myDocuments", () => {
  it("shows nothing at all when the login has no staff record", () => {
    expect(myDocuments([doc()], null, TODAY)).toEqual([]);
  });

  it("NEVER shows somebody else's document, even if the server sent it", () => {
    const rows = myDocuments([doc({ id: "mine" }), doc({ id: "theirs", staffId: "staff-2" })], "staff-1", TODAY);
    expect(rows.map((r) => r.doc.id)).toEqual(["mine"]);
  });

  it("uses the vault lane's own expiry rule rather than a second opinion", () => {
    // Imported, not restated: the manager's screen and this one must never
    // disagree about whether the same certificate has lapsed.
    const rows = myDocuments(
      [
        doc({ id: "gone", label: "A", expiresOn: "2026-01-01" }),
        doc({ id: "soon", label: "B", expiresOn: "2026-08-20" }),
        doc({ id: "fine", label: "C", expiresOn: "2030-01-01" }),
        doc({ id: "undated", label: "D", expiresOn: null }),
      ],
      "staff-1",
      TODAY,
    );
    expect(rows.map((r) => r.expiry)).toEqual(["expired", "expiring", "valid", "no-expiry"]);
  });

  it("puts what needs doing first, and an undated document last", () => {
    const rows = myDocuments(
      [
        doc({ id: "undated", label: "A undated", expiresOn: null }),
        doc({ id: "gone", label: "Z expired", expiresOn: "2020-01-01" }),
      ],
      "staff-1",
      TODAY,
    );
    expect(rows.map((r) => r.doc.id)).toEqual(["gone", "undated"]);
  });

  it("does not mutate the array it was given", () => {
    const input = [doc({ id: "a", expiresOn: "2030-01-01" }), doc({ id: "b", expiresOn: "2020-01-01" })];
    myDocuments(input, "staff-1", TODAY);
    expect(input.map((d) => d.id)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// My signatures.
// ---------------------------------------------------------------------------

function policy(over: Partial<StaffPolicy> = {}): StaffPolicy {
  return {
    id: "policy-1",
    clientId: "vitality",
    slug: "complaints",
    title: "Complaints policy",
    version: 2,
    storagePath: "staff-docs/vitality/policies/complaints-v2.pdf",
    mime: "application/pdf",
    sizeBytes: 1000,
    effectiveFrom: "2026-04-01",
    retiredAt: null,
    createdBy: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    ...over,
  };
}

function signature(over: Partial<StaffPolicySignatureSummary> = {}): StaffPolicySignatureSummary {
  return {
    id: "sig-1",
    clientId: "vitality",
    staffId: "staff-1",
    policyId: "policy-1",
    policyVersion: 2,
    signature: { method: "typed", signedAt: "2026-05-02T09:00:00.000Z" },
    signedAt: "2026-05-02T09:00:00.000Z",
    ipHash: null,
    userAgent: null,
    ...over,
  };
}

describe("myPolicies", () => {
  it("shows nothing at all when the login has no staff record", () => {
    expect(myPolicies([policy()], [signature()], null, TODAY)).toEqual({ outstanding: [], signed: [] });
  });

  it("counts a signature on the version in force as done", () => {
    const view = myPolicies([policy()], [signature()], "staff-1", TODAY);
    expect(view.signed.map((r) => r.policy.id)).toEqual(["policy-1"]);
    expect(view.outstanding).toEqual([]);
  });

  it("A SIGNATURE ON AN OLDER VERSION LEAVES THE POLICY OUTSTANDING", () => {
    // The practice issued v2; this person only ever affirmed v1. Their signature
    // is evidence about v1 and nothing else, so it is owed again — and the row
    // still carries the old signature so the screen can say when they signed it.
    const view = myPolicies([policy()], [signature({ policyVersion: 1 })], "staff-1", TODAY);
    expect(view.outstanding.map((r) => r.policy.id)).toEqual(["policy-1"]);
    expect(view.outstanding[0].superseded?.policyVersion).toBe(1);
  });

  it("NEVER counts somebody else's signature as mine", () => {
    const view = myPolicies([policy()], [signature({ staffId: "staff-2" })], "staff-1", TODAY);
    expect(view.outstanding).toHaveLength(1);
    expect(view.signed).toEqual([]);
    // ...and does not offer me their signature as context either.
    expect(view.outstanding[0].superseded).toBeNull();
  });

  it("does not ask anybody to sign a policy that is not in force yet", () => {
    // Imported from the e-sign lane: a version dated 1 September must not be
    // signed in August, or the record says people affirmed it before it existed.
    const view = myPolicies([policy({ effectiveFrom: "2026-09-01" })], [], "staff-1", TODAY);
    expect(view.outstanding).toEqual([]);
    expect(view.signed).toEqual([]);
  });

  it("does not ask anybody to sign a retired version", () => {
    const view = myPolicies([policy({ retiredAt: "2026-06-01T00:00:00.000Z" })], [], "staff-1", TODAY);
    expect(view.outstanding).toEqual([]);
  });

  it("orders what is owed oldest-in-force first", () => {
    const view = myPolicies(
      [
        policy({ id: "new", slug: "fire", title: "Fire", effectiveFrom: "2026-07-01" }),
        policy({ id: "old", slug: "infection", title: "Infection control", effectiveFrom: "2025-01-01" }),
      ],
      [],
      "staff-1",
      TODAY,
    );
    expect(view.outstanding.map((r) => r.policy.id)).toEqual(["old", "new"]);
  });

  it("orders what is done most-recently-confirmed first", () => {
    const view = myPolicies(
      [
        policy({ id: "p-a", slug: "a", title: "A" }),
        policy({ id: "p-b", slug: "b", title: "B" }),
      ],
      [
        signature({ id: "s-a", policyId: "p-a", signedAt: "2026-01-01T00:00:00.000Z" }),
        signature({ id: "s-b", policyId: "p-b", signedAt: "2026-06-01T00:00:00.000Z" }),
      ],
      "staff-1",
      TODAY,
    );
    expect(view.signed.map((r) => r.policy.id)).toEqual(["p-b", "p-a"]);
  });
});

describe("my clocking: which row is mine, and what the button says", () => {
  function row(over: Partial<SelfClockRow> = {}): SelfClockRow {
    return { staffId: "staff-1", state: "out", nextKind: "in", since: null, ...over };
  }

  it("finds the caller's own row and nobody else's", () => {
    const rows = [row({ staffId: "staff-2", state: "in", nextKind: "out" }), row()];
    expect(myClockRow(rows, "staff-1")?.staffId).toBe("staff-1");
  });

  it("RETURNS NULL for an unresolved login rather than the first row it sees", () => {
    expect(myClockRow([row()], null)).toBeNull();
  });

  it("returns null when the caller's row is simply not in the response", () => {
    // An approver looking at another site gets rows that do not include them. The
    // tab must say "we cannot say" rather than inventing an "out" state — the
    // button would otherwise offer to clock in somebody it knows nothing about.
    expect(myClockRow([row({ staffId: "staff-9" })], "staff-1")).toBeNull();
  });

  it("labels the button with the ONE tap the server would accept", () => {
    // The label is a rule, not a rendering choice: `validateClock` refuses the
    // other one, so a button that offered it would be a 409 waiting to happen.
    expect(clockActionLabel("in")).toBe("Clock in");
    expect(clockActionLabel("out")).toBe("Clock out");
  });

  it("says what state you are in, and admits when it does not know", () => {
    expect(clockStateSentence(null, null)).toContain("do not have");
    expect(clockStateSentence(row({ state: "in", nextKind: "out" }), "09:14")).toBe(
      "You are clocked in, since 09:14.",
    );
    // A missing time is handled rather than rendered as "since —".
    expect(clockStateSentence(row({ state: "in", nextKind: "out" }), null)).toBe("You are clocked in.");
    expect(clockStateSentence(row({ state: "out" }), null)).toContain("clocked out");
    expect(clockStateSentence(row({ state: "expected" }), null)).toContain("not clocked in yet");
    expect(clockStateSentence(row({ state: "off" }), null)).toContain("not on the rota today");
  });

  it("never returns an empty sentence, whatever it is handed", () => {
    // A blank sentence renders as a blank panel, which is the confident-empty-state
    // failure this whole module exists to prevent.
    for (const state of ["in", "out", "expected", "off", "something-new"]) {
      expect(clockStateSentence(row({ state }), null).length).toBeGreaterThan(0);
    }
  });
});
