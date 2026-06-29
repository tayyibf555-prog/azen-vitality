import Anthropic from "@anthropic-ai/sdk";
import { HAIKU } from "@/lib/ai/models";
import { getClient } from "@/lib/mock/clients";
import { questionById, type QuizQuestion } from "@/lib/smile-assessment/quiz";
import { candidateQuestions, deterministicNext, shouldFinish, answeredCount } from "@/lib/smile-assessment/funnel";
import { getActiveCampaignBySlug } from "@/lib/smile-assessment/campaign-repository";
import { goalLabel } from "@/lib/smile-assessment/campaign";
import { consumeBudget } from "@/lib/rate-budget";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

// Public, adaptive-funnel endpoint. Given the answers so far, the AI (Haiku, for
// speed) picks the single best NEXT question from the branched bank to qualify the
// enquiry, plus a short transition line. Returns { done: true } when enough is
// gathered. No auth (the quiz is public); rate-limited per IP since each call
// costs a token; never throws to the client. The AI only SELECTS bank questions,
// so the path is always on-brand + scoreable; a deterministic fallback covers a
// failed/slow model call so the funnel never stalls.

const IP_LIMIT = 80; // next-question calls per IP per hour (~13 full funnels)
const HOUR_MS = 60 * 60 * 1000;
// The real spend ceiling: a SHARED global budget across all instances (the per-IP
// map below is only a cheap first line and is best-effort on serverless).
const GLOBAL_LIMIT_PER_MIN = 300; // hard cap on funnel calls/min, far above legit use

const ipHits = new Map<string, number[]>();
function tooManyForIp(ip: string, now: number): boolean {
  const cutoff = now - HOUR_MS;
  const hits = (ipHits.get(ip) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) if (v.every((t) => t <= cutoff)) ipHits.delete(k);
  }
  return hits.length > IP_LIMIT;
}
function clientIp(request: Request): string {
  // Prefer the platform-set x-real-ip (not client-spoofable). Fall back to the
  // LAST x-forwarded-for entry (Vercel appends the real connecting IP at the end);
  // the leftmost entry is attacker-controlled, so never trust it.
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }
  return "unknown";
}

function cleanLine(s: string): string {
  return s.replace(/[—–]/g, ", ").replace(/\s+/g, " ").trim().slice(0, 120).trim();
}

/** Clean the supplied answers to known question id -> valid option value only. */
function parseAnswers(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const q = questionById(k);
    if (!q || typeof v !== "string") continue;
    if (q.options.some((o) => o.value === v)) out[k] = v;
  }
  return out;
}

function questionPayload(q: QuizQuestion) {
  return {
    id: q.id,
    prompt: q.prompt,
    options: q.options.map((o) => ({ value: o.value, label: o.label })),
  };
}

function labelFor(qId: string, value: string): string {
  const q = questionById(qId);
  return q?.options.find((o) => o.value === value)?.label ?? value;
}

async function pickNext(
  answers: Record<string, string>,
  candidates: QuizQuestion[],
  campaignGoal: string | null,
): Promise<{ id: string; transition: string }> {
  const fallbackId = deterministicNext(answers) ?? candidates[0].id;
  const fallback = { id: fallbackId, transition: "Thanks. Just a couple more quick questions." };
  try {
    const answeredLines = Object.entries(answers)
      .map(([k, v]) => `- ${questionById(k)?.prompt} => ${labelFor(k, v)}`)
      .join("\n");
    const candidateLines = candidates.map((q) => `${q.id} | ${q.dimension} | ${q.prompt}`).join("\n");
    const system = [
      "You run an adaptive smile-assessment quiz for a UK dental practice.",
      "Pick the single best NEXT question to ask, ONLY from the candidate list, to qualify the enquiry (how ready they are to proceed, and how good a fit) in as few questions as possible.",
      "Make sure their timeline and how they would fund treatment both get covered before the quiz ends.",
      campaignGoal
        ? `This enquiry came in through a campaign about ${campaignGoal}, so favour questions that best qualify for that.`
        : "",
      "Also write one short, warm transition line that acknowledges their last answer and leads into the next question.",
      "Rules: choose ONLY a candidate id, exactly as written. Transition under 14 words. Use no em-dash. Never give clinical advice and never say whether a treatment is suitable. British English. Any money is in GBP using the £ symbol.",
      'Respond with ONLY a JSON object: {"nextId": "<one candidate id>", "transition": "<one short line>"}',
    ]
      .filter(Boolean)
      .join("\n");
    const user = `Answers so far:\n${answeredLines || "(none yet)"}\n\nCandidate next questions (id | dimension | prompt):\n${candidateLines}`;

    // maxRetries: 0 — a slow/erroring pick must fall straight through to the
    // deterministic fallback within the 9s budget, not silently retry (which would
    // triple the cost and blow past the route's maxDuration).
    const anthropic = new Anthropic({ maxRetries: 0 });
    const msg = await anthropic.messages.create(
      { model: HAIKU, max_tokens: 200, system, messages: [{ role: "user", content: user }] },
      { timeout: 9000 },
    );
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    const parsed = JSON.parse(match[0]) as { nextId?: unknown; transition?: unknown };
    const id =
      typeof parsed.nextId === "string" && candidates.some((q) => q.id === parsed.nextId)
        ? parsed.nextId
        : fallbackId;
    const transition =
      typeof parsed.transition === "string" && parsed.transition.trim()
        ? cleanLine(parsed.transition)
        : fallback.transition;
    return { id, transition };
  } catch {
    return fallback;
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return Response.json({ ok: false, error: "Request body must be valid JSON" }, { status: 400 });
  }

  if (tooManyForIp(clientIp(request), Date.now())) {
    return Response.json({ ok: false, error: "too many requests, please slow down" }, { status: 429 });
  }
  // Shared global budget: the real ceiling on AI spend, independent of IP spoofing
  // or how many instances are warm.
  if (!(await consumeBudget("sa-next", GLOBAL_LIMIT_PER_MIN, 60))) {
    return Response.json({ ok: false, error: "the assessment is busy, please try again shortly" }, { status: 429 });
  }

  const answers = parseAnswers(body.answers);

  // Enough gathered (or no eligible questions left): finish.
  if (shouldFinish(answers)) return Response.json({ ok: true, done: true });
  const candidates = candidateQuestions(answers);
  if (candidates.length === 0) return Response.json({ ok: true, done: true });

  // Campaign goal biases the selection (never shown to the patient).
  const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug.trim() : "";
  const campaignSlug = typeof body.campaignSlug === "string" ? body.campaignSlug.trim() : "";
  const client = clientSlug ? getClient(clientSlug) : undefined;
  let campaignGoal: string | null = null;
  try {
    if (client && campaignSlug) {
      const c = await getActiveCampaignBySlug(client.id, campaignSlug);
      if (c) campaignGoal = goalLabel(c.goal);
    }
  } catch {
    // ignore: campaign bias is best-effort
  }

  const { id, transition } = await pickNext(answers, candidates, campaignGoal);
  const q = questionById(id);
  if (!q) return Response.json({ ok: true, done: true });

  return Response.json({
    ok: true,
    done: false,
    question: questionPayload(q),
    transition,
    step: answeredCount(answers) + 1,
  });
}
