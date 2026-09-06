import { NextResponse, type NextRequest } from "next/server";
import { consumeBudget } from "@/lib/rate-budget";
import { classifyKnowledge } from "@/lib/practice-brain/classify";
import { visibleNodes } from "@/lib/practice-brain/clearance";
import { plainLabel } from "@/lib/practice-brain/fencing";
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

// ---------------------------------------------------------------------------
// THE MODEL DOORS ARE METERED, AND WHAT GOES INTO THEM IS BOUNDED.
//
// Charter section 0 item 10: "budget consumed before the client is constructed,
// `api_budget` on any public AI endpoint." Three actions here reach Anthropic —
// `ask` (Sonnet, a retrieval then a completion), `classify` and `learn` (Sonnet,
// max_tokens 4000) — and until this block existed the ONLY consumeBudget in the
// file was `pb-unlock`, spent on the unlock ATTEMPT. So one successful unlock
// bought an eight-hour cookie with unlimited, unmetered, unbounded-size model
// calls against the practice's own Anthropic key. That is a cost surface, not a
// data leak, but nothing in the platform counted it, capped it or refused it, and
// nothing on any screen would have shown the bill growing.
//
// THIS IS A PASSWORD-GATED PORTAL, WHICH IS NOT AN EXEMPTION. The route's own
// header (below) says reads are protected "by the per-tier password alone, with
// no platform login, by design", and the closest sibling in the tree — the public
// pre-visit submit — is signed-token-gated and STILL carries both a per-IP and a
// per-token budget. A bearer credential is not treated as a substitute for a
// spend cap anywhere else here.
//
// PER CREDENTIAL, THEN GLOBALLY, and deliberately NOT per IP. The password is
// shared per tier, so the credential id off the signed cookie is the identity a
// caller must actually hold; keying on the address as well would add a dimension
// the attacker already controls for free (a loop from twenty IPs still holds one
// credential) while doubling the round trips. The global ceiling is the one that
// bounds the practice's bill when a whole tier's password is loose.
//
// `consumeBudget` fails OPEN on a database error, by design (src/lib/rate-budget.ts):
// a transient outage degrades the cost cap rather than breaking the portal.
//
// THE INPUT CEILING IS THE OTHER HALF. `ask` and `classify` used to read
// `String(body.question ?? "")` / `body.rawInput` with no length check at all —
// the one AI door in this tree with no size gate (the equipment desk caps a chat
// message at 4,000 characters; the pre-visit submit caps the whole body at 16KB),
// so a 500KB "question" went into the prompt verbatim. A capped call is still a
// call somebody pays for, so the size gate is what stops each one being the most
// expensive call it could be. Refused BEFORE the budget is spent, exactly as the
// pre-visit submit refuses an oversized body before its two budgets.
const HOUR_SECONDS = 3600;
/** A question is a sentence somebody typed; the equipment desk's own per-message cap. */
const ASK_INPUT_MAX = 4_000;
/** A note pasted for classification is longer prose, so a looser ceiling — still a ceiling. */
const NOTE_INPUT_MAX = 8_000;
/** Model calls per hour for one unlocked credential. A human asking questions is nowhere near this. */
const AI_BUDGET_PER_CREDENTIAL = 60;
/** Model calls per hour across every instance and every credential: the practice's bill, bounded. */
const AI_BUDGET_GLOBAL = 600;

/**
 * True when this model call must NOT be made. Per-credential first (the cheap,
 * targeted refusal), then the shared ceiling. Each action keeps its own pair of
 * keys so a runaway `ask` loop cannot starve the owner's `learn`.
 */
async function outOfAiBudget(action: string, credentialId: string): Promise<boolean> {
  if (!(await consumeBudget(`pb-${action}:${credentialId}`, AI_BUDGET_PER_CREDENTIAL, HOUR_SECONDS))) return true;
  return !(await consumeBudget(`pb-${action}`, AI_BUDGET_GLOBAL, HOUR_SECONDS));
}

/** One sentence for every metered refusal: it says nothing about which cap was hit. */
const AI_BUSY = "Practice Brain is busy. Please try again shortly.";

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

// ---------------------------------------------------------------------------
// TITLES AND BRANCH NAMES ARE PLATFORM LABELS, SO STORE THEM AS LABELS.
//
// Both prompt builders now normalise every label they emit (see
// src/lib/practice-brain/fencing.ts — the security property is closed at prompt
// build, for rows written before this route existed too). This is the OTHER
// half, defence in depth on the WRITE side: `create` takes `result` straight
// off the request body and `learn` takes it straight off the classifier's own
// JSON, and `parseClassification` applies only `stripEmDash` — so what lands in
// the unbounded `text` column (migration 0003_practice_brain.sql) is arbitrary
// multi-line text, and it renders in the tree UI, the needs-review queue and the
// citation chips. `plainLabel` (no nonce argument: a write has no fence to
// close) forces one line, no controls, bounded — the shape a label claims to be.
//
// A BLANK branch is not a branch. `plainLabel` substitutes EMPTY_LABEL for an
// empty value, which is right for a title (a `title:` line is never blank) and
// wrong for a branch: it would invent an "Untitled note" branch out of whitespace
// nobody typed. Blank therefore fails closed to null — no branch, the node stays
// parentless (`create`/`learn`) or the request is refused (`resolve-review`).
function branchLabel(value: unknown): string | null {
  const raw = String(value ?? "");
  if (!raw.trim()) return null;
  return plainLabel(raw);
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
      // W3/46: THE PASSWORD IS NOT ENOUGH ON ITS OWN. This route is excluded from
      // the login proxy (src/proxy.ts's matcher omits "api"), so until this check
      // existed POST /api/practice-brain/unlock was reachable from the open
      // internet by anyone holding the password — and that password is published
      // in supabase/migrations/0003_practice_brain.sql, in the 2026-06-19 plan
      // document and in this repository's PUBLIC history, and the live credential
      // still answers to it. A password-only door into the whole knowledge base is
      // a second, weaker authentication system standing beside the real one.
      //
      // The only caller is src/components/client/practice-brain/password-gate.tsx,
      // which renders inside an already-guarded page, so every legitimate unlock
      // already carries a platform session and nothing legitimate changes.
      //
      // Checked BEFORE the rate limits below, so an anonymous caller cannot burn
      // the shared 100-per-hour unlock budget and lock the practice out either.
      // No-op when auth enforcement is off (requireUser returns null), so the
      // un-enforced local demo is unchanged.
      const authedForUnlock = await requireUser();
      if (authedForUnlock instanceof Response) return fail("Sign in to unlock Practice Brain.", 401);

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

    // Owner-only WRITES. The brain is a password-gated portal layered ON TOP of
    // the platform login: since W3/46 the unlock above requires a platform session
    // as well as the per-tier password, so the read actions (tree, ask,
    // needs-review, gaps, qa-feedback, classify) are reachable only with a valid
    // unlock cookie, which in turn can only have been minted by a signed-in user.
    // The per-tier password still decides WHICH tiers those reads return.
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
      if (rawInput.length > NOTE_INPUT_MAX) return fail("That note is too long to classify.", 413);
      if (await outOfAiBudget("classify", session.credentialId)) return fail(AI_BUSY, 429);
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
      const branch = branchLabel(result.branch);
      const parentId = needsReview || !branch
        ? null
        : await ensureBranch(CLIENT_ID, branch, tier);
      const node = await createItem({
        clientId: CLIENT_ID,
        parentId,
        title: plainLabel(result.title),
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
      if (question.length > ASK_INPUT_MAX) return fail("That question is too long.", 413);
      // Ahead of the retrieval as well as the completion: a refused call costs no
      // database work either.
      if (await outOfAiBudget("ask", session.credentialId)) return fail(AI_BUSY, 429);
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
      if (text.length > NOTE_INPUT_MAX) return fail("That note is too long to save.", 413);
      // `learn` clears requireUser + requireOwnerRole above, so it is far less
      // exposed than the two reads — and it is still a Sonnet call on the same key.
      if (await outOfAiBudget("learn", session.credentialId)) return fail(AI_BUSY, 429);
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
      const branch = branchLabel(result.branch);
      const parentId = needsReview || !branch ? null : await ensureBranch(CLIENT_ID, branch, tier);
      const node = await createItem({
        clientId: CLIENT_ID, parentId, title: plainLabel(result.title), body: result.body, rawInput: text,
        tier, tags: result.tags, status: needsReview ? "needs_review" : "active",
        classification, createdBy: session.credentialId, source: "copilot_capture",
      });
      return ok({ node, needsReview, tier, branch });
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
      const branch = branchLabel(body.branch);
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
