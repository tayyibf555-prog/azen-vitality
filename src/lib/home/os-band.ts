import "server-only";

// ===========================================================================
// THE OPERATING SYSTEM BAND — what the platform is running, on the front door.
//
// THE PROBLEM. Wave 1 added five surfaces (the write-back ledger, the pre-visit
// questions, the equipment desk, the IT desk, the co-pilot's approved sources)
// and every one of them landed as a module in a list. Nothing on Home said any
// of them existed, nothing said whether they were switched on, and nothing said
// whether they had anything in them. A practice signing in saw a dashboard of
// Dentally's numbers and a worklist, and had to go looking to find out whether
// the platform's own systems were doing anything at all. That is a pile of
// modules, not an operating system.
//
// So Home gains one compact band: a tile per system, its switch state, ONE live
// number, and a click through. It is the answer to "is the machine running", in
// the place the day starts.
//
// FOUR RULES IT IS BUILT ON.
//
// 1. NO NEW DENTALLY READS. Every figure here comes from our own database or is
//    already on the page. The home page already spends a Dentally budget on the
//    dashboard; a status band must not add to it, and the numbers it wants —
//    enquiries waiting, questionnaires out, writes held back, machines overdue —
//    are ours anyway.
//
// 2. A MODULE THAT IS OFF SAYS "OFF", NOT "0". Printing a zero for a system
//    nobody switched on is the most expensive kind of dishonesty available on a
//    dashboard: it reads as "nothing needs doing" when the truth is "nothing is
//    watching". An off tile prints its state and the one thing to do first, and
//    its read is not even ISSUED — which is also why a practice on day one pays
//    for one query, not six.
//
//    THE ONE EXCEPTION IS DELIBERATE. Dentally write-back's number is the count
//    of writes it HELD BACK, which exists precisely because it is off and is the
//    reason the owner would go and look. `countsWhileOff` marks it, and only it.
//
// 3. A FAILED READ NEVER WEARS A NUMBER'S CLOTHES. Every read is wrapped; a
//    failure yields `null`, which the tile prints as "Not readable just now".
//    An empty table and an unreachable one are different facts.
//
// 4. A NUMBER AT ITS CAP IS A FLOOR, NOT A TOTAL. Each read is bounded, and a
//    read that comes back at the bound sets `atLeast`, which the tile renders as
//    "at least N". (The honest-numbers rule, section 0 item 5 of the charter.)
//
// WHO SEES A TILE is decided by ONE predicate and not by a second list: a tile
// appears only if `canRoleAccessModule` says the role may open the module the
// tile links to. So the practice manager's band is her operational subset by
// construction — she has the pre-visit questions, the equipment register and the
// IT desk, and she has no System controls, so she has no write-back or
// automations tile — and a clinician, who has none of them, gets no band at all.
// ===========================================================================

import { canRoleAccessModule } from "@/lib/nav";
import type { Role } from "@/lib/types";
import { SYSTEM_BY_SLUG } from "@/lib/systems/catalog";
import { firstStepFor } from "@/lib/systems/first-steps";
import { getSystemStates } from "@/lib/systems/repository";
import { countWriteIntents } from "@/lib/dentally/sync-ledger";
import { ASSET_ROW_CAP, listAssets } from "@/lib/equipment/repository";
import { getItContact } from "@/lib/itdesk/repository";
import { listLeads } from "@/lib/speed-to-lead/repository";
import { listTargets } from "@/lib/triage/repository";

/** The most rows any one tile's read will pull. A tile is a figure, not a report. */
export const TILE_ROW_CAP = 200;

export interface OsTileDef {
  key: string;
  /** What the practice calls it. Never a slug. */
  label: string;
  /** The module the tile opens, and the role gate that decides if it is drawn. */
  moduleSlug: string;
  /**
   * Path appended under the module, for a surface that is a TAB of one.
   *
   * ONLY THE STAFF TREE CAN FOLLOW IT. /c/[client]/controls/sync is a real
   * route; /owner/[client] resolves a single dynamic `[module]` segment and
   * cannot route a nested page (see the note in systems-view.tsx), so the owner
   * shell gets the module path and the tab it wants is the second one on the
   * screen it lands on. Linking an owner at a nested path would 404 them.
   */
  subPath?: string;
  /** The system switch that governs it, or null when the surface has no switch. */
  systemSlug: string | null;
  /**
   * Whether the number still means something while the system is off. True for
   * exactly one tile: writes held back accrue BECAUSE write-back is off.
   */
  countsWhileOff: boolean;
}

/**
 * The band, in reading order: the day's enquiries, then the patient-facing
 * questions, then the two desks, then what does and does not reach Dentally,
 * then the switches themselves.
 */
export const OS_TILES: readonly OsTileDef[] = [
  {
    key: "leads",
    label: "Leads",
    moduleSlug: "speed-to-lead",
    systemSlug: "speed-to-lead",
    countsWhileOff: false,
  },
  {
    key: "pre-visit",
    label: "Pre-visit questions",
    moduleSlug: "pre-visit-triage",
    systemSlug: "pre-visit-triage",
    countsWhileOff: false,
  },
  {
    key: "equipment",
    label: "Equipment",
    moduleSlug: "equipment",
    systemSlug: "equipment",
    countsWhileOff: false,
  },
  {
    key: "it-desk",
    label: "IT desk",
    moduleSlug: "it-desk",
    systemSlug: "it-desk",
    countsWhileOff: false,
  },
  {
    key: "write-back",
    label: "Dentally write-back",
    moduleSlug: "controls",
    subPath: "/sync",
    systemSlug: "dentally-write-back",
    countsWhileOff: true,
  },
  {
    key: "automations",
    label: "Automations",
    moduleSlug: "controls",
    // No switch of its own: this tile IS the switches. `System controls` is
    // never a controllable system (see the systems catalog's own header), so
    // giving it one here would invent a lever that does not exist.
    systemSlug: null,
    countsWhileOff: true,
  },
] as const;

/** What a tile prints where a figure goes. Exactly one of these is true. */
export type OsTileState =
  /** The system is switched off, and its number would be a zero that lies. */
  | { kind: "off"; firstStep: string | null }
  /**
   * Switched ON, but nothing has been put in it yet. A DIFFERENT fact from
   * "off" and from "0": an empty equipment register under a running desk is a
   * setup step outstanding, not a system halted, and the two must not print the
   * same word or the owner switches on something that was already on.
   */
  | { kind: "empty"; firstStep: string | null }
  /** A figure, honestly bounded. */
  | { kind: "figure"; value: number; noun: string; atLeast: boolean; tone: OsTone }
  /** A fact that is not a number (a name is set, or it is not). */
  | { kind: "fact"; text: string; tone: OsTone }
  /** The read failed. Never an empty table, never a zero. */
  | { kind: "unreadable" };

/** How urgently the tile reads. `attention` is the only one that colours. */
export type OsTone = "neutral" | "attention";

export interface OsTile {
  key: string;
  label: string;
  /** Path under the shell base, e.g. "/controls/sync". */
  path: string;
  /** Null when the surface has no switch at all (the automations tile). */
  enabled: boolean | null;
  state: OsTileState;
}

export interface OsBand {
  tiles: OsTile[];
  /** True when the switch states could not be read: the whole band is unreliable. */
  switchesUnreadable: boolean;
}

/** Run a read and turn any failure into null, loudly. */
async function attempt<T>(what: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    console.error(`[os-band] ${what} failed`, err);
    return null;
  }
}

export interface OsBandInput {
  clientId: string;
  /** The sites the top bar currently has in scope, as every display surface uses. */
  siteIds: string[];
  /** The verified role, or null where sign-in is not configured (shows everything). */
  role: Role | null;
  /**
   * Which shell the band is being drawn in. It decides one thing only: whether a
   * tile's `subPath` is followed, because the owner tree has no nested routes.
   * Defaults to the staff shell, which is the tree with the most routes and the
   * one a missing argument most likely means.
   */
  tree?: "client" | "owner";
}

/**
 * Build the band. One switch read, then at most one read per ON tile, all in
 * parallel. A practice with everything off (which is every practice on day one)
 * pays for the switch read and the write-back count and nothing else.
 */
export async function readOsBand(input: OsBandInput): Promise<OsBand> {
  const visible = OS_TILES.filter(
    (t) => input.role === null || canRoleAccessModule(input.role, t.moduleSlug),
  );
  if (visible.length === 0) return { tiles: [], switchesUnreadable: false };

  const states = await attempt("getSystemStates", () => getSystemStates(input.clientId));
  const enabledBySlug = new Map((states ?? []).map((s) => [s.slug, s.enabled]));

  // A tile is READ only when its system is on, or when its number counts while
  // off. Everything else is answered from the switch alone.
  const needed = visible.filter((t) => {
    if (t.systemSlug === null) return true; // the automations tile reads the switches themselves
    if (states === null) return false; // switches unknown: read nothing, say so
    if (t.countsWhileOff) return true;
    return enabledBySlug.get(t.systemSlug) === true;
  });

  const results = new Map<string, OsTileState>();
  await Promise.all(
    needed.map(async (tile) => {
      results.set(tile.key, await readTile(tile, input, states));
    }),
  );

  const tiles: OsTile[] = visible.map((tile) => {
    const enabled = tile.systemSlug === null ? null : enabledBySlug.get(tile.systemSlug) ?? null;
    const state: OsTileState =
      results.get(tile.key) ??
      (states === null
        ? { kind: "unreadable" }
        : { kind: "off", firstStep: firstStepFor(tile.systemSlug ?? tile.key)?.step ?? null });
    return {
      key: tile.key,
      label: tile.label,
      path: `/${tile.moduleSlug}${input.tree === "owner" ? "" : tile.subPath ?? ""}`,
      enabled: states === null ? null : enabled,
      state,
    };
  });

  return { tiles, switchesUnreadable: states === null };
}

async function readTile(
  tile: OsTileDef,
  input: OsBandInput,
  states: Array<{ slug: string; enabled: boolean }> | null,
): Promise<OsTileState> {
  switch (tile.key) {
    case "leads": {
      // AWAITING A FIRST CONTACT. "new" is the stage a lead sits in until
      // something picks it up; "contacting" is a claim in flight and is
      // deliberately excluded, because a lead somebody is mid-way through
      // texting is not a lead waiting for a person.
      const rows = await attempt("listLeads", () =>
        listLeads({ siteIds: input.siteIds, stages: ["new"], limit: TILE_ROW_CAP + 1 }),
      );
      if (rows === null) return { kind: "unreadable" };
      return figure(rows.length, "awaiting first contact", "attention");
    }
    case "pre-visit": {
      const rows = await attempt("listTargets", () =>
        listTargets({ siteIds: input.siteIds, statuses: ["sent"], limit: TILE_ROW_CAP + 1 }),
      );
      if (rows === null) return { kind: "unreadable" };
      return figure(rows.length, "sent, awaiting an answer", "neutral");
    }
    case "equipment": {
      const assets = await attempt("listAssets", () => listAssets(input.clientId));
      if (assets === null) return { kind: "unreadable" };
      if (assets.length === 0) {
        return { kind: "empty", firstStep: firstStepFor("equipment")?.step ?? null };
      }
      const today = new Date().toISOString().slice(0, 10);
      const overdue = assets.filter((a) => a.nextServiceDue !== null && a.nextServiceDue < today);
      // THE REGISTER READ IS ITSELF BOUNDED (ASSET_ROW_CAP), so a practice at the
      // bound has been counted only as far as the bound. Both figures below are
      // then FLOORS, and both say so — "1 registered, none overdue" printed off a
      // truncated register would be a total the read never proved.
      const truncated = assets.length >= ASSET_ROW_CAP;
      // OVERDUE IS THE ONE THING THIS TILE SHOUTS ABOUT, and the programme's
      // equipment safety ruling is why: a machine past a statutory or safety
      // test is taken out of use, not judged. Zero overdue is a good number and
      // is printed plainly.
      if (overdue.length > 0) {
        return {
          kind: "figure",
          value: overdue.length,
          noun: "overdue a service",
          atLeast: truncated,
          tone: "attention",
        };
      }
      return {
        kind: "fact",
        text: truncated
          ? `at least ${assets.length} registered, none overdue so far`
          : `${assets.length} registered, none overdue`,
        tone: "neutral",
      };
    }
    case "it-desk": {
      const contact = await attempt("getItContact", () => getItContact(input.clientId));
      if (contact === null) return { kind: "unreadable" };
      const named = contact.name?.trim() || contact.company?.trim() || "";
      return named
        ? { kind: "fact", text: `Escalates to ${named}`, tone: "neutral" }
        : { kind: "fact", text: "No IT contact set", tone: "attention" };
    }
    case "write-back": {
      const counted = await attempt("countWriteIntents", () => countWriteIntents(input.clientId));
      if (counted === null) return { kind: "unreadable" };
      const blocked = counted.counts.blocked;
      return blocked === 0
        ? { kind: "fact", text: "Nothing held back", tone: "neutral" }
        : {
            kind: "figure",
            value: blocked,
            noun: "held back",
            atLeast: counted.capped,
            tone: "attention",
          };
    }
    case "automations": {
      if (states === null) return { kind: "unreadable" };
      const running = states.filter((s) => s.enabled).length;
      return {
        kind: "fact",
        text: `${running} of ${states.length} running`,
        tone: running === 0 ? "attention" : "neutral",
      };
    }
    default:
      return { kind: "unreadable" };
  }
}

/**
 * A figure with the cap turned into honesty: a read that came back at its bound
 * knows only that there are AT LEAST that many, and says so.
 */
function figure(rowCount: number, noun: string, tone: OsTone = "neutral"): OsTileState {
  const atLeast = rowCount > TILE_ROW_CAP;
  return {
    kind: "figure",
    value: atLeast ? TILE_ROW_CAP : rowCount,
    noun,
    atLeast,
    tone: rowCount > 0 && tone === "attention" ? "attention" : "neutral",
  };
}

/** The system a tile's switch state comes from, for the tests and the view. */
export function tileSystemLabel(tile: OsTileDef): string | null {
  return tile.systemSlug ? SYSTEM_BY_SLUG.get(tile.systemSlug)?.label ?? null : null;
}
