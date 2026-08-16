import { getClient } from "@/lib/mock/clients";
import { clientIp } from "@/lib/http/client-ip";
import { consumeBudget } from "@/lib/rate-budget";
import { getActiveCampaignBySlug } from "@/lib/smile-assessment/campaign-repository";
import { parseStepEventBatch } from "@/lib/smile-assessment/step-events";
import { insertStepEvents } from "@/lib/smile-assessment/step-events-repository";
import { isSystemEnabledStrict } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";

// PUBLIC: anonymous, PII-free STEP-VIEW telemetry from the authored Smile
// Assessment funnel. The browser fire-and-forgets a small batch of step ordinals
// (sendBeacon / keepalive fetch — see step-beacon.ts), so this is deliberately
// opaque: it always answers 202 with the same body and never returns anything the
// page could react to.
//
// NOT YET CALLED. The beacon exists and is exported; wiring it into the quiz is a
// later, separate stitch step. This route is live and inert until then, which is
// the point — it can be reviewed, budgeted and gated before a single real event
// exists.
//
// ABUSE POSTURE. It writes tiny scalar rows and nothing else: no SMS, no AI call,
// no Dentally write, no lead. So the cost of abuse is TABLE GROWTH, and that is
// what the guards are shaped around, in this order and for these reasons:
//
//   1. PAYLOAD CAP, before the body is even read. A beacon batch is a few hundred
//      bytes; anything past MAX_BODY_BYTES is not one of ours.
//   2. PER-IP burst budget, so one flooder is blunted across every instance
//      (unlike an in-process counter, which resets on a cold start).
//   3. PER-CAMPAIGN burst budget, so rotating IPs still hit a ceiling.
//   4. PER-CAMPAIGN DAILY budget — the actual row ceiling. This is the one that
//      makes "the table cannot grow unbounded" a fact rather than a hope, and the
//      arithmetic is spelled out at DAILY_BUDGET_LIMIT.
//
// All four run BEFORE the campaign is resolved where they can (the two campaign
// keys need the slugs, which are read off the body but never trusted beyond being
// budget keys — an unknown slug is still budgeted, so unknown-slug spam is capped
// too).
//
// KILL SWITCH: STRICT, i.e. fail CLOSED. The public /assess surface honours the
// per-system switch strictly (memory: both assess pages STRICT), and telemetry is
// the one place where failing closed costs nothing — a dropped analytics event is
// not a dropped patient.

/**
 * The payload cap. A batch is `{clientSlug, campaignSlug, flowVersion, nonce,
 * steps:[...]}` — under 500 bytes at MAX_EVENTS_PER_BATCH with a 64-character
 * nonce. 2,048 is generous headroom and still refuses anything that is trying to
 * STORE something here rather than report a step.
 *
 * Used against two different units on purpose, and neither is a mistake: the
 * Content-Length header is BYTES, and the post-read check is JS string LENGTH
 * (UTF-16 code units). The second is the authoritative one — a header can be
 * absent or lied about — and it is the looser of the two for non-ASCII input, so
 * the honest ceiling is "2,048 characters", at most ~8KB of UTF-8. Still tiny, and
 * a body with no Content-Length at all is bounded above this by the platform's own
 * request-body limit.
 */
const MAX_BODY = 2048;

const IP_BUDGET_LIMIT = 240; // posts per IP per window
const IP_BUDGET_WINDOW_SECONDS = 60 * 60;

const BURST_BUDGET_LIMIT = 300; // posts per campaign per minute
const BURST_BUDGET_WINDOW_SECONDS = 60;

/**
 * THE ROW CEILING. One post inserts at most MAX_EVENTS_PER_BATCH (24) rows, so
 * this cap means at most 5,000 x 24 = 120,000 rows per campaign per day, and the
 * table's growth is bounded by a number somebody can reason about rather than by
 * how long an attacker is willing to keep posting.
 *
 * Honest traffic nowhere near it: a session flushes a handful of times, so 5,000
 * posts is roughly 1,200+ completed funnel sessions in one day on ONE campaign.
 * A practice that genuinely exceeds that has a happier problem than this cap.
 */
const DAILY_BUDGET_LIMIT = 5000;
const DAILY_BUDGET_WINDOW_SECONDS = 60 * 60 * 24;

/**
 * ONE opaque acknowledgement for every outcome — accepted, dropped, unknown
 * client, unknown campaign, over budget, system switched off, insert failed.
 * Telemetry must never leak whether a slug exists, whether a campaign is live, or
 * whether a batch landed. Same call funnel-event's `ack()` makes.
 */
function ack(): Response {
  return Response.json({ ok: true }, { status: 202 });
}

function str(v: unknown): string {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : "";
}

// THE IDENTITY THE PER-IP BUDGET IS SPENT AGAINST comes from the shared reader
// (@/lib/http/client-ip), which every public assessment endpoint now uses:
// platform-set `x-real-ip` first, else the LAST `x-forwarded-for` hop.
//
// The order is the whole guard. `x-forwarded-for` is a list the caller can seed:
// the browser sends whatever it likes and the platform APPENDS the real connecting
// address, so the LEFTMOST entry is attacker-chosen and the RIGHTMOST is the only
// hop nobody upstream of us wrote. Keying the budget on the leftmost entry would
// mean one flooder could mint a fresh 240-post allowance per request simply by
// changing a header — a per-IP cap that caps nothing. Two spoofed prefixes from the
// same real client must land on the SAME key, and that is what the shared reader
// does; the spoof-variant tests below pin it on this route specifically.

export async function POST(request: Request): Promise<Response> {
  try {
    // (1) Payload cap, twice. The header is a fast pre-guard and can be absent or
    // lied about, so the authoritative check is on the text we actually read.
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY) return ack();

    let body: Record<string, unknown>;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return ack();
      const parsed = JSON.parse(text);
      body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return ack();
    }

    const clientSlug = str(body.clientSlug);
    const campaignSlug = str(body.campaignSlug);
    const ip = clientIp(request);
    const campaignKey = `${clientSlug}:${campaignSlug}`;

    // (2)(3)(4) The durable, distributed ceilings, cheapest and broadest first.
    // Each fails OPEN on a DB blip (rate-budget.ts), so a transient outage degrades
    // the cap rather than breaking the guard chain — acceptable here because the
    // worst case is extra rows in a telemetry table, not extra spend.
    if (!(await consumeBudget(`assess-step-ip:${ip}`, IP_BUDGET_LIMIT, IP_BUDGET_WINDOW_SECONDS))) {
      return ack();
    }
    if (
      !(await consumeBudget(
        `assess-step:${campaignKey}`,
        BURST_BUDGET_LIMIT,
        BURST_BUDGET_WINDOW_SECONDS,
      ))
    ) {
      return ack();
    }
    if (
      !(await consumeBudget(
        `assess-step-day:${campaignKey}`,
        DAILY_BUDGET_LIMIT,
        DAILY_BUDGET_WINDOW_SECONDS,
      ))
    ) {
      return ack();
    }

    // The batch itself, validated by the SAME module the beacon validates with.
    // Constructed, not spread: no key the caller invented survives this.
    const batch = parseStepEventBatch(body);
    if (!batch) return ack();

    const client = clientSlug ? getClient(clientSlug) : undefined;
    if (!client) return ack();

    // Kill switch FIRST, before the campaign lookup: it is the owner's "stop", so
    // an off system should not be doing a database read per posted beacon. STRICT,
    // i.e. fail CLOSED — off means no rows, an unreadable switch means no rows, and
    // the caller cannot tell either from a successful post.
    if (!(await isSystemEnabledStrict(client.id, "smile-assessment"))) return ack();

    // The campaign must exist AND be active. A paused campaign is one an owner
    // switched off; it must stop accumulating rows the moment they do, exactly as
    // a paused ad link stops capturing (campaign/[slug]/route.ts GET).
    const campaign = campaignSlug ? await getActiveCampaignBySlug(client.id, campaignSlug) : null;
    if (!campaign) return ack();

    // Both ids come from the SERVER's resolution of the slugs, never from the body:
    // a caller cannot attribute step views to a practice or a campaign they have no
    // relationship with, which is the same line the public submit route takes about
    // siteId.
    await insertStepEvents(
      batch.steps.map((stepIndex) => ({
        clientId: client.id,
        campaignId: campaign.id,
        flowVersion: batch.flowVersion,
        stepIndex,
        nonce: batch.nonce,
      })),
    );
    return ack();
  } catch {
    // Telemetry never errors the caller — including when 0080 has not been applied,
    // in which case every post is silently dropped and the quiz is unaffected.
    return ack();
  }
}
