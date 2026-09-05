// ===========================================================================
// THE SYNC STATUS COUNT STRIP AND THE "FROM" COLUMN.
//
// Three defects from the wave-3 review, pinned where a practice meets them —
// on the rendered markup — rather than on the constants behind them:
//
//  1. THE TWO HELD-BACK CARDS WERE THE WRONG WAY ROUND. On a live deployment
//     with write-back off, the gate refuses every write with status=blocked
//     (writes_disabled / master_off); `dry_run` means the write RAN, against
//     the local mock, which on that deployment never happens. The card labelled
//     "Held back (writing off)" counted `dry_run` and was therefore hard-wired
//     to nought, while every genuinely held-back write sat under "Refused here"
//     — a phrase that reads as a rejection. Home's Operating system band counts
//     `blocked` and calls it "held back" (os-band.ts), so an owner could read
//     "12 held back" on Home, click through, and be told "Held back: 0".
//     Ruling W3/11: the two cards are labelled by what they count and agree
//     with the home tile.
//
//  2. ONLY THE HEADLINE TOTAL WORE THE CAP. countWriteIntents reads at most
//     COUNT_CAP status values, NEWEST FIRST, and says `capped`. The four
//     per-status cards printed bare figures off that same truncated read, so a
//     status that stopped occurring before the ceiling read as a hard zero on
//     the one screen whose job is to be the honest record. Charter §0/5.
//
//  3. THE "FROM" COLUMN PRINTED THE REGISTRY KEY. `noshow`, `patient-admin`,
//     `diary` — while the prose a few hundred pixels above the same table named
//     those same surfaces "No-show defence", "Patient record editing", "Diary".
//     Ruling W3/11: source slugs on screens become the human labels the page
//     already has.
//
// Everything here renders the REAL panel. A count-strip claim asserted against
// the payload rather than the markup is exactly how defect 1 survived a suite
// that already rendered this component.
// ===========================================================================
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SyncStatusPanel,
  type SyncStatusPayloadShape,
  type WriteIntent,
} from "./sync-status-view";
import {
  DENTALLY_WRITE_SOURCES,
  type DentallyWriteSource,
} from "@/lib/dentally/write-vocabulary";
import { syncFacts, syncHeadline } from "@/lib/dentally/sync-surface";

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

function render(payload: Partial<SyncStatusPayloadShape>): string {
  return renderToStaticMarkup(createElement(SyncStatusPanel, { data: { ...BASE, ...payload } }));
}

/** The stat strip renders its label in a <p>; the row pill renders it in a <span>. */
function cardValue(html: string, label: string): string {
  const marker = `>${label}</p>`;
  const at = html.indexOf(marker);
  expect(at, `no stat card labelled "${label}" on the screen`).toBeGreaterThan(-1);
  // The numeral is the last <span> before the label's <p>.
  const before = html.slice(0, at);
  const open = before.lastIndexOf("<span");
  const close = before.indexOf("</span>", open);
  const cell = before.slice(before.indexOf(">", open) + 1, close);
  // Strip the decorative dot <i>.
  return cell.replace(/<i[^>]*><\/i>/g, "").trim();
}

const intent = (over: Partial<WriteIntent> = {}): WriteIntent => ({
  id: "i1",
  kind: "appointment.create",
  source: "recall",
  moduleSlug: "recall",
  dentallyPatientId: "p-1",
  dentallyAppointmentId: null,
  target: "api.dentally.co",
  status: "blocked",
  blockedReason: "writes_disabled",
  actor: "usr_9f2b41c8",
  responseId: null,
  error: null,
  createdAt: "2026-09-02T09:15:00Z",
  ...over,
});

describe("the held-back card counts the status that is actually held back", () => {
  it("puts a BLOCKED count under 'Held back', which is the word Home's tile uses", () => {
    // Production today: writes off, target api.dentally.co, three staff writes
    // refused by the gate. This is the number the owner clicked through for.
    const html = render({
      counts: { dry_run: 0, queued: 0, sent: 0, failed: 0, blocked: 3 },
      total: 3,
    });
    expect(cardValue(html, "Held back")).toBe("3");
  });

  it("never files a blocked write under a card that reads as a rejection", () => {
    // "Refused here" was the old label on the blocked count, and it reads as
    // "Dentally/validation said no" rather than "your switch is off".
    const html = render({ counts: { dry_run: 0, queued: 0, sent: 0, failed: 0, blocked: 3 }, total: 3 });
    expect(html).not.toContain("Refused here");
    expect(html).not.toContain("Held back (writing off)");
  });

  it("names the dry-run card for what it is: a write that ran against the local copy", () => {
    const html = render({ counts: { dry_run: 7, queued: 0, sent: 0, failed: 0, blocked: 0 }, total: 7 });
    // W1-A/4: a dry_run is labelled by where it went, never as a held-back write.
    expect(cardValue(html, "Test writes (local copy)")).toBe("7");
    expect(cardValue(html, "Held back")).toBe("0");
  });

  it("keeps the other two cards on the statuses they name", () => {
    const html = render({
      counts: { dry_run: 0, queued: 0, sent: 5, failed: 2, blocked: 0 },
      total: 7,
    });
    expect(cardValue(html, "Written to Dentally")).toBe("5");
    expect(cardValue(html, "Dentally refused")).toBe("2");
  });
});

describe("a capped scan never lets ANY of its five figures wear a total's clothes", () => {
  it("prefixes every non-zero per-status figure with 'At least', not just the headline", () => {
    // The scan is newest-first and stopped at its ceiling: 2,000 recent `sent`
    // rows, and the 41 Dentally actually refused last autumn are past it.
    const html = render({
      counts: { dry_run: 0, queued: 0, sent: 2000, failed: 0, blocked: 0 },
      total: 2000,
      countCapped: true,
    });
    expect(cardValue(html, "Writes recorded")).toBe("At least 2,000");
    expect(cardValue(html, "Written to Dentally")).toBe("At least 2,000");
  });

  it("says a nought under a cap is a nought AMONG THOSE COUNTED, never a plain 0", () => {
    const html = render({
      counts: { dry_run: 0, queued: 0, sent: 2000, failed: 0, blocked: 0 },
      total: 2000,
      countCapped: true,
    });
    // This is the scenario: "Dentally refused 0" printed as a fact while 41 rows
    // sit past the ceiling.
    expect(cardValue(html, "Dentally refused")).toBe("None counted");
    expect(cardValue(html, "Held back")).toBe("None counted");
    expect(html).toContain("none among those counted rather than none ever");
  });

  it("leaves an UNCAPPED strip as plain figures, so the hedge means something", () => {
    const html = render({
      counts: { dry_run: 0, queued: 0, sent: 5, failed: 0, blocked: 3 },
      total: 8,
      countCapped: false,
    });
    expect(cardValue(html, "Held back")).toBe("3");
    expect(cardValue(html, "Dentally refused")).toBe("0");
    expect(html).not.toContain("At least");
    expect(html).not.toContain("None counted");
    expect(html).not.toContain("none among those counted");
  });
});

describe("the evidence table names the surface, not the registry key", () => {
  it("prints the owner-facing name for EVERY source the gate can record", () => {
    const sources = Object.keys(DENTALLY_WRITE_SOURCES) as DentallyWriteSource[];
    expect(sources.length).toBeGreaterThan(5);
    const html = render({
      intents: sources.map((source, i) => intent({ id: `i${i}`, source })),
    });
    for (const source of sources) {
      const label = DENTALLY_WRITE_SOURCES[source].label as string;
      const short = label.includes(" (") ? label.slice(0, label.indexOf(" (")) : label;
      expect(html, `the name for "${source}" is missing from the table`).toContain(`>${short}<`);
      // ...and the key itself never reaches the screen as a cell.
      expect(html, `the raw key "${source}" is on the screen`).not.toContain(`>${source}<`);
    }
  });

  it("keeps the explaining half of the label on the cell rather than throwing it away", () => {
    const html = render({ intents: [intent({ source: "noshow" })] });
    expect(html).toContain(
      'title="No-show defence (rebooking, and cancelling on a patient&#x27;s reply)"',
    );
  });

  it("falls back to the stored value for a source this build no longer knows", () => {
    // A real row in the practice's ledger written by code that has since gone.
    // The only identifier we have is the honest answer; a blank is not.
    const html = render({ intents: [intent({ source: "some-retired-sweep" })] });
    expect(html).toContain(">some-retired-sweep<");
  });
});
