import "server-only";

import type Anthropic from "@anthropic-ai/sdk";
import { rankManualChunks } from "./chunk";
import { getAsset, listAssets, listChunksForAsset, listManuals } from "./repository";
import { CATEGORY_LABELS, type EquipmentAsset } from "./types";

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

/** The shape an asset takes in a tool result: the register's own facts, nothing else. */
function assetSummary(asset: EquipmentAsset, hasManual: boolean) {
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
    manualUploaded: hasManual,
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
      const withManual = new Set(
        (manuals ?? []).filter((m) => m.status === "ready").map((m) => m.assetId),
      );

      switch (name) {
        case "find_asset": {
          const assets = await listAssets(ctx.clientId);
          if (assets === null) {
            return JSON.stringify({ error: "The register could not be read just now. Say so rather than answering from memory." });
          }
          const query = String(input.query ?? "");
          const matches = assets.filter((a) => matchesQuery(a, query));
          return JSON.stringify({
            found: matches.length,
            assets: matches.slice(0, 25).map((a) => assetSummary(a, withManual.has(a.id))),
          });
        }

        case "list_assets": {
          const assets = await listAssets(ctx.clientId);
          if (assets === null) {
            return JSON.stringify({ error: "The register could not be read just now. Say so rather than answering from memory." });
          }
          const category = typeof input.category === "string" ? input.category : "";
          const filtered = category ? assets.filter((a) => a.category === category) : assets;
          return JSON.stringify({
            total: filtered.length,
            // The cap is the repository's ASSET_ROW_CAP; if a practice ever has
            // more than that, `total` is what was READ, and the honest thing is
            // that the model is told the number it can see rather than a number
            // nobody proved.
            assets: filtered.map((a) => assetSummary(a, withManual.has(a.id))),
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
          return JSON.stringify({
            asset: asset.name,
            manualUploaded: true,
            passages: ranked.map((r) => ({
              page: r.chunk.pageFrom === r.chunk.pageTo ? r.chunk.pageFrom : `${r.chunk.pageFrom}-${r.chunk.pageTo}`,
              text: r.chunk.body,
            })),
            note:
              ranked.length === 0
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
          return JSON.stringify({
            today: ctx.today,
            overdue,
            dueSoon,
            withinDays,
            // Named explicitly rather than left to be inferred from a shorter
            // list: "nothing is overdue" and "we do not know when 12 of these are
            // due" are different answers and the practice needs the second one.
            noServiceDateRecorded: assets.length - dated.length,
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
