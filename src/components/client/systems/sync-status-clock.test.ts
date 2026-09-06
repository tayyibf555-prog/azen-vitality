// ===========================================================================
// THE SYNC LEDGER IS STAMPED IN THE PRACTICE'S CLOCK, NOT THE READER'S.
//
// The "When" column of the write-intent table is the evidence record of what
// this platform did — or was stopped from doing — to real Dentally patient
// records. It is read next to Dentally's OWN audit trail, so the two have to
// be quoting the same clock.
//
// The defect this pins: `when()` formatted every instant with
// `toLocaleString("en-GB", { day, month, hour, minute })` and no `timeZone`.
// The payload arrives from a client-side fetch, so that string was rendered in
// whatever zone the VIEWER's browser reports — and the platform's own hosts run
// UTC (see src/lib/time/london.ts, which pins Europe/London for exactly this
// reason). A write recorded at 2026-09-05T23:30:00Z is 00:30 on 6 September in
// the practice's BST clock; a UTC machine printed "05 Sept, 23:30" — the wrong
// hour AND the wrong calendar day — and a CET machine "06 Sept, 01:30".
//
// HOW THIS TEST IS ABLE TO SEE IT. Under vitest the process clock is whatever
// the machine is set to, so an unzoned format and a Europe/London format agree
// on a UK laptop and the omission is invisible to any assertion. So the suite
// SHIFTS the process zone itself (Node re-reads `process.env.TZ`) and renders
// the real panel from a zone that is neither UTC nor London. The zone is put
// back in `afterAll`.
//
// MUTATION: delete the `timeZone: "Europe/London"` line in `when()` →
// "the ledger prints the practice's wall clock..." goes red ("05 Sept, 19:30").
// ===========================================================================
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SyncStatusPanel,
  type SyncStatusPayloadShape,
  type WriteIntent,
} from "./sync-status-view";
import { syncFacts, syncHeadline } from "@/lib/dentally/sync-surface";

const ORIGINAL_TZ = process.env.TZ;

// New York, so a bug that merely leaked UTC and a bug that leaked the host zone
// are both visible, and neither can coincide with Europe/London.
beforeAll(() => {
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const BASE: SyncStatusPayloadShape = {
  mode: "dry_run",
  target: { host: "api.dentally.co", live: true },
  master: { slug: "dentally-write-back", off: false },
  headline: syncHeadline("dry_run"),
  facts: syncFacts("dry_run"),
  counts: { dry_run: 0, queued: 0, sent: 0, failed: 0, blocked: 0 },
  total: 0,
  countCapped: false,
  intents: [],
  more: false,
  pageSize: 50,
  ledgerError: null,
};

const intent = (over: Partial<WriteIntent> = {}): WriteIntent => ({
  id: "i1",
  kind: "appointment.move",
  source: "diary",
  moduleSlug: "calendar-writes",
  dentallyPatientId: "p-1",
  dentallyAppointmentId: "a-1",
  target: "api.dentally.co",
  status: "blocked",
  blockedReason: "writes_disabled",
  actor: "usr_9f2b41c8",
  responseId: null,
  error: null,
  createdAt: "2026-09-05T23:30:00Z",
  ...over,
});

function render(intents: WriteIntent[]): string {
  return renderToStaticMarkup(
    createElement(SyncStatusPanel, { data: { ...BASE, intents, total: intents.length } }),
  );
}

describe("the write-intent ledger dates every row in Europe/London", () => {
  it("prints the practice's wall clock for an instant that crosses midnight in BST", () => {
    // 23:30 UTC on 5 September is 00:30 on the SIXTH in the practice's clock.
    const html = render([intent({ createdAt: "2026-09-05T23:30:00Z" })]);
    expect(html).toContain(">06 Sept, 00:30<");
    // The reader's own zone (America/New_York) and the host's (UTC) must not
    // reach the screen: both would date this row to the fifth.
    expect(html).not.toContain(">05 Sept, 19:30<");
    expect(html).not.toContain(">05 Sept, 23:30<");
  });

  it("holds through the GMT half of the year, when London is UTC and the reader is not", () => {
    // January: London == UTC, so only a leak of the READER's zone shows here.
    const html = render([intent({ createdAt: "2026-01-14T08:05:00Z" })]);
    expect(html).toContain(">14 Jan, 08:05<");
    expect(html).not.toContain(">14 Jan, 03:05<");
  });

  it("still refuses to invent a date for an instant it cannot parse", () => {
    // The guard the column had before the zone was pinned, kept: a blank cell
    // beats "Invalid Date" on the page that is meant to be the honest record.
    const html = render([intent({ createdAt: "not-a-date" })]);
    expect(html).toContain(">—<");
  });
});
