import { requireClientAccess, requireOwnerRole, requireUser } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getClient } from "@/lib/mock/clients";
import { TRIAGE_BANK, defaultConfigFor, INTEREST_TREATMENTS } from "@/lib/triage/bank";
import { projectBank, usableCustom } from "@/lib/triage/project";
import type { DroppedQuestion } from "@/lib/triage/project";
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
// WHAT THE OWNER CANNOT DO FROM HERE, AND THE TWO DIFFERENT ANSWERS THEY GET.
//
// 1. A QUESTION THE PRACTICE WROTE ITSELF IS REFUSED AT SAVE (ruling W3/3). A
//    custom question carrying a funding word — in its label, or in any of its
//    option labels or values — is refused for BOTH banks, and one carrying a
//    symptom word is refused for the short bank, with a 400 naming the question
//    and the exact word that stopped it. Nothing is written. This half used to be
//    missing: `parseConfig` ran only `usableCustom`, which checks the SHAPE of a
//    question and neither of the two scans, so an owner who wrote "How would you
//    like to pay?" with "On the NHS" among its answers got a 200, the strings
//    were stored in `previsit_bank.config` for good, and the question was dropped
//    silently every time the form rendered. The projection was fail-closed, so no
//    patient ever saw it — but a refusal nobody can miss is what the ruling asked
//    for, and forbidden words do not sit at rest in a jsonb column.
//
//    THE SCANS ARE RUN THROUGH `projectBank` ITSELF, not re-implemented here.
//    Two copies of an admission rule are two rules, and the one on the save path
//    is the one nobody re-reads. Whatever the projection would drop for a
//    forbidden word, this refuses.
//
// 2. A SHIPPED BANK QUESTION SWITCHED ON FOR THE WRONG FORK IS STORED AND
//    REPORTED. Switching, say, a symptom question on for the short bank is a
//    supported thing to attempt — the practice may be looking at the catalogue
//    rather than writing copy — so the config is saved as configured and
//    `projectBank`, the one function the public form and the submit route both
//    resolve through, drops the question. Both the GET and the PUT's response
//    carry it in `dropped` with the word that stopped it, so the editor says
//    "this question is not being asked, and here is why" rather than silently
//    rendering a shorter form than the owner configured. A silent drop is how a
//    guard gets reported as a bug and then removed.
// ===========================================================================

const MAX_CUSTOM = 10;

/** What an unreadable config is refused with. */
const UNREADABLE = "Those question settings could not be read.";

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

  const parsedConfig = parseConfig(fork, body.config);
  if (!parsedConfig.ok) return bad(parsedConfig.error);

  try {
    await saveBank(gate.clientId, fork, parsedConfig.config, gate.actor);
    // Return the PROJECTION of what was just saved, not an ok. The owner has to
    // see the consequence of their edit — including any question that will not be
    // asked and the exact word that stopped it — in the same round trip.
    const projected = projectBank(fork, parsedConfig.config);
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

/** A config the PUT may write, or the sentence the owner is refused with. */
type ParsedConfig =
  | { ok: true; config: TriageBankConfig }
  | { ok: false; error: string };

/**
 * The reasons a CUSTOM question is refused outright rather than stored and
 * reported, and they are the two forbidden-word scans and nothing else.
 *
 * `malformed` and `unknown-key` are deliberately absent: the first is already
 * handled by `usableCustom` below (which refuses the whole save), and the second
 * can only describe a bank key, which case 2 in this file's header stores on
 * purpose.
 */
const REFUSE_AT_SAVE: ReadonlySet<DroppedQuestion["reason"]> = new Set([
  "funding-word",
  "symptom-on-brief",
]);

/**
 * Validate an incoming config. `ok: false` carries the sentence the owner sees.
 *
 * TWO LAYERS, and they answer different questions.
 *
 * `usableCustom` — the SAME validator the projection uses — answers "is this a
 * question at all": the key prefix, the label length, the type, the kind, and a
 * choice question's options. A question that fails it is refused rather than
 * dropped silently, because a shape this code does not understand is not
 * something to store and hope about.
 *
 * `projectBank` then answers "may a patient read it" (ruling W3/3). It is run on
 * the CANDIDATE config, for THIS FORK, before anything is written, and any custom
 * question it would drop for a forbidden word refuses the save. Running the real
 * projection rather than re-scanning the strings here is what keeps the two
 * halves of W3/3 — refuse at save, exclude at projection — from ever disagreeing
 * about which words are forbidden. It also gets the fork right for free: the
 * funding scan applies to both banks and the symptom scan only to the short one,
 * which is exactly what `admit` already does, and a question is stored once per
 * fork so per-fork is the correct granularity.
 *
 * Bank keys are stored as given; anything the bank does not know is simply never
 * projected.
 */
function parseConfig(fork: TriageFork, raw: unknown): ParsedConfig {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!obj) return { ok: false, error: UNREADABLE };
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
  const customKeys = new Set<string>();
  if (Array.isArray(obj.custom)) {
    for (const c of obj.custom.slice(0, MAX_CUSTOM)) {
      const parsed = usableCustom(c);
      if (!parsed) return { ok: false, error: UNREADABLE }; // refuse rather than drop it silently
      custom.push(parsed);
      customKeys.add(parsed.key);
    }
  }

  const config: TriageBankConfig = { enabledKeys, required, custom };
  const refused = projectBank(fork, config).dropped.find(
    (d) => customKeys.has(d.key) && REFUSE_AT_SAVE.has(d.reason),
  );
  if (refused) {
    // NAMES THE QUESTION AND THE WORD. A refusal an owner cannot act on gets
    // reported as a bug; one that says "the word 'NHS' stopped this" gets the
    // question rewritten. Both halves are the owner's own text echoed back —
    // this is a staff-facing API error, never a string a patient reads.
    return {
      ok: false,
      error:
        `"${refused.label}" cannot be asked: the word "${refused.matched ?? ""}" is not allowed ` +
        `in a question a patient reads. Rewrite it and save again. Nothing has been changed.`,
    };
  }
  return { ok: true, config };
}
