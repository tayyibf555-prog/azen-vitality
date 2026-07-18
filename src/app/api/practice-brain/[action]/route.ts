import { NextResponse, type NextRequest } from "next/server";
import { consumeBudget } from "@/lib/rate-budget";
import { classifyKnowledge } from "@/lib/practice-brain/classify";
import { visibleNodes } from "@/lib/practice-brain/clearance";
import { askCopilot } from "@/lib/practice-brain/copilot";
import { searchKnowledge } from "@/lib/practice-brain/retrieval";
import { signSession, verifySession } from "@/lib/practice-brain/session";
import { requireUser, requireOwnerRole } from "@/lib/auth/guard";
import type { ClassificationResult, Tier } from "@/lib/practice-brain/types";
import {
  createItem, ensureBranch, listActiveNodes, listBranchNames, listNeedsReview, listOpenGaps, logKnowledgeGap, logQa, resolveGap, resolveReview, setQaFeedback, verifyCredential,
} from "@/lib/practice-brain/repository";

const CLIENT_ID = "vitality";
const COOKIE = "pb_session";
const SESSION_MS = 1000 * 60 * 60 * 8;

// Brute-force guard for the public unlock action: a single shared password per
// tier is all that protects tier 1-4 practice knowledge, so cap guessing hard.
// Per-IP first (cheap, in-process, best-effort on serverless), then a SHARED
// durable budget across all instances (api_budget), mirroring the smile-funnel
// and onboarding public-endpoint pattern.
const UNLOCK_IP_LIMIT = 20; // unlock attempts per IP per hour
const UNLOCK_GLOBAL_LIMIT = 100; // unlock attempts per hour across all instances
const HOUR_MS = 60 * 60 * 1000;

const unlockHits = new Map<string, number[]>();
function tooManyUnlocksForIp(ip: string, now: number): boolean {
  const cutoff = now - HOUR_MS;
  const hits = (unlockHits.get(ip) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  unlockHits.set(ip, hits);
  if (unlockHits.size > 5000) {
    for (const [k, v] of unlockHits) {
      if (v.every((t) => t <= cutoff)) unlockHits.delete(k);
    }
  }
  return hits.length > UNLOCK_IP_LIMIT;
}

function clientIp(req: NextRequest): string {
  // Prefer the platform-set x-real-ip (not client-spoofable). Fall back to the
  // LAST x-forwarded-for entry (Vercel appends the real connecting IP at the
  // end); the leftmost entry is attacker-controlled, so never trust it.
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }
  return "unknown";
}

function ok<T>(data: T) {
  return NextResponse.json({ success: true, data });
}
function fail(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  const secret = process.env.PRACTICE_BRAIN_SESSION_SECRET ?? "";
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    // Unlock: verify a per-user password and issue the signed session cookie.
    if (action === "unlock") {
      const password = String(body.password ?? "");
      if (!password) return fail("Password required.");
      if (!secret) return fail("Server missing PRACTICE_BRAIN_SESSION_SECRET.", 500);
      // Rate-limit BEFORE touching the credential check so a bot cannot grind
      // passwords: per-IP cap first, then the shared cross-instance budget.
      if (tooManyUnlocksForIp(clientIp(req), Date.now())) {
        return fail("Too many attempts. Please try again later.", 429);
      }
      if (!(await consumeBudget("pb-unlock", UNLOCK_GLOBAL_LIMIT, 3600))) {
        return fail("Too many attempts. Please try again later.", 429);
      }
      const cred = await verifyCredential(CLIENT_ID, password);
      if (!cred) return fail("Incorrect password.", 401);
      const token = signSession({ credentialId: cred.id, maxTier: cred.tier, exp: Date.now() + SESSION_MS }, secret);
      const res = ok({ label: cred.label, maxTier: cred.tier });
      res.cookies.set(COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
        maxAge: SESSION_MS / 1000,
      });
      return res;
    }

    // Every other action requires a valid unlock cookie. maxTier comes from it, not the client.
    if (!secret) return fail("Server missing PRACTICE_BRAIN_SESSION_SECRET.", 500);
    const session = verifySession(req.cookies.get(COOKIE)?.value, secret);
    if (!session) return fail("Locked. Unlock Practice Brain first.", 401);
    const maxTier = session.maxTier as Tier;

    // Owner-only WRITES. The brain is a password-gated PORTAL: unlock + the read
    // actions (tree, ask, needs-review, gaps, qa-feedback, classify) are protected
    // by the per-tier password alone, with no platform login, by design — this
    // route is excluded from the login proxy and never gates reads on requireUser.
    // But WRITING into the shared knowledge base (which the co-pilot then treats as
    // authoritative grounding) is owner business, so the content-mutating actions
    // additionally require a platform session with an owner/agency role, the same
    // owner-only gate the page + nav enforce. This is IN ADDITION to the unlock
    // cookie above. No-op when auth enforcement is off (requireUser returns null,
    // requireOwnerRole passes null through), so the un-enforced demo is unchanged.
    const MUTATING_ACTIONS = new Set(["create", "learn", "resolve-gap", "resolve-review"]);
    if (MUTATING_ACTIONS.has(action)) {
      const authed = await requireUser();
      if (authed instanceof Response) return fail("Sign in as the practice owner to change the brain.", 401);
      if (requireOwnerRole(authed)) return fail("Only the practice owner or agency can change the practice brain.", 403);
    }

    if (action === "tree") {
      const all = await listActiveNodes(CLIENT_ID);
      return ok({ nodes: visibleNodes(all, maxTier), maxTier });
    }

    if (action === "classify") {
      const rawInput = String(body.rawInput ?? "").trim();
      if (!rawInput) return fail("Note is empty.");
      const branches = await listBranchNames(CLIENT_ID);
      const result = await classifyKnowledge(rawInput, branches);
      return ok(result);
    }

    if (action === "create") {
      const result = body.result as ClassificationResult | undefined;
      const rawInput = String(body.rawInput ?? "").trim();
      if (!result || !rawInput) return fail("Missing classification or note.");
      // The classification arrives from the client, so never trust its tier or
      // review flag. Only callers at or above the review gate (tier >= 3, the
      // same gate as needs-review/gaps/resolve-review) may publish an active
      // node or choose its tier; everyone else fails closed to needs_review at
      // tier 4, per the ClassificationResult contract in types.ts. Invalid
      // tier values fail closed to 4 too.
      const canPublish = maxTier >= 3;
      const tierNum = Math.round(Number(result.tier));
      const claimedTier: Tier = [1, 2, 3, 4].includes(tierNum) ? (tierNum as Tier) : 4;
      const tier: Tier = canPublish ? claimedTier : 4;
      const needsReview = canPublish ? Boolean(result.needsReview) : true;
      const classification = {
        reasoning: result.reasoning,
        confidence: result.confidence,
        branchIsNew: result.branchIsNew,
      };
      const parentId = needsReview || !result.branch
        ? null
        : await ensureBranch(CLIENT_ID, result.branch, tier);
      const node = await createItem({
        clientId: CLIENT_ID,
        parentId,
        title: result.title,
        body: result.body,
        rawInput,
        tier,
        tags: result.tags,
        status: needsReview ? "needs_review" : "active",
        classification,
        createdBy: session.credentialId,
      });
      return ok(node);
    }

    if (action === "needs-review") {
      if (maxTier < 3) return fail("Not authorised.", 403);
      return ok({ nodes: await listNeedsReview(CLIENT_ID) });
    }

    if (action === "ask") {
      const question = String(body.question ?? "").trim();
      if (!question) return fail("Question is empty.");
      const ranked = await searchKnowledge(CLIENT_ID, question, maxTier, 6);
      const result = await askCopilot(question, ranked);
      // The gap + QA writes are best-effort audit logging: a transient DB error must
      // NOT discard a successfully generated answer. Log-and-continue, returning
      // qaId: null so the UI hides the feedback buttons (they need a qaId).
      let qaId: string | null = null;
      try {
        if (ranked.length === 0) await logKnowledgeGap(CLIENT_ID, question, maxTier);
        qaId = await logQa({
          clientId: CLIENT_ID, question, answer: result.answer, groundedIn: result.groundedIn,
          askerTier: maxTier, citedIds: result.citations.map((c) => c.id),
        });
      } catch (err) {
        console.error("[practice-brain] ask: audit logging failed; returning the answer anyway", err);
      }
      return ok({ ...result, usedNodeIds: ranked.map((r) => r.node.id), qaId });
    }

    if (action === "qa-feedback") {
      const id = String(body.id ?? "");
      const value = Number(body.value);
      if (!id || (value !== 1 && value !== -1)) return fail("Invalid feedback.");
      await setQaFeedback(id, value);
      return ok({ id, value });
    }

    if (action === "learn") {
      const text = String(body.text ?? "").trim();
      if (!text) return fail("Nothing to save.");
      const branches = await listBranchNames(CLIENT_ID);
      const result = await classifyKnowledge(text, branches);
      // Same publish gate as `create`: the classifier output is not authoritative
      // for clearance. Only callers at or above the review gate (maxTier >= 3) may
      // publish an active node or choose its tier; everyone else fails closed to
      // needs_review at tier 4, so a low-tier capture lands in the review queue
      // rather than going live in the shared brain (and the co-pilot's grounding).
      const canPublish = maxTier >= 3;
      const tierNum = Math.round(Number(result.tier));
      const claimedTier: Tier = [1, 2, 3, 4].includes(tierNum) ? (tierNum as Tier) : 4;
      const tier: Tier = canPublish ? claimedTier : 4;
      const needsReview = canPublish ? Boolean(result.needsReview) : true;
      const classification = { reasoning: result.reasoning, confidence: result.confidence, branchIsNew: result.branchIsNew };
      const parentId = needsReview || !result.branch ? null : await ensureBranch(CLIENT_ID, result.branch, tier);
      const node = await createItem({
        clientId: CLIENT_ID, parentId, title: result.title, body: result.body, rawInput: text,
        tier, tags: result.tags, status: needsReview ? "needs_review" : "active",
        classification, createdBy: session.credentialId, source: "copilot_capture",
      });
      return ok({ node, needsReview, tier, branch: result.branch });
    }

    if (action === "gaps") {
      if (maxTier < 3) return fail("Not authorised.", 403);
      return ok({ gaps: await listOpenGaps(CLIENT_ID) });
    }

    if (action === "resolve-gap") {
      if (maxTier < 3) return fail("Not authorised.", 403);
      const id = String(body.id ?? "");
      if (!id) return fail("Missing id.");
      await resolveGap(id);
      return ok({ id });
    }

    if (action === "resolve-review") {
      if (maxTier < 3) return fail("Not authorised.", 403);
      const id = String(body.id ?? "");
      const branch = String(body.branch ?? "");
      const tierNum = Math.round(Number(body.tier));
      if (!id || !branch) return fail("Missing id or branch.");
      if (![1, 2, 3, 4].includes(tierNum)) return fail("Tier must be 1 to 4.");
      const tier = tierNum as Tier;
      const parentId = await ensureBranch(CLIENT_ID, branch, tier);
      await resolveReview(id, { tier, parentId });
      return ok({ id });
    }

    return fail(`Unknown action: ${action}`, 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error.";
    return fail(message, 500);
  }
}
