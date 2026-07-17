// CREATIVE INTELLIGENCE: turn one library ad into a grounded, structured analysis.
//
// GROUNDING CONTRACT (why this file is careful):
//   The model is shown ONLY the ad's real attributes: its text (headline, primary
//   text, offer, hook), its format, the platform (Meta: Facebook and Instagram)
//   with the placement its format implies, its treatment, and its longevity (days
//   running). It is NOT shown, and must not invent: the advertiser name, location,
//   any performance/CTR/spend figure, or our internal "estimated performance" tag.
//   The model contributes qualitative judgement (five factor scores) and prose
//   (why-it-works, watch-outs). Everything a practice could mistake for a hard
//   metric is computed in CODE, not by the model:
//     - the LONGEVITY-SIGNAL factor           -> from days running (thresholds below)
//     - the OVERALL score and the VERDICT word -> reconciled from the six factors so
//       the headline number can never contradict the bars beneath it
//     - the COST-PER-LEAD range                -> from the hardcoded benchmarks table
//     - the MANDATORY compliance watch-outs    -> from the landing lint's banned lists
//   When the model call fails or returns junk, a deterministic "Quick read" is built
//   from the same code-side signals, clearly labelled, so the view never breaks.
//
// British English, GBP, no dash characters.

import { cleanCopy } from "@/lib/meta-ads/ai";
import { scanBannedText } from "@/lib/landing/compliance";
import type { AdFormat, AdLibraryItem } from "@/lib/meta-ads/types";
import {
  estimateCostPerLead,
  COST_PER_LEAD_CAVEAT,
  type CostPerLeadRange,
} from "./benchmarks";

export type Verdict = "Strong" | "Good" | "Average" | "Weak";
export type LongevitySignal = "strong" | "promising" | "unproven";
export type AnalysisSource = "ai" | "fallback";

/** The six factors shown as bars. All 0 to 100. */
export interface FactorScores {
  hook: number;
  offerClarity: number;
  credibility: number;
  callToAction: number;
  audienceFit: number;
  /** DERIVED deterministically from days running, never from the model. */
  longevitySignal: number;
}

export interface Longevity {
  days: number;
  signal: LongevitySignal;
  /** Human line, for example "Running 96 days". */
  label: string;
}

export interface CostPerLead extends CostPerLeadRange {
  /** Always present; never show a figure without it. */
  caveat: string;
}

export interface CreativeAnalysis {
  overallScore: number; // 0 to 100
  verdict: Verdict;
  factors: FactorScores;
  longevity: Longevity;
  /** 3 to 5 bullets, each referencing a concrete attribute of the ad. */
  why: string[];
  /** 1 to 4 watch-outs; mandatory compliance flags always come first. */
  watchOuts: string[];
  costPerLead: CostPerLead;
  source: AnalysisSource;
  /** The model id used, or "deterministic" for the Quick read fallback. */
  model: string;
}

// --- Deterministic longevity signal ------------------------------------------
// >= 90 days = strong (proven evergreen), 30 to 89 = promising, < 30 = unproven.
export function longevityFromDays(daysRunningRaw: number): Longevity {
  const days = Number.isFinite(daysRunningRaw) ? Math.max(0, Math.round(daysRunningRaw)) : 0;
  const signal: LongevitySignal = days >= 90 ? "strong" : days >= 30 ? "promising" : "unproven";
  return { days, signal, label: `Running ${days} days` };
}

/** The longevity FACTOR score (0 to 100) that matches the signal band. */
function longevityFactorScore(signal: LongevitySignal): number {
  return signal === "strong" ? 90 : signal === "promising" ? 62 : 35;
}

// --- Deterministic compliance watch-outs -------------------------------------
// Reuses the landing lint's banned-pattern lists (single source of truth) and
// raises a MANDATORY watch-out for the GDC/ASA-sensitive categories the practice
// must not copy: testimonials/reviews, guarantees, pain-free claims, superlatives.

const COMPLIANCE_MESSAGES: Partial<Record<ReturnType<typeof scanBannedText>[number]["category"], (m: string) => string>> = {
  testimonial: (m) =>
    `This ad leans on testimonial or review language ("${m}"). You cannot copy that element: patient testimonials and star ratings are prohibited in UK dental advertising (GDC and ASA). Build trust with factual information about your team and service instead.`,
  guarantee: (m) =>
    `This ad uses a guarantee or absolute promise ("${m}"). You cannot copy that: guaranteeing a clinical outcome breaches GDC and ASA rules. Describe the treatment honestly, without promising a result.`,
  pain: (m) =>
    `This ad makes a pain-free claim ("${m}"). You cannot copy that: pain-free or painless claims are not permitted for UK dental ads (GDC and ASA). Offer a calm, gentle experience instead, without promising no pain.`,
  superlative: (m) =>
    `This ad uses a superlative or "best" style claim ("${m}"). You cannot copy that: unsubstantiated superlatives ("best", "No 1") breach ASA and CAP rules. Use specific, verifiable facts instead.`,
};

// Only these four categories are surfaced as mandatory creative compliance flags.
// (Funding and symbol hits from the shared scanner are house-style/positioning
// concerns, not "cannot copy under GDC/ASA" the way these four are.)
const CREATIVE_COMPLIANCE_CATEGORIES = new Set(["testimonial", "guarantee", "pain", "superlative"]);

/** Deterministic, mandatory compliance watch-outs for an ad's copy. */
export function complianceWatchOuts(ad: Pick<AdLibraryItem, "headline" | "primaryText" | "offer">): string[] {
  const text = [ad.headline, ad.primaryText, ad.offer].filter(Boolean).join("\n");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of scanBannedText(text)) {
    if (!CREATIVE_COMPLIANCE_CATEGORIES.has(hit.category)) continue;
    if (seen.has(hit.category)) continue;
    seen.add(hit.category);
    const build = COMPLIANCE_MESSAGES[hit.category];
    if (build) out.push(build(hit.matched));
  }
  return out;
}

// --- Scoring reconciliation --------------------------------------------------
// Documented weights so the overall score is always a transparent function of the
// six factor bars (five from the model, longevity from code). Sum = 1.00.
const FACTOR_WEIGHTS: Record<keyof FactorScores, number> = {
  hook: 0.22,
  offerClarity: 0.2,
  credibility: 0.16,
  callToAction: 0.14,
  audienceFit: 0.13,
  longevitySignal: 0.15,
};

function clampScore(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.min(100, Math.max(0, Math.round(v)));
}

function overallFromFactors(f: FactorScores): number {
  const sum =
    f.hook * FACTOR_WEIGHTS.hook +
    f.offerClarity * FACTOR_WEIGHTS.offerClarity +
    f.credibility * FACTOR_WEIGHTS.credibility +
    f.callToAction * FACTOR_WEIGHTS.callToAction +
    f.audienceFit * FACTOR_WEIGHTS.audienceFit +
    f.longevitySignal * FACTOR_WEIGHTS.longevitySignal;
  return Math.min(100, Math.max(0, Math.round(sum)));
}

/** Verdict word from the overall score band. Deterministic, so it always agrees. */
export function verdictFromScore(score: number): Verdict {
  if (score >= 80) return "Strong";
  if (score >= 65) return "Good";
  if (score >= 45) return "Average";
  return "Weak";
}

// --- The subset of attributes the model is allowed to see --------------------

/** Meta placement implied by the creative format (not an invented attribute). */
function placementFromFormat(format: AdFormat): string {
  switch (format) {
    case "reel":
      return "Reels and Stories (9:16 vertical)";
    case "carousel":
      return "feed (swipeable carousel)";
    case "video":
      return "feed (in-feed video)";
    case "image":
    default:
      return "feed (single image)";
  }
}

/**
 * Build the system + user prompt. The user payload contains ONLY the allow-listed
 * real attributes (see the grounding contract). Kept pure so it is testable.
 */
export function buildAnalysisPrompt(ad: AdLibraryItem): { system: string; user: string } {
  const longevity = longevityFromDays(ad.daysRunning);
  const system = [
    "You are a senior UK dental marketing strategist scoring one competitor's Meta (Facebook and Instagram) ad for the owner of a dental practice.",
    "You are given ONLY the ad's real attributes: its text, its format and placement, the platform, the treatment it promotes, and how long it has been running. Judge the creative on those alone.",
    "Do NOT invent numbers you were not given: no CTR, no spend, no click or lead counts, no audience size. Do not name or praise the advertiser.",
    "Score five factors from 0 to 100: hook (does the opening earn attention), offerClarity (is the offer concrete and low-friction), credibility (does it feel trustworthy and honest, not hypey), callToAction (is the next step clear), audienceFit (does the message match who buys this treatment).",
    "Do NOT score longevity: that is computed separately from the days-running value.",
    "Give an overallScore 0 to 100 and a one-word verdict from exactly: Strong, Good, Average, Weak.",
    "Give 3 to 5 'why this works' bullets. EACH bullet MUST reference a concrete attribute of THIS ad: quote a few words of the hook, name the specific offer, or cite the format or how long it has run. Generic marketing platitudes are not acceptable.",
    "Give 1 to 3 'watch-outs': honest risks or weaknesses in the creative.",
    "British English. Money in GBP with the £ symbol. Never use an em-dash or en-dash; use commas, full stops or brackets.",
    "Do not use double-quote characters inside any string value (it breaks the JSON); use single quotes if you must quote.",
    'Respond with ONLY a JSON object: {"overallScore": 0, "verdict": "Strong|Good|Average|Weak", "factors": {"hook": 0, "offerClarity": 0, "credibility": 0, "callToAction": 0, "audienceFit": 0}, "why": ["..."], "watchOuts": ["..."]}.',
  ].join("\n");

  const user = [
    `Treatment: ${ad.treatment}`,
    `Platform: Meta (Facebook and Instagram)`,
    `Format and placement: ${ad.format}, shown in ${placementFromFormat(ad.format)}`,
    `Longevity: has been running ${longevity.days} days`,
    `Hook style: ${ad.hookType}`,
    `Headline: ${ad.headline}`,
    `Primary text: ${ad.primaryText}`,
    `Offer: ${ad.offer}`,
  ].join("\n");

  return { system, user };
}

// --- Model reply parsing -----------------------------------------------------

export interface ModelAnalysis {
  overallScore: number;
  verdict: string;
  factors: {
    hook: number;
    offerClarity: number;
    credibility: number;
    callToAction: number;
    audienceFit: number;
  };
  why: string[];
  watchOuts: string[];
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => cleanCopy(String(x ?? ""))).filter(Boolean);
}

/**
 * Parse the model's JSON reply into a ModelAnalysis, or null when it is unusable.
 * "Usable" requires all five factor numbers and at least three why bullets: that is
 * the bar below which we fall back to the deterministic Quick read.
 */
export function parseModelAnalysis(text: string): ModelAnalysis | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const f = parsed.factors;
  if (!f || typeof f !== "object") return null;
  const factorsObj = f as Record<string, unknown>;
  const numeric = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
  if (
    !numeric(factorsObj.hook) ||
    !numeric(factorsObj.offerClarity) ||
    !numeric(factorsObj.credibility) ||
    !numeric(factorsObj.callToAction) ||
    !numeric(factorsObj.audienceFit)
  ) {
    return null;
  }
  const why = toStringArray(parsed.why);
  if (why.length < 3) return null;

  return {
    overallScore: typeof parsed.overallScore === "number" ? parsed.overallScore : 0,
    verdict: typeof parsed.verdict === "string" ? parsed.verdict : "",
    factors: {
      hook: factorsObj.hook as number,
      offerClarity: factorsObj.offerClarity as number,
      credibility: factorsObj.credibility as number,
      callToAction: factorsObj.callToAction as number,
      audienceFit: factorsObj.audienceFit as number,
    },
    why,
    watchOuts: toStringArray(parsed.watchOuts),
  };
}

// --- Assembly ----------------------------------------------------------------

/** Merge mandatory compliance flags (first) with narrative watch-outs, capped. */
function mergeWatchOuts(compliance: string[], narrative: string[]): string[] {
  const out = [...compliance];
  for (const w of narrative) {
    if (out.length >= 4) break;
    if (!out.includes(w)) out.push(w);
  }
  // Guarantee at least one watch-out so the section is never empty.
  if (out.length === 0) {
    out.push("No obvious compliance risks in the copy, but always adapt the angle to your own practice and confirm any claim you make.");
  }
  return out;
}

/**
 * Build the final analysis from the model's (validated) reply. Longevity, overall
 * score, verdict, cost-per-lead and compliance flags are all computed in code.
 */
export function assembleFromModel(ad: AdLibraryItem, model: ModelAnalysis, modelId: string): CreativeAnalysis {
  const longevity = longevityFromDays(ad.daysRunning);
  const factors: FactorScores = {
    hook: clampScore(model.factors.hook),
    offerClarity: clampScore(model.factors.offerClarity),
    credibility: clampScore(model.factors.credibility),
    callToAction: clampScore(model.factors.callToAction),
    audienceFit: clampScore(model.factors.audienceFit),
    longevitySignal: longevityFactorScore(longevity.signal),
  };
  const overallScore = overallFromFactors(factors);
  const why = model.why.slice(0, 5);
  const compliance = complianceWatchOuts(ad);
  const range = estimateCostPerLead(ad.treatment, factors.offerClarity);

  return {
    overallScore,
    verdict: verdictFromScore(overallScore),
    factors,
    longevity,
    why,
    watchOuts: mergeWatchOuts(compliance, model.watchOuts),
    costPerLead: { ...range, caveat: COST_PER_LEAD_CAVEAT },
    source: "ai",
    model: modelId,
  };
}

// --- Deterministic "Quick read" fallback -------------------------------------
// Built from the same code-side signals when the model is unavailable. Every factor
// is a transparent heuristic over the ad's real attributes; every why-bullet quotes
// a concrete attribute. Clearly labelled via source: "fallback".

const CTA_VERBS = /\b(book|take|ask|call|get|start|see|check|claim|find out|discover|enquire|register)\b/i;
const HONEST_MARKERS = /\b(subject to|clinical assessment|consultation|confirmed|suitability)\b/i;
const CONCRETE_OFFER = /(£\s?\d|free|included|finance|\d+\s?%|worth £?\d)/i;

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Deterministic factor scores from the ad's attributes (the Quick read). */
export function fallbackFactors(ad: AdLibraryItem): FactorScores {
  const longevity = longevityFromDays(ad.daysRunning);
  const hasCompliance = complianceWatchOuts(ad).length > 0;
  const combined = `${ad.headline}\n${ad.primaryText}\n${ad.offer}`;

  let hook = 58;
  if (ad.hookType && ad.hookType.trim().length > 0) hook += 12;
  const hw = wordCount(ad.headline);
  if (hw >= 4 && hw <= 12) hook += 12;

  let offerClarity = 50;
  if (ad.offer && ad.offer.trim().length > 0) offerClarity += 18;
  if (CONCRETE_OFFER.test(ad.offer) || CONCRETE_OFFER.test(combined)) offerClarity += 16;

  let credibility = 62;
  if (HONEST_MARKERS.test(combined)) credibility += 12;
  if (hasCompliance) credibility -= 22;

  let callToAction = 55;
  if (CTA_VERBS.test(combined)) callToAction += 16;

  let audienceFit = 60;
  // A clear treatment focus is a mild positive for targeting.
  if (ad.treatment && ad.treatment.trim().length > 0) audienceFit += 6;

  return {
    hook: clampScore(hook),
    offerClarity: clampScore(offerClarity),
    credibility: clampScore(credibility),
    callToAction: clampScore(callToAction),
    audienceFit: clampScore(audienceFit),
    longevitySignal: longevityFactorScore(longevity.signal),
  };
}

function fallbackWhy(ad: AdLibraryItem, longevity: Longevity): string[] {
  const shortHook = ad.headline.length > 60 ? `${ad.headline.slice(0, 57)}...` : ad.headline;
  const longevityWord =
    longevity.signal === "strong" ? "a strong signal that it converts" : longevity.signal === "promising" ? "a promising early signal" : "still an unproven signal";
  const bullets = [
    `The hook, "${shortHook}", leads with the outcome rather than the clinical detail, which tends to travel further on Meta.`,
    ad.offer && ad.offer.trim()
      ? `The offer ("${ad.offer}") gives a clear, low-friction reason to act now.`
      : `The ${ad.hookType.toLowerCase()} angle gives the viewer a reason to stop and read.`,
    `It has been running ${longevity.days} days, ${longevityWord} for this kind of ${ad.treatment.toLowerCase()} creative.`,
  ];
  return bullets.map((b) => cleanCopy(b));
}

/** Build the deterministic Quick read for an ad (used when the model fails). */
export function fallbackAnalysis(ad: AdLibraryItem): CreativeAnalysis {
  const longevity = longevityFromDays(ad.daysRunning);
  const factors = fallbackFactors(ad);
  const overallScore = overallFromFactors(factors);
  const compliance = complianceWatchOuts(ad);
  const range = estimateCostPerLead(ad.treatment, factors.offerClarity);

  return {
    overallScore,
    verdict: verdictFromScore(overallScore),
    factors,
    longevity,
    why: fallbackWhy(ad, longevity),
    watchOuts: mergeWatchOuts(compliance, []),
    costPerLead: { ...range, caveat: COST_PER_LEAD_CAVEAT },
    source: "fallback",
    model: "deterministic",
  };
}
