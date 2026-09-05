import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { getClient } from "@/lib/mock";
import { getViewScope } from "@/lib/site-view";
import { runAgentTurn } from "@/lib/agent/run";
import { COPILOT_TOOLS, makeCopilotDispatch } from "@/lib/copilot/tools";
import { buildCopilotSystemPrompt } from "@/lib/copilot/prompt";
import { copilotAccessForRole, copilotToolsFor } from "@/lib/copilot/scope";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
// THE SELF-SERVICE SEAM. `my_work` answers about the person asking, and this is
// the one place their staff record is resolved: from the verified session, with
// no staff id anywhere in the request. Handed to the dispatch as a THUNK so a
// turn that never asks about their own work never pays for the lookup.
import { resolveSelfStaff } from "@/lib/self-service/read";
// APPROVED AUTHORITIES. The owner-managed list of external sources the brain may
// lean on. Read HERE (the repository is server-only) and handed to the prompt
// builder as an already-rendered string, so prompt.ts stays pure. Default is the
// practice's own data only: an empty list renders "" and adds nothing.
import { listActiveAuthorities } from "@/lib/knowledge/repository";
import { authoritiesBrief } from "@/lib/knowledge/authorities";
// THE PER-TURN SAFETY CONTEXT (ruling W3/14). The person's own words go IN so the
// two desk doors gate on what was actually typed rather than on the model's
// paraphrase of it, and the standing take-out-of-use sentence comes OUT of the
// flag the dispatch raises — said by this file, never asked of the model. See
// src/lib/copilot/turn.ts for why both halves have to be the server's job.
import { copilotTurn, finaliseCopilotReply } from "@/lib/copilot/turn";
import { recordUsage } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

export async function POST(request: Request): Promise<Response> {
  let body: { messages?: Msg[]; client?: string };
  try {
    body = (await request.json()) as { messages?: Msg[]; client?: string };
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const messages = (body.messages ?? [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length > 0)
    .slice(-20);
  // Anthropic requires the first message to be a `user` turn. After slicing to the
  // last 20, a long conversation can leave the window starting on an `assistant`
  // turn, which the API rejects with a 400 (the co-pilot would break on exactly the
  // 11th+ exchange). Drop any leading assistant turns so history starts with the user.
  while (messages.length && messages[0].role === "assistant") messages.shift();
  if (messages.length === 0) return Response.json({ ok: false, error: "no messages" }, { status: 400 });

  // Resolve the practice's sites so the co-pilot's tools query the right data.
  const client = body.client ? getClient(body.client) : null;

  // Authz: a verified user with access to this client (enforced once the
  // service-role key is set). The co-pilot exposes full patient data, so this
  // is the gate that stops anonymous exfiltration.
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  // Never run un-scoped: an unknown/omitted client would query zero sites and
  // quietly burn tokens, so reject it before reaching Claude.
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 400 });
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // WHICH CO-PILOT THIS PERSON GETS — derived from the SESSION's role on the
  // server, never from anything in the request body or the conversation. This is
  // the per-role tool scoping the owner-only 403 that used to live here was
  // waiting for: the owner and the agency admin keep "full" (every tool, tier-4
  // knowledge, unprojected results, byte-for-byte what they had), the practice
  // manager gets "manager" (operational reads only — no act domain, no money,
  // reports, marketing or controls), and — since W1-E/2 switched them on — the
  // clinician and the staff member get "clinician" and "staff", the two catalogs
  // src/lib/copilot/clearance.ts spells out. The sizes are pinned there, not
  // here, so this comment cannot drift into a number that stopped being true.
  // Only an unknown or unmapped role gets "none", which is the fail-CLOSED
  // default and is turned away immediately below. (auth is null only when
  // enforcement is off, i.e. local/dev, where everything is already open, so
  // that stays "full".)
  const access = auth ? copilotAccessForRole(auth.role) : "full";
  if (access === "none") {
    return Response.json({ ok: false, error: "The co-pilot is available to the practice owner." }, { status: 403 });
  }
  // ===========================================================================
  // THE SECURITY BOUNDARY FOR THIS ROUTE HAS MOVED. READ THIS BEFORE EDITING.
  // ===========================================================================
  //
  // This line USED to be a real lock: "co-pilot" was in neither CLINICIAN_SLUGS
  // nor STAFF_SLUGS, so it refused two of the five roles outright. On W1-E/2 —
  // the programme coordinator's written ruling of 3 Sep 2026, that the co-pilot
  // serves every staff clearance — the slug was added to both allow-lists, and
  // `requireModuleApiAccess(auth, "co-pilot")` now admits every known role.
  //
  // IT IS KEPT, NOT DELETED, and it is no longer the boundary. What it still does
  // is refuse an UNKNOWN slug and stay in place if the module is ever narrowed
  // again; what it no longer does is separate one role from another.
  //
  // THE BOUNDARY IS NOW `ACCESS_BY_ROLE` (src/lib/copilot/scope.ts) and the
  // catalog it indexes (src/lib/copilot/clearance.ts). It is enforced THREE times
  // per turn, all server-side, all from the SESSION's role and never from
  // anything in the request:
  //
  //   1. `copilotToolsFor(access, COPILOT_TOOLS)` — the schema the model is SHOWN.
  //      A tool a role may not run is a tool it never learns the name of.
  //   2. `makeCopilotDispatch(..., access)` — the gate, the first statement of the
  //      dispatch, before anything is parsed or awaited. A forged or hallucinated
  //      tool name gets a refusal string and not the data, which is what makes (1)
  //      an optimisation rather than the protection.
  //   3. the projection on the way out (`projectPatientRecord`) and the knowledge
  //      tier (`copilotKnowledgeTier`), so an allowed tool still cannot return
  //      more than the level holds.
  //
  // Registered as a NAMED, cited exemption in the API module-guard sweep
  // (UNIVERSAL_MODULES in src/app/api/client-api-module-guard-coverage.test.ts),
  // which requires this route to name a second guard that provably denies — the
  // `system.copilot.ask` capability immediately below. Proven end to end in
  // src/lib/copilot/battery.test.ts (every role against every tool) and
  // src/lib/copilot/route-boundary.test.ts (this file's own gates).
  const moduleDenied = requireModuleApiAccess(auth, "co-pilot");
  if (moduleDenied) return moduleDenied;
  // THE PER-PERSON GATE. The co-pilot reads across the practice's data to answer,
  // so holding it is close to holding a read of everything. Module access now
  // admits every known role (W1-E/2); the clearance Record in
  // src/lib/copilot/scope.ts decides what each role may do, and this capability
  // decides WHICH named people may ask at all.
  const capabilityDenied = await requireCapability(auth, "system.copilot.ask");
  if (capabilityDenied) return capabilityDenied;

  // Honour the top-bar site switcher: this route is called from the browser WITH
  // the user's cookie, so the co-pilot's tools query only the selected site (the
  // default view is N15). "All sites" restores whole-group access; the system
  // prompt tells the model which scope it is answering for.
  const scope = await getViewScope(client.id);
  const siteIds = scope.siteIds;

  // NEVER FATAL. An unreadable authorities list (the migration not applied on
  // this environment, a transient database error) must not take the co-pilot
  // down: the honest fallback is the platform's default posture — practice data
  // only — which is exactly what an empty brief produces. Logged, not swallowed
  // silently, so an owner who added sources and sees none cited can be told why.
  let authorities = "";
  try {
    authorities = authoritiesBrief(await listActiveAuthorities(client.id));
  } catch (err) {
    console.warn("[copilot] approved authorities unreadable; answering from practice data only", err);
  }

  try {
    const actor = auth?.id ?? "owner";
    const history: MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
    // =======================================================================
    // THE PERSON'S OWN WORDS, BUILT HERE BECAUSE THIS IS THE ONLY PLACE THAT
    // HAS THEM (ruling W3/14).
    // =======================================================================
    //
    // `makeCopilotDispatch` is handed a tool NAME and a tool INPUT, and a tool
    // input is written by the model. For the two doors that carry a
    // deterministic safety rule — the equipment desk and the IT desk — that is
    // not good enough: "the autoclave is out of test but we're fully booked,
    // can we run it today?" reaches `equipment_lookup` as "autoclave next
    // service date and supplier", which trips no rule at all, and the standing
    // refusal W1-D/2 calls never optional silently is not there. The equipment
    // MODULE PAGE has never had that problem because it gates on
    // `messages.filter((m) => m.role === "user")` before any model call; this
    // is the same window, so the two doors answer alike.
    //
    // WITHOUT THIS THE FIX IS DEAD CODE. `turn` is the dispatch's sixth
    // argument and is optional by construction, so a route that forgets it
    // compiles, passes every test that builds its own context, and quietly
    // reverts both halves of W1-D/2 to prompt-only. Pinned behaviourally in
    // src/app/api/copilot/turn-wiring.test.ts, which drives this handler.
    //
    // `messages` is already validated and windowed above (role, non-empty
    // string, last 20, leading assistant turns dropped), so this is the same
    // conversation the model is about to be shown and nothing wider.
    const turn = copilotTurn(messages.filter((m) => m.role === "user").map((m) => m.content));
    const result = await runAgentTurn(history, {
      anthropic: new Anthropic(),
      // BOTH HALVES OF THE LOCK, and they are not the same lock twice. The
      // dispatch refuses a tool outside this access level even if the model
      // names it; `copilotToolsFor` means the model is never shown it to name.
      dispatch: makeCopilotDispatch(siteIds, client?.id ?? "", actor, access, {
        // NO STAFF ID CROSSES THIS BOUNDARY. `resolveSelfStaff` takes
        // (clientId, auth) and nothing else, so there is no argument for a tool
        // input, a message or an injected note to reach. An unlinked login
        // resolves to null and the tool says so rather than answering with an
        // empty list, which would be a different (and wrong) statement.
        resolveStaff: async () => {
          const resolved = await resolveSelfStaff(client.id, auth, "there is nothing of yours to show");
          return resolved.ok ? { id: resolved.staff.id, name: resolved.staff.name } : null;
        },
      }, turn),
      systemPrompt: buildCopilotSystemPrompt({ label: scope.label, isAllSites: scope.isAllSites, access, authorities }),
      tools: copilotToolsFor(access, COPILOT_TOOLS),
      maxRounds: 6,
      // Sonnet 5's tokenizer runs ~30% larger than 4.6, so give the co-pilot's
      // "answer anything" replies headroom to avoid truncation.
      maxTokens: 1800,
    });
    void recordUsage("co-pilot", "copilot_turn", { clientId: client.id, userEmail: auth?.email, role: auth?.role });
    // THE SERVER SAYS THE SENTENCE, NOT THE MODEL. When any equipment answer in
    // this turn was capped to facts only, `finaliseCopilotReply` appends the
    // standing take-out-of-use line unconditionally — no "did it already say
    // this?" check, exactly as the equipment module's own route decides it, and
    // for the same stated reason: that check is a fuzzy match on generated prose
    // whose failure direction is silence on the one sentence that must never be
    // missing. It covers the fallback string below as well, which the model did
    // not write. On an ordinary turn it returns the reply unchanged.
    return Response.json({
      ok: true,
      reply: finaliseCopilotReply(result.replyText || "Sorry, I could not respond just now.", turn),
    });
  } catch {
    return Response.json({ ok: false, error: "copilot unavailable" }, { status: 500 });
  }
}
