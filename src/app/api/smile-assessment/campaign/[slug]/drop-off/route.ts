import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getCampaignBySlug } from "@/lib/smile-assessment/campaign-repository";
import { normaliseFlow } from "@/lib/smile-assessment/flow";
import { aggregateStepEvents, MAX_FLOW_VERSION } from "@/lib/smile-assessment/step-events";
import { stepNumbering } from "@/lib/smile-assessment/step-numbering";
import { stepLabels } from "@/lib/smile-assessment/step-labels";
import {
  readStepEvents,
  StepEventTableMissingError,
} from "@/lib/smile-assessment/step-events-repository";

export const dynamic = "force-dynamic";
/**
 * A year of a busy campaign's telemetry is a paged scan (MAX_SCAN_ROWS / SCAN_PAGE
 * round trips at worst), so this is a report route, not a page fetch — the house
 * ceiling for the other report GETs in this tree (reports/nhs-activity,
 * landing-pages). Without it the platform default would cut a wide window off
 * mid-scan and the owner would see a truncated funnel with no explanation.
 */
export const maxDuration = 60;

// GET /api/smile-assessment/campaign/<slug>/drop-off — the per-step funnel for one
// campaign and one version of its funnel.
//
// GUARDED, with the same three-step chain as every other campaign route in this
// tree (campaign/route.ts, campaign/[slug]/route.ts, campaign/[slug]/flow/route.ts):
// requireUser -> requireClientAccess -> the module gate for the smile-assessment
// slug, which admits the owner, the practice manager and the agency admin and
// refuses the clinician and the staff role. The call form is deliberately NOT
// written out in this comment: the api-guard coverage sweep detects the guard by
// regex over file text, and a comment carrying the literal call would satisfy the
// pin even if the real guard were deleted.
//
// WHY THIS IS GUARDED AT ALL, GIVEN THE ROWS ARE ANONYMOUS. The rows are, and the
// ANSWER is not: "this campaign converted 6 of 400 visitors" is the practice's own
// marketing performance, and the /assess page it describes is a public URL anyone
// can find. A patient-facing surface must not be able to read how the practice's
// funnel is doing.
//
// SCOPED BY VERSION. flow_version defaults to the campaign's CURRENT version, which
// is the only default that answers the question an owner is actually asking ("how
// is my funnel doing"). An older version stays readable by asking for it, which is
// how "did my rewrite help" gets answered.

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** Days of history. Default a month; a year is the ceiling on one request's scan. */
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const { slug } = await params;
  const url = new URL(request.url);
  const client = getClient(url.searchParams.get("client") ?? "");
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // Smile Assessment is outside CLINICIAN_SLUGS: these are marketing campaigns and
  // the enquiry performance behind them.
  const moduleDenied = requireModuleApiAccess(auth, "smile-assessment");
  if (moduleDenied) return moduleDenied;

  const campaign = await getCampaignBySlug(client.id, slug);
  if (!campaign) return bad("Assessment not found", 404);

  // --- the window and the version -------------------------------------------
  const daysRaw = url.searchParams.get("days");
  let days = DEFAULT_DAYS;
  if (daysRaw !== null) {
    const parsed = Number(daysRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DAYS) {
      return bad(`days must be a whole number between 1 and ${MAX_DAYS}`);
    }
    days = parsed;
  }

  const versionRaw = url.searchParams.get("flowVersion");
  let flowVersion = campaign.flowVersion;
  if (versionRaw !== null) {
    const parsed = Number(versionRaw);
    // BOUNDED ABOVE, not just below, and by the SAME constant the write side
    // bounds an anonymous caller's flow_version with (step-events.ts). flow_version
    // is an int4 column: `Number.isInteger(1e20)` is true, so a lower bound alone
    // lets `?flowVersion=1e20` through to Postgres, where it is not a "no rows"
    // answer but an out-of-range error — a 500 on a signed-in owner's report,
    // handed to them by a query string. One owner for the rule, both sides.
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_FLOW_VERSION) {
      return bad(`flowVersion must be a whole number between 0 and ${MAX_FLOW_VERSION}`);
    }
    flowVersion = parsed;
  }

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  try {
    const scan = await readStepEvents({
      campaignId: campaign.id,
      flowVersion,
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
    });

    // stepCount AND labels, FROM THE SAME MODULE THE BEACON EMITS WITH.
    //
    // aggregateStepEvents fills the ordinals nobody reached with empty bars, but
    // only when the caller knows how long the funnel is — and a funnel's step
    // NUMBERING has one owner, step-numbering.ts, which the deterministic runtime
    // calls to decide which ordinal to post. Deriving a second length here would be
    // the exact failure A3 refused to risk; calling the same function is not.
    //
    // ONLY FOR THE CURRENT VERSION, and the guard is not defensive tidiness. A
    // campaign row stores ONE funnel — the latest (0078). Asked about an older
    // flow_version, the graph in hand is not the graph those events came out of, so
    // numbering them with it would label bar 3 with a question that funnel never
    // asked and pad the chart to a length it never had. An older version therefore
    // reports the steps it has rows for, unlabelled, which is what the data
    // supports; the CURRENT version — the one an owner is actually looking at —
    // gets the full picture.
    //
    // normaliseFlow, not normaliseAndValidateFlow: "can this be read as a graph" is
    // the question here. A legal-but-imperfect draft still has screens a patient
    // reached, and screenFor names a broken step out loud rather than blanking it.
    //
    // COMPLETION. The last ordinal is the RESULT screen, which every band shares
    // (step-numbering.ts), so `funnel.completionPct` reads as "reached a result
    // screen" — the funnel's completion rate — rather than as the share who got one
    // particular band.
    let stepCount: number | undefined;
    let labels: Record<number, string> | undefined;
    if (flowVersion === campaign.flowVersion) {
      const graph = normaliseFlow(campaign.flow);
      if (graph) {
        const numbering = stepNumbering(graph);
        if (numbering.stepCount > 0) {
          stepCount = numbering.stepCount;
          labels = stepLabels(graph, numbering, {
            headline: campaign.headline,
            intro: campaign.intro,
          });
        }
      }
    }

    const funnel = aggregateStepEvents(
      scan.rows,
      stepCount === undefined ? undefined : { stepCount },
    );

    return Response.json({
      ok: true,
      campaign: { slug: campaign.slug, name: campaign.name },
      flowVersion,
      from: from.toISOString(),
      to: to.toISOString(),
      // Says so out loud rather than quietly reporting a partial tally as a whole
      // one: at this point the funnel describes the most recent events only.
      truncated: scan.truncated,
      funnel,
      // Absent (not empty) when this version's graph is not the one in hand, so the
      // chart falls back to "Step N" rather than to somebody else's questions.
      ...(labels ? { labels } : {}),
      ...(stepCount === undefined ? {} : { stepCount }),
    });
  } catch (e) {
    // 0080 not applied on this deployment. Named, not swallowed: here the data IS
    // the request, and answering "0 sessions" would tell an owner that nobody uses
    // their funnel. Same call setCampaignTheme makes for 0079.
    if (e instanceof StepEventTableMissingError) return bad(e.message, 503);
    return bad("could not read the drop-off funnel", 500);
  }
}
