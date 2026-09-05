// ===========================================================================
// THE MIDDLE HEADING ON THE DENTALLY SYNC PAGE NAMES THE SWITCH THAT IS
// ACTUALLY IN THE WAY (ruling W3/11's sibling: a screen says the precise
// cause, never a neutral one it could have been precise about).
//
// THE DEFECT this pins. `pending_on_key` is reached by EITHER switch being off
// — the owner's own master switch, or the write key the agency arms — so
// src/lib/dentally/sync-surface.ts holds a CAUSE-NEUTRAL record
// (SYNC_GROUP_TITLES) as the safe answer for a caller that does not know which,
// and a derived `syncGroupTitle(group, masterOff)` for a caller that does. This
// page has always known: `master.off` is on its payload and is rendered as a
// bullet nine lines above the heading. It printed the neutral record anyway.
//
// The state where that costs somebody a week is the day the agency arms the
// key with the owner's own switch still off: the headline says "because you
// have switched it off", the connection says "Armed for writing", every bullet
// says "waiting on ONE thing you control" — and a heading between them saying
// "Built and ready, not flowing yet" is the one line on the page that does not
// tell him it is his to flip. (The older form of that heading named the write
// key outright, which pointed him at the party who had already done their part;
// sync-surface.test.ts pins that the neutral record may never name either.)
//
// Asserted on the RENDERED PANEL, in both switch states, because the claim is
// about what the page prints and not about what the record holds — the record
// is pinned next door, and it went on being right while the page ignored it.
// ===========================================================================
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SyncStatusPanel, type SyncStatusPayloadShape } from "./sync-status-view";
import {
  SYNC_GROUP_TITLES,
  syncFacts,
  syncGroupTitle,
  syncHeadline,
} from "@/lib/dentally/sync-surface";

/** The deployment as it stands today: the key is not armed, his switch is on. */
const WAITING_ON_THE_KEY: SyncStatusPayloadShape = {
  mode: "dry_run",
  target: { host: "api.dentally.co", live: true },
  master: { slug: "dentally-write-back", off: false },
  headline: syncHeadline("dry_run", false),
  facts: syncFacts("dry_run", false),
  counts: { dry_run: 0, queued: 0, sent: 0, failed: 0, blocked: 4 },
  total: 4,
  countCapped: false,
  intents: [],
  more: false,
  pageSize: 50,
  ledgerError: null,
};

/** The day the agency arms the key and the owner has not flipped his own. */
const WAITING_ON_HIS_SWITCH: SyncStatusPayloadShape = {
  ...WAITING_ON_THE_KEY,
  mode: "live",
  master: { slug: "dentally-write-back", off: true },
  headline: syncHeadline("live", true),
  facts: syncFacts("live", true),
};

const render = (data: SyncStatusPayloadShape): string =>
  renderToStaticMarkup(createElement(SyncStatusPanel, { data }));

describe("the sync page heads the pending group with the switch in the way", () => {
  it("names the owner's own switch while HIS switch is the one that is off", () => {
    const html = render(WAITING_ON_HIS_SWITCH);
    expect(html).toContain(syncGroupTitle("pending_on_key", true));
    expect(html).toContain("System controls");
    // The whole point of the state: the key is armed, so nothing on this page —
    // heading included — may send him back to his agency.
    expect(html).not.toMatch(/write key/i);
  });

  it("names the write key once his switch is on and the key is what is missing", () => {
    const html = render(WAITING_ON_THE_KEY);
    expect(html).toContain(syncGroupTitle("pending_on_key", false));
    expect(html).toMatch(/Dentally write key/);
  });

  it("never falls back to the cause-neutral heading, in either state", () => {
    // THE MUTATION CATCHER. `SYNC_GROUP_TITLES[group]` is the fallback for a
    // caller that cannot know which switch is off; a page holding `master.off`
    // that prints it has thrown away the only thing it knew that the record
    // did not. Both states, because a fallback that is right in one of them is
    // exactly how this survived the first time.
    for (const data of [WAITING_ON_THE_KEY, WAITING_ON_HIS_SWITCH]) {
      expect(render(data)).not.toContain(SYNC_GROUP_TITLES.pending_on_key);
    }
  });

  it("leaves the two headings that are facts about Dentally where they were", () => {
    // Only the middle group is about a switch. "Stays in this platform" is a
    // fact about somebody else's API and does not move when a switch does.
    for (const data of [WAITING_ON_THE_KEY, WAITING_ON_HIS_SWITCH]) {
      expect(render(data)).toContain(SYNC_GROUP_TITLES.blocked_by_governance);
    }
    // And the mirrored heading is drawn only when something really is mirrored.
    const flowing = render({
      ...WAITING_ON_THE_KEY,
      mode: "live",
      master: { slug: "dentally-write-back", off: false },
      headline: syncHeadline("live", false),
      facts: syncFacts("live", false),
    });
    expect(flowing).toContain(SYNC_GROUP_TITLES.mirrored);
    expect(render(WAITING_ON_THE_KEY)).not.toContain(SYNC_GROUP_TITLES.mirrored);
  });
});
