import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { srcPath, walkSrc } from "@/lib/test-support/walk-src";
import { SyncStatusPanel, type SyncStatusPayloadShape } from "@/components/client/systems/sync-status-view";
import { BLOCKED_REASON_COPY, BLOCKED_REASONS, DENTALLY_WRITE_KINDS } from "./write-vocabulary";
import {
  SYNC_GROUP_ORDER,
  SYNC_GROUP_TITLES,
  sourcesForKind,
  syncFacts,
  syncGroupTitle,
  syncGroupTitles,
  syncHeadline,
} from "./sync-surface";

// ===========================================================================
// WHAT THE PRACTICE IS TOLD ABOUT THEIR DENTALLY CONNECTION.
//
// These are not cosmetic strings. "Our notes are in Dentally" is a belief a
// practice would run a clinic on, and the honest answer today is that they are
// not and never will be on this connection. So the sentences are asserted here,
// in the words a practice reads, rather than left to a paragraph in a view.
// ===========================================================================

describe("the three groups say what flows and what does not", () => {
  it("puts every supported write in PENDING while the write path is off", () => {
    const facts = syncFacts("dry_run");
    const pending = facts.filter((f) => f.group === "pending_on_key").map((f) => f.id);
    expect([...pending].sort()).toEqual([...DENTALLY_WRITE_KINDS].sort());
    // ...and nothing at all is claimed to be flowing.
    expect(facts.filter((f) => f.group === "mirrored")).toEqual([]);
  });

  it("moves the same five into MIRRORED once the write path is live, and no more", () => {
    const facts = syncFacts("live");
    expect(facts.filter((f) => f.group === "mirrored").map((f) => f.id).sort()).toEqual(
      [...DENTALLY_WRITE_KINDS].sort(),
    );
    expect(facts.filter((f) => f.group === "pending_on_key")).toEqual([]);
  });

  it("keeps the governance blocks in the SAME group whatever the write key does", () => {
    // This is the whole point of the third group: these do not move when the key
    // arrives, and a surface that implied they might would be lying by omission.
    const off = syncFacts("dry_run").filter((f) => f.group === "blocked_by_governance").map((f) => f.id);
    const on = syncFacts("live").filter((f) => f.group === "blocked_by_governance").map((f) => f.id);
    expect(on).toEqual(off);
    expect(off).toEqual(["notes", "sms", "emails", "charting", "medical-history", "documents"]);
  });

  it("never puts one fact in two groups", () => {
    for (const mode of ["dry_run", "live"] as const) {
      const ids = syncFacts(mode).map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("says plainly that notes and correspondence do not go back", () => {
    const facts = syncFacts("dry_run");
    const notes = facts.find((f) => f.id === "notes");
    expect(notes?.detail).toMatch(/stay in this platform/i);
    expect(notes?.detail).toMatch(/undocumented/i);

    const sms = facts.find((f) => f.id === "sms");
    // The reason is the one that matters: posting there would SEND, not record.
    expect(sms?.detail).toMatch(/duplicate text/i);
    expect(sms?.detail).toMatch(/never posts to it/i);

    const emails = facts.find((f) => f.id === "emails");
    expect(emails?.detail).toMatch(/send a message rather than record one/i);
  });

  it("never draws the funding line here, and names NHS only where it names a record type", () => {
    // THE FUNDING-JARGON RULE, APPLIED WHERE IT ACTUALLY BITES. The rule is that
    // PATIENT-facing copy never says NHS or private; this surface is owner-only
    // (System controls is owner + agency), so the rule does not forbid the word
    // outright. What it does forbid, everywhere, is DIVIDING the practice's
    // patients into two funding classes in prose — so "private" must not appear
    // at all, and "NHS" may appear only as the name of a record type the owner
    // asked about (an FP17/NHS declaration), never as a description of a person.
    const all = syncFacts("dry_run");
    for (const f of all) {
      expect(`${f.label} ${f.detail}`, f.id).not.toMatch(/\bprivate\b/i);
    }
    const mentionsNhs = all.filter((f) => /\bNHS\b/.test(`${f.label} ${f.detail}`)).map((f) => f.id);
    expect(mentionsNhs).toEqual(["medical-history"]);
    expect(all.find((f) => f.id === "medical-history")?.detail).toMatch(/NHS declarations/);
  });

  it("names, for each supported write, which surfaces make it — derived, not restated", () => {
    // A surface that writes to a patient's record and is missing from the page a
    // practice reads to find out what writes to their records is the exact gap
    // this lane closes, so the list is computed from the source registry.
    expect(sourcesForKind("appointment.update")).toEqual([
      "Booking agent (the 24/7 SMS and WhatsApp assistant)",
      // ADDED BY WAVE 2, LANE A, and KEPT deliberately in wave 3. The co-pilot's
      // `diary_write` moves an appointment when an owner asks for it, so the page
      // that tells a practice what changes their diary names it. Since ruling
      // W3/1 the confirmed move travels through the diary's own performMove and
      // the LEDGER ROW is filed under `diary` — but this list answers "which
      // surfaces can change this?", not "which name is on the row", and dropping
      // the co-pilot would tell an owner that asking cannot move an appointment.
      // An assertion that did not change here would mean the page had stopped
      // being complete.
      "Co-pilot (the owner adding a patient, or booking, moving or cancelling, by asking)",
      "Diary (moving, resizing or reassigning an appointment)",
    ]);
    expect(sourcesForKind("patient.create").length).toBeGreaterThanOrEqual(3);
    for (const kind of DENTALLY_WRITE_KINDS) expect(sourcesForKind(kind).length).toBeGreaterThan(0);
  });

  it("headlines the off state as OFF, in words, without hedging", () => {
    expect(syncHeadline("dry_run")).toMatch(/is OFF/);
    expect(syncHeadline("dry_run")).toMatch(/Nothing this platform does reaches your Dentally book/);
    expect(syncHeadline("live")).toMatch(/is ON/);
  });

  it("has THREE headline states, because 'we cannot yet' is not 'you chose not to'", () => {
    // Only one of the two is something the reader can change, and the sentence
    // has to say which — otherwise an owner waits on the agency for a switch
    // sitting on the next tab.
    const ownerOff = syncHeadline("live", true);
    expect(ownerOff).toMatch(/because you have switched it off/i);
    expect(ownerOff).toMatch(/System controls/);
    // The owner's own switch wins the sentence even when the key is missing too:
    // it is the nearer of the two and the one they can act on.
    expect(syncHeadline("dry_run", true)).toBe(ownerOff);
    expect(syncHeadline("live", false)).toMatch(/is ON/);
  });

  it("nothing is MIRRORED while the owner's master switch is off, even with the key", () => {
    const facts = syncFacts("live", true);
    expect(facts.filter((f) => f.group === "mirrored")).toEqual([]);
    expect(facts.filter((f) => f.group === "pending_on_key").map((f) => f.id).sort()).toEqual(
      [...DENTALLY_WRITE_KINDS].sort(),
    );
  });

  it("tells the owner which of the two switches is in the way", () => {
    const mine = syncFacts("live", true).find((f) => f.id === "appointment.create");
    expect(mine?.detail).toMatch(/ONE thing you control/);
    expect(mine?.detail).toMatch(/System controls/);
    const theirs = syncFacts("dry_run", false).find((f) => f.id === "appointment.create");
    expect(theirs?.detail).toMatch(/waiting on the practice's Dentally write key/);
  });

  it("gives every group a title and an order", () => {
    expect(SYNC_GROUP_ORDER).toHaveLength(3);
    for (const g of SYNC_GROUP_ORDER) expect(SYNC_GROUP_TITLES[g].length).toBeGreaterThan(10);
  });

  it("heads the pending group with the switch that is actually in the way", () => {
    // THE HEADING HAS TO AGREE WITH THE BULLETS UNDER IT. Both ways of not
    // flowing land in this one group, so a heading that names the write key is
    // false whenever it is the owner's own switch that is off — and false in the
    // direction that sends him to wait on his agency for a control on the next
    // tab. Same precedence as the headline and the bullets: his switch first.
    const hisSwitch = syncGroupTitle("pending_on_key", true);
    expect(hisSwitch).toMatch(/System controls/);
    expect(hisSwitch).not.toMatch(/write key/i);
    // With his switch on, the key really is the thing missing, and it is named.
    expect(syncGroupTitle("pending_on_key", false)).toMatch(/Dentally write key/);
    // The static record is the fallback for a caller that does not know which
    // switch is off, so it may not assert either cause.
    expect(SYNC_GROUP_TITLES.pending_on_key).not.toMatch(/write key/i);
    expect(SYNC_GROUP_TITLES.pending_on_key).not.toMatch(/System controls/);
    // The other two headings are facts about Dentally, not about a switch.
    for (const g of ["mirrored", "blocked_by_governance"] as const) {
      expect(syncGroupTitle(g, true)).toBe(SYNC_GROUP_TITLES[g]);
      expect(syncGroupTitle(g, false)).toBe(SYNC_GROUP_TITLES[g]);
    }
    // The whole-record form a renderer uses says the same thing, for every group
    // and both states — it is one page's headings, so it cannot disagree with
    // itself group by group.
    for (const masterOff of [true, false]) {
      const titles = syncGroupTitles(masterOff);
      expect(Object.keys(titles).sort()).toEqual([...SYNC_GROUP_ORDER].sort());
      for (const g of SYNC_GROUP_ORDER) expect(titles[g]).toBe(syncGroupTitle(g, masterOff));
    }
  });

  it("every blocked reason has owner-facing wording, so none can render as an enum", () => {
    for (const reason of BLOCKED_REASONS) {
      expect(BLOCKED_REASON_COPY[reason].length, reason).toBeGreaterThan(40);
      expect(BLOCKED_REASON_COPY[reason]).not.toContain("_");
    }
  });
});

// ===========================================================================
// THE PANEL. Rendered as static markup, so the sentences are checked where a
// practice actually meets them rather than only where they are defined.
// ===========================================================================

const BASE: SyncStatusPayloadShape = {
  mode: "dry_run",
  target: { host: "api.dentally.co", live: true },
  master: { slug: "dentally-write-back", off: false },
  headline: syncHeadline("dry_run"),
  facts: syncFacts("dry_run"),
  counts: { dry_run: 12, queued: 0, sent: 0, failed: 1, blocked: 2 },
  total: 15,
  countCapped: false,
  intents: [],
  more: false,
  pageSize: 50,
  ledgerError: null,
};

function render(payload: SyncStatusPayloadShape): string {
  return renderToStaticMarkup(createElement(SyncStatusPanel, { data: payload }));
}

describe("the Sync Status panel renders the answer, not the enum", () => {
  it("shows all three headings and the governance sentences", () => {
    const html = render(BASE);
    // THE PAGE DERIVES THIS HEADING from the master switch on its own payload
    // (BASE.master.off is false, so it is the write-key wording that is correct
    // here). The static record stays the fallback for a caller that does not
    // know which switch is in the way — asserted on its own, above.
    expect(html).toContain(syncGroupTitle("pending_on_key", BASE.master.off));
    expect(html).toContain(SYNC_GROUP_TITLES.blocked_by_governance);
    // The mirrored heading is NOT drawn while nothing is mirrored: an empty
    // heading reads as "there is something here we could not show you".
    expect(html).not.toContain(SYNC_GROUP_TITLES.mirrored);
    expect(html).toContain("Clinical and practice notes");
    expect(html).toContain("Text messages sent to patients");
  });

  it("never blames the write key on the page once the key is armed and HIS switch is off", () => {
    // THE DAY THE AGENCY ARMS THE KEY is the day this page is read, and it is the
    // one state in which every other sentence on it is right and the middle
    // heading was wrong: headline "because you have switched it off", connection
    // "Armed for writing", five bullets "waiting on ONE thing you control". A
    // heading between them naming the write key points the owner at the party
    // who has already done their part. Nothing on this page may say it.
    const html = render({
      ...BASE,
      mode: "live",
      master: { slug: "dentally-write-back", off: true },
      headline: syncHeadline("live", true),
      facts: syncFacts("live", true),
    });
    expect(html).not.toMatch(/write key/i);
    expect(html).toContain("because you have switched it off");
    expect(html).toContain("System controls");
  });

  it("renders a BLOCKED intent with its reason in plain English", () => {
    const html = render({
      ...BASE,
      intents: [
        {
          id: "i1",
          kind: "appointment.create",
          source: "recall",
          moduleSlug: "recall",
          dentallyPatientId: "p-1",
          dentallyAppointmentId: null,
          target: "api.dentally.co",
          status: "blocked",
          blockedReason: "system_off",
          actor: "manager@example.com",
          responseId: null,
          error: null,
          createdAt: "2026-09-02T09:15:00Z",
        },
      ],
    });
    // THE ROW'S OWN PILL, not the count strip above it (W3/17: a key-independent
    // assertion is not an assertion). This used to read `toContain("Refused
    // here")`, which was satisfied by a STAT CARD LABEL that is on the page
    // whatever the table holds — so it passed for the wrong reason, and went on
    // passing while the two held-back cards counted each other's statuses. The
    // pill is a <span>; a stat label is a <p>, so this fragment can only come
    // from the row.
    expect(html).toContain(">Held back</span>");
    expect(html).toContain(BLOCKED_REASON_COPY.system_off);
    // The raw enum never reaches the screen.
    expect(html).not.toContain("system_off");
    expect(html).toContain("New appointment");
  });

  it("renders each status with owner-facing words rather than the stored value", () => {
    const statuses = ["sent", "dry_run", "queued", "failed"] as const;
    const html = render({
      ...BASE,
      intents: statuses.map((status, i) => ({
        id: `i${i}`,
        kind: "patient.update",
        source: "patient-admin",
        moduleSlug: null,
        dentallyPatientId: "p-1",
        dentallyAppointmentId: null,
        target: "api.dentally.co",
        status,
        blockedReason: null,
        actor: null,
        responseId: status === "sent" ? "pat-9" : null,
        error: status === "failed" ? "Dentally 422: date_of_birth is missing" : null,
        createdAt: "2026-09-02T09:15:00Z",
      })),
    });
    expect(html).toContain("Written to Dentally");
    expect(html).toContain("Test write");
    expect(html).toContain("Waiting to be sent");
    expect(html).toContain("Dentally refused it");
    expect(html).not.toContain(">dry_run<");
  });

  it("labels a test write against the local mock, so it cannot read as a rehearsal", () => {
    // A dry_run RAN — somewhere that is not the practice's book. Two rows that
    // looked identical in the table would let a developer's write be read as a
    // rehearsal against the real thing.
    const row = {
      id: "i1",
      kind: "appointment.create",
      source: "recall",
      moduleSlug: "recall",
      dentallyPatientId: "p-1",
      dentallyAppointmentId: null,
      status: "dry_run",
      blockedReason: null,
      actor: null,
      responseId: "appt-1",
      error: null,
      createdAt: "2026-09-02T09:15:00Z",
    };
    const mock = render({ ...BASE, intents: [{ ...row, target: "localhost:3000" }] });
    expect(mock).toContain("Test write");
    expect(mock).toContain("localhost:3000 (local mock)");

    // And a row that DID aim at the real book is not labelled a mock.
    const live = render({ ...BASE, intents: [{ ...row, target: "api.dentally.co" }] });
    expect(live).not.toContain("(local mock)");
  });

  it("renders a HELD BACK row for a staff click made while write-back was off", () => {
    const html = render({
      ...BASE,
      intents: [
        {
          id: "i2",
          kind: "patient.create",
          source: "onboarding",
          moduleSlug: "onboarding",
          dentallyPatientId: null,
          dentallyAppointmentId: null,
          target: "api.dentally.co",
          status: "blocked",
          blockedReason: "writes_disabled",
          actor: "usr_9f2b41c8",
          responseId: null,
          error: null,
          createdAt: "2026-09-02T09:15:00Z",
        },
      ],
    });
    // The row's pill again, not the stat card that carries the same two words.
    expect(html).toContain(">Held back</span>");
    expect(html).toContain(BLOCKED_REASON_COPY.writes_disabled);
    expect(html).not.toContain("writes_disabled");
  });

  it("names BOTH switches and which of them is off", () => {
    const bothOn = render({ ...BASE, mode: "live", master: { slug: "dentally-write-back", off: false } });
    expect(bothOn).toContain("Your Dentally write-back switch:");
    expect(bothOn).toContain("Armed for writing");

    const ownerOff = render({ ...BASE, mode: "live", master: { slug: "dentally-write-back", off: true } });
    expect(ownerOff).toContain(">Off<");
    const keyMissing = render({ ...BASE, mode: "dry_run" });
    expect(keyMissing).toContain("Not armed for writing");
    expect(keyMissing).toContain("your agency sets up");
  });

  it("prints a capped count as a FLOOR, never as a total", () => {
    const html = render({ ...BASE, total: 2000, countCapped: true });
    expect(html).toContain("At least 2,000");
  });

  it("prints NO count at all when the ledger could not be read, and says why", () => {
    // A zero here would state, as a fact, that nothing has ever been written.
    const html = render({
      ...BASE,
      counts: null,
      total: null,
      ledgerError: "The record of what this platform has written to Dentally could not be read just now.",
    });
    expect(html).toContain("could not be read just now");
    expect(html).not.toContain("Writes recorded");
  });

  it("says which host a write is aimed at, and whether that is the live account", () => {
    expect(render(BASE)).toContain("your live Dentally account");
    expect(render({ ...BASE, target: { host: "localhost:3000", live: false } })).toContain(
      "not your live account",
    );
  });

  it("says nothing has happened yet WITHOUT implying nothing ever will", () => {
    const html = render(BASE);
    expect(html).toContain("Nothing has been written or held back yet");
  });
});

// ===========================================================================
// THE PAGE GUARD.
//
// client-module-guard-coverage.test.ts sweeps ONE level under /c/[client], so a
// nested page is invisible to it. That is not a reason for the page to be
// unguarded; it is a reason for the guard to be asserted by name here.
// ===========================================================================

describe("the Sync Status page is locked to the same module as its parent", () => {
  it("calls requireModuleAccess(\"controls\"), awaited", () => {
    const src = readFileSync(srcPath("app/c/[client]/controls/sync/page.tsx"), "utf8");
    expect(src).toContain('await requireModuleAccess("controls")');
  });

  it("is registered with BOTH API coverage sweeps, and satisfies each", () => {
    // "Registered" means SWEPT and PASSING, not listed in an exemption. Both
    // sweeps enumerate every route.ts under src/app/api from the filesystem, so
    // this route is in both populations the moment the file exists; what has to
    // be true is that neither needs an exemption for it.
    //
    //   client-api-module-guard-coverage  every signed-in-reachable route needs
    //                                     a module lock or a returning role
    //                                     guard. This one carries requireOwnerRole.
    //   destructive-route-capability      every route exporting a WRITE method
    //                                     needs an authorisation. This one
    //                                     exports none, which is the point of it.
    const routes = walkSrc({ subdir: "app/api", extensions: [".ts"], includeDotDirs: true });
    expect(routes).toContain("app/api/dentally/sync-status/route.ts");

    const src = readFileSync(srcPath("app/api/dentally/sync-status/route.ts"), "utf8");
    // The guard shape both sweeps recognise: assigned, then RETURNED. A guard
    // whose answer is thrown away compiles, reads as a lock and does nothing.
    expect(src).toMatch(/require(?:Owner|Approver)Role\(\s*[\w.]+\s*\)(?!\s*[=!]==?\s*null)/);
    // And it is not in either exemption list.
    for (const sweep of [
      "app/api/client-api-module-guard-coverage.test.ts",
      "app/api/destructive-route-capability-coverage.test.ts",
    ]) {
      expect(readFileSync(srcPath(sweep), "utf8")).not.toContain("dentally/sync-status");
    }
  });

  it("its API route is owner-gated and read-only", () => {
    const src = readFileSync(srcPath("app/api/dentally/sync-status/route.ts"), "utf8");
    // The role guard must be RETURNED, not merely computed — the shape the
    // sibling coverage sweeps learned to insist on.
    expect(src).toMatch(/const roleDenied = requireOwnerRole\(auth\);\s*\n\s*if \(roleDenied\) return roleDenied;/);
    expect(src).toContain("requireClientAccess(auth, client.id)");
    // No write method: this route is the RECORD of the writes.
    expect(src).not.toMatch(/export\s+async\s+function\s+(POST|PATCH|PUT|DELETE)\b/);
  });
});
