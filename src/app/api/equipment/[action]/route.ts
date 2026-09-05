import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { runAgentTurn } from "@/lib/agent/run";
import { requireUser, requireClientAccess, requireModuleApiAccess, requireApproverRole } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import type { Client as PracticeClient } from "@/lib/types";
import { getClient, getSites } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { isSystemEnabled } from "@/lib/systems/repository";
import { recordUsage } from "@/lib/telemetry";
import { londonDayKey } from "@/lib/time/london";
import { planAssetImport, type ParsedAssetRow } from "@/lib/equipment/csv";
import { buildEquipmentSystemPrompt } from "@/lib/equipment/prompt";
import {
  createAsset,
  deleteAsset,
  importAssets,
  listAssets,
  listManuals,
  updateAsset,
} from "@/lib/equipment/repository";
import { EQUIPMENT_TOOLS, makeEquipmentDispatch } from "@/lib/equipment/tools";
import { gateEquipmentQuestion, outOfTestVocabulary, EQUIPMENT_REFUSALS } from "@/lib/equipment/topic-gate";
import { ASSET_CATEGORIES, EQUIPMENT_SLUG, type AssetCategory } from "@/lib/equipment/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ===========================================================================
// THE EQUIPMENT MODULE'S API. Five actions on one route:
//
//   ask             one turn of the equipment agent
//   import-preview  parse a pasted CSV and return the PLAN, writing nothing
//   import          write a plan's rows
//   save            create or update one asset by hand
//   delete          remove one asset (and, by cascade, its manual)
//
// AUTHORISATION, and every action carries all of it:
//   requireUser            somebody is signed in
//   requireClientAccess    they belong to this practice
//   requireModuleApiAccess they hold the 'equipment' module — which, on the
//                          programme coordinator's ruling of 3 Sep 2026 (W2-A/1),
//                          is now EVERY authenticated role: a dental nurse asking
//                          "the autoclave is beeping" is what this module is for,
//                          and it holds no patient data.
//   requireApproverRole    ON THE WRITING ACTIONS ONLY, and this is the lock the
//                          module gate stopped being. The register READ, the
//                          manual search and the chat are everybody's; importing
//                          a CSV, adding, editing or deleting an item are the
//                          owner's and the practice manager's, because the
//                          register is the document the practice shows CQC and a
//                          nurse correcting a serial number by hand is not what
//                          the widening was for. Enforced here, per action, not
//                          on the page.
//
// THE KILL SWITCH IS ON `ask` ONLY, and that is deliberate. 'equipment' is
// declared defaultEnabled:false, so an absent toggle row AND an unreadable
// toggle table both resolve to DISABLED and the agent refuses. The register and
// the manuals stay editable while the switch is off, because an owner has to be
// able to load their assets and their manuals BEFORE switching the agent on —
// the same reasoning that keeps the page reachable (NAV_SWITCH_EXEMPT_SLUGS).
// ===========================================================================

interface Msg {
  role: "user" | "assistant";
  content: string;
}

function bad(error: string, status = 400): Response {
  return Response.json({ ok: false, error }, { status });
}

/**
 * The tenancy + module gate every action runs.
 *
 * A DISCRIMINATED union rather than an optional `denied`, so a caller that
 * forgets the early return is a compile error rather than a route that carries
 * on with `client` undefined.
 */
type AuthGate =
  | { denied: Response; auth?: undefined; client?: undefined }
  | { denied?: undefined; auth: AuthedUser | null; client: PracticeClient };

async function authorise(clientSlug: string): Promise<AuthGate> {
  const auth = await requireUser();
  if (auth instanceof Response) return { denied: auth };
  const client = clientSlug ? getClient(clientSlug) : undefined;
  if (!client) return { denied: bad("unknown client") };
  const clientDenied = requireClientAccess(auth, client.id);
  if (clientDenied) return { denied: clientDenied };
  // THE SLUG IS A STRING LITERAL, not the module's own constant, and that is on
  // purpose: `client-api-module-guard-coverage.test.ts` reads this file as TEXT
  // to prove the lock exists and to record WHICH module it locks. A constant
  // compiles identically and is invisible to that sweep, which would leave the
  // route guarded in the code and unguarded in the proof — the worse of the two
  // failures, because it looks fine from both sides.
  const moduleDenied = requireModuleApiAccess(auth, "equipment");
  if (moduleDenied) return { denied: moduleDenied };
  return { auth, client };
}

/**
 * One asset from a request body.
 *
 * WHAT THE CALLER MAY NAME IS EXACTLY THESE FIELDS. There is no client_id and no
 * id in here: tenancy comes from the session and the id comes from the URL body's
 * own `id` handled separately, so a caller cannot move an asset between practices
 * by editing a payload. The category is checked against the closed vocabulary
 * rather than trusted, because the database CHECK would otherwise reject the
 * whole write with an error nobody can read.
 */
function assetFromBody(body: Record<string, unknown>): Omit<ParsedAssetRow, "line" | "warnings"> | null {
  const text = (key: string, max = 500): string | null => {
    const v = body[key];
    if (typeof v !== "string") return null;
    const t = v.trim().slice(0, max);
    return t.length > 0 ? t : null;
  };
  const date = (key: string): string | null => {
    const v = text(key, 10);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  };
  const name = text("name", 200);
  if (!name) return null;
  const rawCategory = typeof body.category === "string" ? body.category : "other";
  const category: AssetCategory = (ASSET_CATEGORIES as readonly string[]).includes(rawCategory)
    ? (rawCategory as AssetCategory)
    : "other";
  const siteId = text("siteId", 60);
  return {
    name,
    category,
    make: text("make", 120),
    model: text("model", 120),
    serial: text("serial", 120),
    siteId,
    room: text("room", 120),
    supplier: text("supplier", 200),
    supplierPhone: text("supplierPhone", 60),
    purchasedOn: date("purchasedOn"),
    lastServicedOn: date("lastServicedOn"),
    nextServiceDue: date("nextServiceDue"),
    notes: text("notes", 2000),
  };
}

/** Site ids the practice actually has, so a payload cannot invent one. */
function knownSiteIds(clientId: string): Set<string> {
  return new Set(getSites(clientId).map((s) => s.id));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await params;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const clientSlug = typeof body.client === "string" ? body.client : "";
  const gate = await authorise(clientSlug);
  if (gate.denied) return gate.denied;
  const { auth, client } = gate;
  const actor = auth?.id ?? "owner";

  // THE WRITE LOCK, and it stands between the module gate and every action that
  // changes the register.
  //
  // It is a SET rather than a check inside each case, because the failure mode
  // being guarded against is a sixth action added below without one: a list a
  // reader can see at the top of the dispatch is checked by eye every time
  // somebody edits it, and a call buried in a case body is not. `import-preview`
  // is in it even though it writes nothing — it parses the CSV that the very next
  // request writes, and splitting the two halves of one flow across two
  // clearances is how a nurse ends up staring at a preview she cannot apply.
  //
  // `requireApproverRole` = agency admin + practice owner + practice manager
  // (APPROVER_ROLES, src/lib/absence/rules.ts). It is a no-op when no session is
  // enforced, exactly like every other guard in this codebase.
  const REGISTER_WRITE_ACTIONS = new Set(["import-preview", "import", "save", "delete"]);
  if (REGISTER_WRITE_ACTIONS.has(action)) {
    const writeDenied = requireApproverRole(auth);
    if (writeDenied) return writeDenied;
  }

  switch (action) {
    // -----------------------------------------------------------------------
    case "ask": {
      // 1. THE OWNER'S KILL SWITCH, before anything is spent. Default-off, and
      //    an unreadable toggle resolves to disabled for this slug.
      if (!(await isSystemEnabled(client.id, EQUIPMENT_SLUG))) {
        return Response.json({
          ok: true,
          reply:
            "The equipment desk is switched off. The practice owner can switch it on in System controls; the register and the manuals stay editable either way.",
          refused: true,
          reason: "system_off",
        });
      }

      const messages = (Array.isArray(body.messages) ? (body.messages as Msg[]) : [])
        .filter(
          (m) =>
            m &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string" &&
            m.content.length > 0 &&
            m.content.length < 4000,
        )
        .slice(-16);
      while (messages.length && messages[0].role === "assistant") messages.shift();
      if (messages.length === 0) return bad("no messages");

      const assets = await listAssets(client.id);
      if (assets === null) {
        return Response.json({
          ok: true,
          reply: "I could not read the equipment register just now, so I have nothing to answer from. Please try again in a moment.",
          refused: true,
          reason: "register_unreadable",
        });
      }

      // Today, in London, read ONCE and used by both the gate below and the
      // dispatch/prompt further down. It is computed here rather than after the
      // gate because the gate needs it: `outOfTestVocabulary` is what tells the
      // gate which machines the REGISTER says are out of test, and a gate given
      // a register but not a date cannot know that.
      const today = londonDayKey(new Date());

      // 2. THE SERVER-SIDE TOPIC GATE. Deterministic, before the Anthropic
      //    client is constructed and before a single token is spent, so a
      //    refusal costs nothing and there is no prompt for it to be argued out
      //    of. The prompt repeats these rules; it is not what enforces them.
      const verdict = gateEquipmentQuestion({
        userTurns: messages.filter((m) => m.role === "user").map((m) => m.content),
        registerVocabulary: assets.flatMap((a) =>
          [a.name, a.make, a.model, a.serial].filter((v): v is string => Boolean(v)),
        ),
        // THE REGISTER-AWARE HALF OF THE JUDGEMENT RULE (W3/15), and the field
        // is optional ONLY so the type did not break mid-wiring — omitting it
        // here is not a neutral choice. Without it the gate can only reach
        // facts_only when the person RESTATES the fact ("...it is overdue its
        // pressure test"), and a person asking whether a machine is still safe
        // does not restate it: that is what asking is. So every natural
        // phrasing W3/15 names — "can we still use the Lisa MB17?", "is it safe
        // to run it?", "should I keep using the autoclave?" — reached the model
        // as an ordinary allow, the server never appended the take-out-of-use
        // sentence, and the "always refused" half of W1-D/2 rested on the
        // prompt. `outOfTestVocabulary` does the filter (nextServiceDue
        // strictly before today; an asset with no date is UNKNOWN, not
        // overdue), shared with the co-pilot door so the two cannot drift.
        outOfTestVocabulary: outOfTestVocabulary(assets, today),
        registeredCount: assets.length,
        // An asset is "in scope" once the conversation has run at least one
        // exchange, which is what lets a two-word follow-up through without
        // letting a two-word opener through.
        assetInScope: messages.some((m) => m.role === "assistant"),
      });
      if (verdict.kind === "refuse") {
        // The RULE is part of the action token, not a field: UsageActor has no
        // room for one, and "which rule refused this" is the only thing that
        // makes a refusal count worth reading later.
        void recordUsage("equipment", `refused.${verdict.rule}`, { clientId: client.id, userEmail: auth?.email, role: auth?.role });
        return Response.json({ ok: true, reply: verdict.message, refused: true, reason: verdict.reason });
      }

      const manuals = await listManuals(client.id);
      const scope = await getViewScope(client.id);

      try {
        const history: MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
        const result = await runAgentTurn(history, {
          anthropic: new Anthropic(),
          dispatch: makeEquipmentDispatch({ clientId: client.id, today }),
          systemPrompt: buildEquipmentSystemPrompt({
            practiceName: client.name,
            scopeLabel: scope.label,
            assets,
            assetIdsWithManual: new Set((manuals ?? []).filter((m) => m.status === "ready").map((m) => m.assetId)),
            today,
            mode: verdict.mode,
          }),
          tools: EQUIPMENT_TOOLS,
          maxRounds: 5,
          maxTokens: 1200,
        });
        void recordUsage("equipment", verdict.mode === "facts_only" ? "turn.facts_only" : "turn", {
          clientId: client.id,
          userEmail: auth?.email,
          role: auth?.role,
        });

        // THE DECISION HALF, REFUSED DETERMINISTICALLY.
        //
        // The prompt asks the model to read out the facts and stop; this line is
        // what makes "and stop" true regardless of what it actually wrote. On a
        // judgement question the standing instruction — take it out of use, call
        // the engineer — is appended by the SERVER, so it is present when the
        // model forgets it, when the model argues itself round to an opinion, and
        // when the turn fails and the fallback sentence is all there is.
        //
        // Appended unconditionally rather than after a "did it already say
        // this?" check: that check is a fuzzy match on generated prose, and its
        // failure direction is silence on the one sentence that must never be
        // missing. Occasional redundancy is much the cheaper mistake.
        const answer = result.replyText || "Sorry, I could not answer that just now.";
        return Response.json({
          ok: true,
          reply:
            verdict.mode === "facts_only" ? `${answer}\n\n${EQUIPMENT_REFUSALS.judgement}` : answer,
          factsOnly: verdict.mode === "facts_only" ? true : undefined,
        });
      } catch {
        return Response.json({ ok: false, error: "the equipment desk is unavailable" }, { status: 500 });
      }
    }

    // -----------------------------------------------------------------------
    case "import-preview": {
      // WRITES NOTHING. The practice sees exactly what will happen — which
      // columns were understood, which were ignored, what each row becomes and
      // what could not be read — before anything lands in the register.
      const csv = typeof body.csv === "string" ? body.csv : "";
      if (!csv.trim()) return bad("Paste or upload a CSV first");
      if (csv.length > 2_000_000) return bad("That file is too large to import in one go (2MB of text)");
      const sites = getSites(client.id).map((s) => ({ id: s.id, name: s.name }));
      return Response.json({ ok: true, plan: planAssetImport(csv, sites) });
    }

    case "import": {
      const csv = typeof body.csv === "string" ? body.csv : "";
      if (!csv.trim()) return bad("Paste or upload a CSV first");
      if (csv.length > 2_000_000) return bad("That file is too large to import in one go (2MB of text)");
      const sites = getSites(client.id).map((s) => ({ id: s.id, name: s.name }));
      // RE-PARSED SERVER-SIDE rather than taking the rows the browser sends
      // back. The preview is a courtesy; the import must not trust a payload a
      // caller could have edited between the two calls.
      const plan = planAssetImport(csv, sites);
      if (plan.missingNameColumn) {
        return bad("That file has no column we recognise as the item name. Add one called Item, Equipment or Description.");
      }
      if (plan.rows.length === 0) return bad("There were no rows to import");
      if (plan.rows.length > 500) return bad("That is more than 500 rows. Split the file and import it in parts.");
      const result = await importAssets(
        client.id,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        plan.rows.map(({ line, warnings, ...row }) => row),
        actor,
      );
      return Response.json({ ok: true, ...result, skipped: plan.skipped.length });
    }

    case "save": {
      const row = assetFromBody(body);
      if (!row) return bad("An item name is required");
      if (row.siteId && !knownSiteIds(client.id).has(row.siteId)) return bad("Unknown site");
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (id) {
        const ok = await updateAsset(client.id, id, row, actor);
        return ok ? Response.json({ ok: true, id }) : bad("We could not save that", 500);
      }
      const created = await createAsset(client.id, row, actor);
      return created ? Response.json({ ok: true, id: created }) : bad("We could not save that", 500);
    }

    case "delete": {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) return bad("No asset id");
      const ok = await deleteAsset(client.id, id);
      return ok ? Response.json({ ok: true }) : bad("We could not remove that", 500);
    }

    default:
      return bad("unknown action", 404);
  }
}
