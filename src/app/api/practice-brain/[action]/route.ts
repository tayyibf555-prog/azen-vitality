import { NextResponse, type NextRequest } from "next/server";
import { classifyKnowledge } from "@/lib/practice-brain/classify";
import { visibleNodes } from "@/lib/practice-brain/clearance";
import { askCopilot } from "@/lib/practice-brain/copilot";
import { searchKnowledge } from "@/lib/practice-brain/retrieval";
import { signSession, verifySession } from "@/lib/practice-brain/session";
import type { ClassificationResult, Tier } from "@/lib/practice-brain/types";
import {
  createItem, ensureBranch, listActiveNodes, listBranchNames, listNeedsReview, resolveReview, verifyCredential,
} from "@/lib/practice-brain/repository";

const CLIENT_ID = "vitality";
const COOKIE = "pb_session";
const SESSION_MS = 1000 * 60 * 60 * 8;

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
      const tier = result.tier as Tier;
      const classification = {
        reasoning: result.reasoning,
        confidence: result.confidence,
        branchIsNew: result.branchIsNew,
      };
      const parentId = result.needsReview || !result.branch
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
        status: result.needsReview ? "needs_review" : "active",
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
      return ok({ ...result, usedNodeIds: ranked.map((r) => r.node.id) });
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
