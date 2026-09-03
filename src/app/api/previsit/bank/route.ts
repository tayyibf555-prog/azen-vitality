import { requireClientAccess, requireOwnerRole, requireUser } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getClient } from "@/lib/mock/clients";
import { TRIAGE_BANK, defaultConfigFor, INTEREST_TREATMENTS } from "@/lib/triage/bank";
import { projectBank, usableCustom } from "@/lib/triage/project";
import { getBanks, saveBank } from "@/lib/triage/repository";
import { TRIAGE_FORKS } from "@/lib/triage/types";
import type { TriageBankConfig, TriageCustomQuestion, TriageFork } from "@/lib/triage/types";

export const dynamic = "force-dynamic";

// ===========================================================================
// THE OWNER EDITOR'S read + write for the two question banks.
//
// OWNER-ONLY, and that is a narrower gate than the module's page carries. The
// PAGE is owner + practice manager, because she runs the interest lists; the
// BANKS are owner and agency only, because editing them changes what every
// patient in the practice is asked before their appointment, and the short list
// exists for a contractual reason the practice owner is accountable for.
// `requireOwnerRole` is also what the module-guard sweep accepts as a lock in its
// own right, so this route needs no module slug on top.
//
// WHAT THE OWNER CANNOT DO FROM HERE. Put a symptom question on the short bank.
// The write stores whatever they configure, and `projectBank` — the one function
// the public form and the submit route both resolve through — drops it. This
// route surfaces that BEFORE they save, in the `dropped` list on the GET and in
// the PUT's response, so the editor can say "this question is not being asked,
// and here is the word that stopped it" rather than silently rendering a shorter
// form than the owner configured. A silent drop is how a guard gets reported as a
// bug and then removed.
// ===========================================================================

const MAX_CUSTOM = 10;

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

async function authorise(
  clientSlug: string,
): Promise<{ ok: true; clientId: string; actor: string | null } | { ok: false; response: Response }> {
  const result = await requireUser();
  if (result instanceof Response) return { ok: false, response: result };
  const auth: AuthedUser | null = result;

  const client = getClient(clientSlug);
  if (!client) return { ok: false, response: bad("Unknown practice", 404) };

  const denied = requireClientAccess(auth, client.id);
  if (denied) return { ok: false, response: denied };
  const ownerDenied = requireOwnerRole(auth);
  if (ownerDenied) return { ok: false, response: ownerDenied };

  return { ok: true, clientId: client.id, actor: auth?.email ?? auth?.id ?? null };
}

/**
 * Both banks, plus everything the editor needs to render them: the shipped
 * question catalogue, the interest grid, and — for each fork — what the current
 * config would actually produce.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const gate = await authorise(url.searchParams.get("client") ?? "");
  if (!gate.ok) return gate.response;

  try {
    const stored = await getBanks(gate.clientId);
    const banks = TRIAGE_FORKS.map((fork) => {
      const config = stored[fork]?.config ?? defaultConfigFor(fork);
      const projected = projectBank(fork, config);
      return {
        fork,
        /** True when the practice has never edited this bank. */
        isDefault: !stored[fork],
        config,
        updatedAt: stored[fork]?.updatedAt ?? null,
        updatedBy: stored[fork]?.updatedBy ?? null,
        questions: projected.questions,
        /** What was refused and why, so the editor can say so out loud. */
        dropped: projected.dropped,
      };
    });
    return Response.json({
      ok: true,
      banks,
      // The catalogue, so the editor renders switches rather than re-declaring the
      // questions. `banks` on each entry says which list it ships in.
      library: TRIAGE_BANK,
      interest: INTEREST_TREATMENTS,
    });
  } catch (err) {
    console.error("[previsit/bank] read failed", err);
    return bad("The question lists could not be read.", 500);
  }
}

export async function PUT(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const url = new URL(request.url);
  const clientSlug =
    (typeof body.clientSlug === "string" ? body.clientSlug : "") || (url.searchParams.get("client") ?? "");
  const gate = await authorise(clientSlug);
  if (!gate.ok) return gate.response;

  const fork = body.fork as TriageFork;
  if (fork !== "full" && fork !== "brief") return bad("Unknown question list");

  const parsedConfig = parseConfig(body.config);
  if (!parsedConfig) return bad("Those question settings could not be read.");

  try {
    await saveBank(gate.clientId, fork, parsedConfig, gate.actor);
    // Return the PROJECTION of what was just saved, not an ok. The owner has to
    // see the consequence of their edit — including any question that will not be
    // asked and the exact word that stopped it — in the same round trip.
    const projected = projectBank(fork, parsedConfig);
    return Response.json({
      ok: true,
      fork,
      questions: projected.questions,
      dropped: projected.dropped,
    });
  } catch (err) {
    console.error("[previsit/bank] save failed", err);
    return bad("Those question settings were not saved.", 500);
  }
}

/**
 * Validate an incoming config. Null when it is not usable at all.
 *
 * Every custom question goes through `usableCustom`, the SAME validator the
 * projection uses, so a question that would be dropped at render time is refused
 * at save time and the owner finds out immediately. Keys are stored as given;
 * anything the bank does not know is simply never projected.
 */
function parseConfig(raw: unknown): TriageBankConfig | null {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!obj) return null;
  const enabledKeys = Array.isArray(obj.enabledKeys)
    ? obj.enabledKeys.filter((k): k is string => typeof k === "string").slice(0, 60)
    : [];
  const required: Record<string, boolean> = {};
  if (obj.required && typeof obj.required === "object" && !Array.isArray(obj.required)) {
    for (const [k, v] of Object.entries(obj.required as Record<string, unknown>)) {
      if (v === true) required[k] = true;
    }
  }
  const custom: TriageCustomQuestion[] = [];
  if (Array.isArray(obj.custom)) {
    for (const c of obj.custom.slice(0, MAX_CUSTOM)) {
      const parsed = usableCustom(c);
      if (!parsed) return null; // refuse the save rather than drop it silently
      custom.push(parsed);
    }
  }
  return { enabledKeys, required, custom };
}
