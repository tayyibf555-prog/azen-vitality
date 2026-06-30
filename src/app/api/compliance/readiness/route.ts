import Anthropic from "@anthropic-ai/sdk";
import { HAIKU } from "@/lib/ai/models";
import { getClient } from "@/lib/mock";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";
import { buildReadinessPrompt, cleanLine } from "@/lib/compliance/ai";
import { READINESS, MOCK_AUDITS, MOCK_POLICIES, MOCK_TRAINING_RECORDS, MOCK_STAFF } from "@/lib/compliance/mock";
import { TRAINING_REQUIREMENTS } from "@/lib/compliance/knowledge";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface Priority {
  action: string;
  area: string;
  urgency: "high" | "medium" | "low";
}
interface Assessment {
  priorities: Priority[];
  inspectionView: string;
  quickWins: string[];
}

// AI compliance readiness check: reads the practice's current compliance state and
// produces a prioritised action plan + an inspection-readiness view. Authed members
// only (it spends a model call). Decision-support, not legal advice. Reads the
// curated mock state today; swap the mock imports for real records later.
export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return Response.json({ ok: false, error: "Request body must be valid JSON" }, { status: 400 });
  }

  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug : "";
  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 400 });
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  const staffName = (id: string) => MOCK_STAFF.find((s) => s.id === id)?.name ?? "a team member";
  const reqName = (id: string) => TRAINING_REQUIREMENTS.find((r) => r.id === id)?.name ?? "training";

  const { system, user } = buildReadinessPrompt({
    practiceName: client.name,
    overallScore: READINESS.overallScore,
    kloes: READINESS.kloes.map((k) => ({ label: k.label, score: k.score, status: k.status, openItems: k.openItems })),
    overdueAudits: MOCK_AUDITS.filter((a) => a.status === "overdue").map((a) => a.name),
    dueAudits: MOCK_AUDITS.filter((a) => a.status === "due_soon").map((a) => a.name),
    policiesNeedingAttention: MOCK_POLICIES.filter((p) => p.status !== "in_place").map((p) => `${p.name} (${p.status})`),
    trainingExpiring: MOCK_TRAINING_RECORDS.filter((t) => t.status === "overdue" || t.status === "due_soon").map(
      (t) => `${reqName(t.requirementId)} for ${staffName(t.staffId)} (${t.status})`,
    ),
  });

  try {
    const anthropic = new Anthropic({ maxRetries: 1 });
    const msg = await anthropic.messages.create(
      { model: HAIKU, max_tokens: 1300, system, messages: [{ role: "user", content: user }] },
      { timeout: 20000 },
    );
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return Response.json({ ok: false, error: "could not generate assessment" }, { status: 502 });
    const parsed = JSON.parse(match[0]) as Partial<Assessment>;
    const assessment: Assessment = {
      priorities: Array.isArray(parsed.priorities)
        ? parsed.priorities
            .filter((p): p is Priority => !!p && typeof p === "object")
            .map((p) => {
              const urgency: Priority["urgency"] =
                p.urgency === "high" ? "high" : p.urgency === "low" ? "low" : "medium";
              return { action: cleanLine(String(p.action ?? "")), area: cleanLine(String(p.area ?? "")), urgency };
            })
            .filter((p) => p.action)
        : [],
      inspectionView: cleanLine(String(parsed.inspectionView ?? "")),
      quickWins: Array.isArray(parsed.quickWins) ? parsed.quickWins.map((s) => cleanLine(String(s))).filter(Boolean) : [],
    };
    if (assessment.priorities.length === 0) return Response.json({ ok: false, error: "empty assessment" }, { status: 502 });
    return Response.json({ ok: true, assessment });
  } catch {
    return Response.json({ ok: false, error: "readiness check unavailable" }, { status: 500 });
  }
}
