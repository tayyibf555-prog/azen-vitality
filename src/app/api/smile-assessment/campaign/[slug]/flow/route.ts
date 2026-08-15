import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import {
  getCampaignBySlug,
  updateCampaignFlow,
  FlowColumnsMissingError,
  FlowCopyRejectedError,
  FlowInvalidError,
  FlowVersionConflictError,
} from "@/lib/smile-assessment/campaign-repository";
import { normaliseAndValidateFlow } from "@/lib/smile-assessment/flow-validate";

export const dynamic = "force-dynamic";

// PUT /api/smile-assessment/campaign/<slug>/flow — save and/or publish the
// AUTHORED FUNNEL for one campaign.
//
// GUARDED, and with the same three-step chain as every other campaign write
// (campaign/route.ts:96-102, campaign/[slug]/route.ts:61-67): requireUser ->
// requireClientAccess -> the module gate for the smile-assessment slug. The call
// form is deliberately NOT written out in this comment: the api-guard coverage
// sweep detects the guard by regex over file text, and a comment carrying the
// literal call would satisfy the pin even if the real guard were deleted. No new
// capability key: the exact sibling act, authoring a public patient-facing form,
// has none either (api/onboarding/form/route.ts), and the capability catalog's own
// rule is that it contains only keys that are enforced
// (src/lib/capabilities/keys.ts:14).
//
// SAVE AND PUBLISH ARE ONE CALL BUT TWO DECISIONS. `flow` stores a graph; the
// boolean `published` decides whether the public runtime may use it. They are
// separable because there is no draft campaign status to hide behind (0060: status
// is active | paused only), so without the split, saving a half-built funnel onto
// a live ad destination would put it in front of real traffic the moment it saved.
//
// EVERY REJECTION IS THE WHOLE LIST, never the first failure: an owner fixing a
// funnel by hand should see all of it at once, and the generator's repair pass
// quotes the list back to the model.

function bad(message: string, status = 400, extra?: Record<string, unknown>): Response {
  return Response.json({ ok: false, error: message, ...extra }, { status });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const { slug } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const clientSlug =
    (typeof body.clientSlug === "string" ? body.clientSlug.trim() : "") ||
    new URL(request.url).searchParams.get("client") ||
    "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // Smile Assessment is outside CLINICIAN_SLUGS: these are marketing campaigns and the
  // enquiry scores behind them. (The patient-facing next/submit/token routes are
  // separate and deliberately unauthenticated.)
  const moduleDenied = requireModuleApiAccess(auth, "smile-assessment");
  if (moduleDenied) return moduleDenied;

  const campaign = await getCampaignBySlug(client.id, slug);
  if (!campaign) return bad("Assessment not found", 404);

  // --- what is being asked for ---------------------------------------------
  const wantsSave = body.flow !== undefined && body.flow !== null;
  const publishedRaw = body.published;
  if (publishedRaw !== undefined && typeof publishedRaw !== "boolean") {
    return bad("published must be true or false");
  }
  const published = publishedRaw as boolean | undefined;
  if (!wantsSave && published === undefined) {
    return bad("nothing to do: send a flow to save, a published flag, or both");
  }

  const expectedVersionRaw = body.expectedVersion;
  if (
    expectedVersionRaw !== undefined &&
    (typeof expectedVersionRaw !== "number" || !Number.isInteger(expectedVersionRaw) || expectedVersionRaw < 0)
  ) {
    return bad("expectedVersion must be a whole number");
  }
  const expectedVersion = expectedVersionRaw as number | undefined;

  // --- the graph, if one was sent ------------------------------------------
  // normaliseAndValidateFlow answers BOTH questions at once and distinguishes
  // them: rule 0 means "not readable as a graph at all", rules 1-11 mean "readable
  // and wrong". The owner needs to be told which.
  let graph;
  if (wantsSave) {
    const checked = normaliseAndValidateFlow(body.flow);
    if (!checked.graph) {
      return bad("This funnel cannot be saved yet.", 400, { failures: checked.result.failures });
    }
    graph = checked.graph;
  }

  // --- publishing needs something valid to publish --------------------------
  // Turning the switch on for a campaign whose STORED graph does not validate
  // would publish nothing and look like it worked: the runtime would fall back to
  // the adaptive funnel while the console said "published". Refuse instead.
  if (published === true && !graph) {
    const stored = normaliseAndValidateFlow(campaign.flow);
    if (!stored.graph) {
      return bad("There is no valid saved funnel to publish yet.", 400, {
        failures: stored.result.failures,
      });
    }
  }

  try {
    const state = await updateCampaignFlow({
      id: campaign.id,
      clientId: client.id,
      flow: graph,
      published,
      expectedVersion,
    });
    return Response.json({ ok: true, ...state });
  } catch (e) {
    // The repository re-checks both gates, because it is the only path that writes
    // the column. Reaching either here means the two checks disagreed, which is
    // worth reporting honestly rather than as a 500.
    if (e instanceof FlowInvalidError) {
      return bad("This funnel cannot be saved yet.", 400, { failures: e.failures });
    }
    if (e instanceof FlowCopyRejectedError) {
      return bad("Some of the wording in this funnel cannot go in front of a patient.", 400, {
        copyHits: e.hits,
      });
    }
    if (e instanceof FlowVersionConflictError) {
      return bad("This funnel was saved by someone else. Reload it and try again.", 409, {
        storedVersion: e.storedVersion,
      });
    }
    if (e instanceof FlowColumnsMissingError) {
      return bad(e.message, 503);
    }
    return bad("could not save the funnel", 500);
  }
}
