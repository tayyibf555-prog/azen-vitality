import Anthropic from "@anthropic-ai/sdk";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import { getClient } from "@/lib/mock";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import { buildReportPrompt, cleanLine } from "@/lib/reports/ai";
import { buildSnapshot, type ReportPeriod } from "@/lib/reports/snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface ReportSection {
  title: string;
  body: string;
}
interface Report {
  headline: string;
  highlights: string[];
  sections: ReportSection[];
  recommendations: string[];
}

// AI business review: reads the practice's current acquisition, conversion,
// lifecycle and compliance numbers (from the period snapshot) and writes a
// concise weekly or monthly review for the owner with recommendations. Authed
// members only (it spends a model call). Reads the curated mock state today; swap
// the snapshot's sources for real records later.
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
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  const period: ReportPeriod = body.period === "week" ? "week" : "month";
  const snapshot = buildSnapshot(period);
  const { system, user } = buildReportPrompt(snapshot, period, client.name);

  try {
    const anthropic = new Anthropic({ maxRetries: 1 });
    const msg = await anthropic.messages.create(
      { model: SONNET, thinking: NO_THINKING, max_tokens: 2000, system, messages: [{ role: "user", content: user }] },
      { timeout: 20000 },
    );
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return Response.json({ ok: false, error: "could not generate report" }, { status: 502 });
    let parsed: Partial<Report>;
    try {
      parsed = JSON.parse(match[0]) as Partial<Report>;
    } catch {
      return Response.json({ ok: false, error: "could not parse report" }, { status: 502 });
    }
    const report: Report = {
      headline: cleanLine(String(parsed.headline ?? "")),
      highlights: Array.isArray(parsed.highlights)
        ? parsed.highlights.map((s) => cleanLine(String(s))).filter(Boolean)
        : [],
      sections: Array.isArray(parsed.sections)
        ? parsed.sections
            .filter((s): s is ReportSection => !!s && typeof s === "object")
            .map((s) => ({ title: cleanLine(String(s.title ?? "")), body: cleanLine(String(s.body ?? "")) }))
            .filter((s) => s.title || s.body)
        : [],
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.map((s) => cleanLine(String(s))).filter(Boolean)
        : [],
    };
    if (!report.headline && report.sections.length === 0 && report.highlights.length === 0) {
      return Response.json({ ok: false, error: "empty report" }, { status: 502 });
    }
    return Response.json({ ok: true, report });
  } catch {
    return Response.json({ ok: false, error: "report generation unavailable" }, { status: 500 });
  }
}
