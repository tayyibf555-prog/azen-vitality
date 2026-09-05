import "server-only";

import type Anthropic from "@anthropic-ai/sdk";
import { rankManualChunks } from "./chunk";
import { getAsset, listAssets, listChunksForAsset, listManuals } from "./repository";
import {
  CATEGORY_LABELS,
  MANUAL_CHUNK_READ_CAP,
  REGISTER_READ_CAP,
  type EquipmentAsset,
} from "./types";

// ===========================================================================
// THE EQUIPMENT AGENT'S TOOLS.
//
// FOUR TOOLS, ALL READ-ONLY, ALL SCOPED TO ONE PRACTICE'S REGISTER. There is no
// write tool, no send tool and no Dentally tool in this module and there must
// never be: everything this agent can do is answer from what the practice has
// already put in front of it.
//
// The dispatch mirrors `makeCopilotDispatch` (src/lib/copilot/tools.ts): a
// refusal for any name outside the set is the FIRST statement, before anything is
// parsed or awaited and deliberately outside the try/catch, so a model that
// invents a tool name — or one pushed at it by text inside an uploaded manual —
// gets nothing rather than an error it can probe.
// ===========================================================================

export const EQUIPMENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "find_asset",
    description:
      "Find equipment on the practice's register by name, make, model, serial or room. Returns each match with its id, category, location, supplier and service dates, and whether a manual has been uploaded for it. Use this first whenever a question is about a specific machine, and use the id it returns when calling search_manual.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name, make, model, serial number or room" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_assets",
    description:
      "List the practice's registered equipment, optionally filtered to one category. Use for 'what equipment do we have', 'what is in the decon room', or when you need to see everything before answering.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: `Optional. One of: ${Object.keys(CATEGORY_LABELS).join(", ")}`,
        },
      },
    },
  },
  {
    name: "search_manual",
    description:
      "Search the uploaded manual for ONE asset and return the passages that match, each with the page it came from. Use this before answering anything the manual could answer — a fault code, a cycle, a setting, a consumable, a cleaning or loading instruction. If it returns nothing, the manual does not cover it: say so rather than answering from general knowledge.",
    input_schema: {
      type: "object",
      properties: {
        assetId: { type: "string", description: "The asset id from find_asset or list_assets" },
        query: { type: "string", description: "What to look for, e.g. 'E04' or 'water reservoir'" },
      },
      required: ["assetId", "query"],
    },
  },
  {
    name: "service_due",
    description:
      "List equipment by service date: what is overdue, and what is due within the number of days given. Use for 'what is due', 'what have we missed', or when a question turns on whether a machine is in date. State plainly what the register says; do not advise on whether an overdue machine may be used.",
    input_schema: {
      type: "object",
      properties: {
        withinDays: { type: "number", description: "Look ahead this many days (default 90)" },
      },
    },
  },
];

const TOOL_NAMES = new Set(EQUIPMENT_TOOLS.map((t) => t.name));

/** The sentence handed back for a tool this agent does not have. */
export function equipmentToolRefusal(): string {
  return JSON.stringify({
    error:
      "That tool is not available to the equipment desk. It can only read the practice's equipment register and the manuals uploaded against it.",
  });
}

/**
 * The shape an asset takes in a tool result: the register's own facts, nothing else.
 *
 * `hasManual` is THREE-VALUED, and the third value is the point. `null` means the
 * manual index could not be read at all, and the key is then OMITTED rather than
 * written `false` — see MANUAL_INDEX_UNREADABLE_NOTE below for why a stamped
 * `false` is the dangerous answer here.
 */
function assetSummary(asset: EquipmentAsset, hasManual: boolean | null) {
  return {
    id: asset.id,
    name: asset.name,
    category: CATEGORY_LABELS[asset.category],
    make: asset.make,
    model: asset.model,
    serial: asset.serial,
    room: asset.room,
    supplier: asset.supplier,
    supplierPhone: asset.supplierPhone,
    purchasedOn: asset.purchasedOn,
    lastServicedOn: asset.lastServicedOn,
    nextServiceDue: asset.nextServiceDue,
    notes: asset.notes,
    // OMITTED, not `false`, when the manual index could not be read. A model
    // handed `manualUploaded: false` has been told a fact; a model handed
    // nothing has to ask, and the note beside it tells it to.
    ...(hasManual === null ? {} : { manualUploaded: hasManual }),
  };
}

/** Text match over the fields a person would search by. */
function matchesQuery(asset: EquipmentAsset, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [asset.name, asset.make, asset.model, asset.serial, asset.room, asset.notes]
    .filter((v): v is string => Boolean(v))
    .some((v) => v.toLowerCase().includes(q));
}

// ---------------------------------------------------------------------------
// THE REGISTER READ IS BOUNDED, AND EVERY TOOL RESULT SAYS SO WHEN IT MATTERS.
//
// `listAssets` stops at REGISTER_READ_CAP rows and hands back a bare array, so
// the only evidence a caller has that it was cut short is the length itself. A
// figure taken off a read at its own bound is a floor, not a total (programme
// ruling W3/11), and the model has no way to know that unless it is told: left
// alone it reads `total: 400`, repeats it to the practice, and answers "we have
// no such machine" about everything in the unread tail.
//
// So a capped read swaps `total` for `atLeast` and carries the sentence below.
// The key CHANGES rather than gaining a sibling flag on purpose — a model that
// ignores a `truncated: true` it did not expect still prints `total`, whereas
// there is no bare total left for it to print.
// ---------------------------------------------------------------------------

/** TRUE when the read came back at its own bound and may therefore be partial. */
function registerIsCapped(assets: EquipmentAsset[]): boolean {
  return assets.length >= REGISTER_READ_CAP;
}

const REGISTER_CAPPED_NOTE =
  `The register is larger than this desk reads in one go (${REGISTER_READ_CAP} entries, ordered by category then name), so this is a floor and not a total. Say "at least" rather than a number, and never tell anyone a machine is not registered on the strength of this list — say you could not find it on the part of the register you can see, and suggest checking the Register tab.`;

// ---------------------------------------------------------------------------
// AN UNREADABLE MANUAL INDEX IS "WE DO NOT KNOW", NEVER "THERE IS NO MANUAL".
//
// `listManuals` returns null when its read fails — a distinct value from the
// empty array precisely so a caller cannot confuse the two — and this dispatch
// used to collapse them with `manuals ?? []`. The result was not a missing
// caveat, it was a false statement about every asset at once: `manualUploaded:
// false` on all of them, from which the model says "there is no manual for the
// autoclave, you can upload one on the Manuals tab" about a manual that is
// stored, indexed and searchable.
//
// AND THE TWO HALVES OF ONE TURN THEN CONTRADICT EACH OTHER, which is the part
// that makes this worse than an ordinary wrong answer. `search_manual` reads
// `equipment_manual_chunk` directly and is unaffected by this failure, so in the
// same conversation the desk quotes page 14 of a manual it has just said does not
// exist. Whoever is standing at the machine has to decide which half to believe.
//
// So the key is dropped from every summary and this sentence goes in its place.
// It names the tool that still works, because "we do not know" without a next
// step is how a model fills the gap on its own.
// ---------------------------------------------------------------------------
const MANUAL_INDEX_UNREADABLE_NOTE =
  "Whether each machine has a manual could not be read just now, so these entries do not say and neither may you. Never tell anyone a machine has no manual on the strength of this, and never invite anyone to upload one that may already be there: search_manual reads the manual's own text and is unaffected, so use it, and only say a manual is missing if search_manual itself says so.";

/** TRUE when the manual read came back at its own bound, so later pages went unsearched. */
function manualIsCapped(chunks: { ordinal: number }[]): boolean {
  return chunks.length >= MANUAL_CHUNK_READ_CAP;
}

/**
 * THE SENTENCE THAT REPLACES "THE MANUAL DOES NOT COVER THIS".
 *
 * The ordinary empty-result note tells the model to say, plainly, that the
 * practice's own manual does not cover the thing asked about. That is only true
 * when the whole manual was searched. `listChunksForAsset` stops at
 * MANUAL_CHUNK_READ_CAP passages in page order, so on a long manual the ranking
 * never saw the back of the book — and "the manual does not cover E27" about a
 * fault table on page 361 is not a hedge, it is a false statement that sends a
 * nurse away from the answer she is holding (programme ruling W3/11, and §0/5:
 * a truncated read never wears a complete one's clothes).
 */
const MANUAL_CAPPED_NOTE =
  `This manual is longer than the desk reads in one go: only its first ${MANUAL_CHUNK_READ_CAP} passages were searched, in page order, so the later pages were not looked at. Never say the manual does not cover something on the strength of this search — say you could not find it in the part you can read, and point at the supplier or engineer on the asset's record.`;

/** Whole days from today (London date strings) to an ISO date. Negative = past. */
function daysUntil(today: string, iso: string): number {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.round((b - a) / 86_400_000);
}

export interface EquipmentDispatchContext {
  clientId: string;
  /** Today as YYYY-MM-DD in London, passed in so nothing here reads a clock. */
  today: string;
}

export function makeEquipmentDispatch(ctx: EquipmentDispatchContext) {
  return async function dispatch(name: string, input: Record<string, unknown>): Promise<string> {
    // THE GATE. First statement, before anything is parsed, read or awaited, and
    // deliberately outside the try/catch: a refusal is not an error.
    if (!TOOL_NAMES.has(name)) return equipmentToolRefusal();

    try {
      // Loaded once per call rather than cached across calls: the register is
      // small, a turn makes at most a handful of calls, and a stale register in
      // the middle of a conversation is how somebody is told an asset they just
      // added does not exist.
      const manuals = await listManuals(ctx.clientId);
      // NULL SURVIVES THE JOURNEY. `listManuals` distinguishes "no manuals" from
      // "could not read the manuals", and so does everything downstream of here:
      // a null set means the manual column is unknown, not empty.
      const withManual: ReadonlySet<string> | null =
        manuals === null
          ? null
          : new Set(manuals.filter((m) => m.status === "ready").map((m) => m.assetId));
      /** What one asset's manual state is, for a summary: true, false, or unknown. */
      const manualState = (assetId: string): boolean | null =>
        withManual === null ? null : withManual.has(assetId);

      switch (name) {
        case "find_asset": {
          const assets = await listAssets(ctx.clientId);
          if (assets === null) {
            return JSON.stringify({ error: "The register could not be read just now. Say so rather than answering from memory." });
          }
          const query = String(input.query ?? "");
          const matches = assets.filter((a) => matchesQuery(a, query));
          const shown = matches.slice(0, 25);
          const capped = registerIsCapped(assets);
          // Both caveats can be true at once — a capped register read whose
          // manual index also failed — and both sentences then go out. Joining
          // them keeps ONE `note` key: a second key beside it is a key a model
          // may not read.
          const notes = [
            ...(capped ? [REGISTER_CAPPED_NOTE] : []),
            ...(withManual === null ? [MANUAL_INDEX_UNREADABLE_NOTE] : []),
          ];
          return JSON.stringify({
            // `found` is a count of matches within what was READ. When the read
            // was itself at its bound, or when there are more matches than the
            // 25 returned, the count is a floor and says so rather than passing
            // for a complete answer.
            ...(capped ? { foundAtLeast: matches.length } : { found: matches.length }),
            ...(shown.length < matches.length ? { showing: shown.length } : {}),
            assets: shown.map((a) => assetSummary(a, manualState(a.id))),
            ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
          });
        }

        case "list_assets": {
          const assets = await listAssets(ctx.clientId);
          if (assets === null) {
            return JSON.stringify({ error: "The register could not be read just now. Say so rather than answering from memory." });
          }
          const category = typeof input.category === "string" ? input.category : "";
          const filtered = category ? assets.filter((a) => a.category === category) : assets;
          const capped = registerIsCapped(assets);
          const notes = [
            ...(capped ? [REGISTER_CAPPED_NOTE] : []),
            ...(withManual === null ? [MANUAL_INDEX_UNREADABLE_NOTE] : []),
          ];
          return JSON.stringify({
            // The cap is the repository's ASSET_ROW_CAP. Below it, `total` is a
            // real total. AT it, there is no total to give — only a floor — and
            // the key says so, because a number nobody proved must not be handed
            // to the model wearing the name of one.
            ...(capped ? { atLeast: filtered.length } : { total: filtered.length }),
            assets: filtered.map((a) => assetSummary(a, manualState(a.id))),
            ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
          });
        }

        case "search_manual": {
          const assetId = String(input.assetId ?? "").trim();
          const query = String(input.query ?? "").trim();
          if (!assetId) return JSON.stringify({ error: "No asset id. Call find_asset first." });

          // TENANCY, and it is checked here rather than trusted from the model:
          // an assetId is a value the model produced, and the only thing that
          // makes it this practice's asset is this read, which is scoped by
          // client_id in its own WHERE clause.
          const asset = await getAsset(ctx.clientId, assetId);
          if (!asset) return JSON.stringify({ error: "That asset is not on this practice's register." });

          const chunks = await listChunksForAsset(ctx.clientId, assetId);
          if (chunks === null) {
            return JSON.stringify({ error: "The manual could not be read just now. Say so rather than answering from memory." });
          }
          if (chunks.length === 0) {
            return JSON.stringify({
              asset: asset.name,
              manualUploaded: false,
              passages: [],
              note: "No readable manual has been uploaded for this asset. Say so, and say it can be uploaded on the Manuals tab.",
            });
          }

          const ranked = rankManualChunks(query, chunks, 5);
          const capped = manualIsCapped(chunks);
          return JSON.stringify({
            asset: asset.name,
            manualUploaded: true,
            // The bound is reported whether or not anything ranked: a hit found
            // in the first 900 passages may still not be the BEST passage, and
            // the model is the only thing that can hedge a page citation.
            ...(capped ? { searchedFirstPassages: MANUAL_CHUNK_READ_CAP } : {}),
            passages: ranked.map((r) => ({
              page: r.chunk.pageFrom === r.chunk.pageTo ? r.chunk.pageFrom : `${r.chunk.pageFrom}-${r.chunk.pageTo}`,
              text: r.chunk.body,
            })),
            note: capped
              ? MANUAL_CAPPED_NOTE
              : ranked.length === 0
                ? "The manual does not cover this. Say so plainly and do not answer from general knowledge; if it is a fault, hand over to the supplier or engineer."
                : undefined,
          });
        }

        case "service_due": {
          const assets = await listAssets(ctx.clientId);
          if (assets === null) {
            return JSON.stringify({ error: "The register could not be read just now. Say so rather than answering from memory." });
          }
          const withinDays = typeof input.withinDays === "number" && input.withinDays > 0 ? Math.min(input.withinDays, 730) : 90;
          const dated = assets.filter((a) => Boolean(a.nextServiceDue));
          const overdue: unknown[] = [];
          const dueSoon: unknown[] = [];
          for (const asset of dated) {
            const days = daysUntil(ctx.today, asset.nextServiceDue as string);
            if (Number.isNaN(days)) continue;
            const entry = { name: asset.name, due: asset.nextServiceDue, days, supplier: asset.supplier, supplierPhone: asset.supplierPhone };
            if (days < 0) overdue.push(entry);
            else if (days <= withinDays) dueSoon.push(entry);
          }
          const capped = registerIsCapped(assets);
          return JSON.stringify({
            today: ctx.today,
            overdue,
            dueSoon,
            withinDays,
            // Named explicitly rather than left to be inferred from a shorter
            // list: "nothing is overdue" and "we do not know when 12 of these are
            // due" are different answers and the practice needs the second one.
            noServiceDateRecorded: assets.length - dated.length,
            // "Which equipment is overdue?" is the question this register exists
            // to answer and the one W1-D/2 says is ALWAYS answered. When the read
            // was capped, an empty `overdue` no longer means "nothing is
            // overdue" — it means "nothing overdue in the part I can see", and
            // the difference is a statutory test nobody is told about.
            ...(capped
              ? {
                  registerCapped: true,
                  note: `${REGISTER_CAPPED_NOTE} In particular an empty overdue list here means "nothing overdue in the part of the register I can read", not "nothing is overdue" — say it that way.`,
                }
              : {}),
          });
        }

        default:
          return equipmentToolRefusal();
      }
    } catch (err) {
      console.error(`[equipment] tool ${name} failed`, err);
      return JSON.stringify({ error: "That lookup failed. Say so rather than answering from memory." });
    }
  };
}
