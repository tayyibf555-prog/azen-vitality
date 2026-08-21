// RECREATE-AD copy transform. A PURE module (no network, no React): the model call
// is INJECTED, so the whole compliance-gated transform is unit-testable without the
// Anthropic SDK, exactly like landing/generate-run.ts.
//
// WHAT "RECREATE" MEANS HERE, and what it must never mean:
//   * INSPIRED-BY-STRUCTURE. We study a competitor's winning ad for its STRUCTURE
//     only: its hook shape (a question, a bold statement, an offer), how it frames
//     the offer, and its call-to-action TYPE. From that we write a COMPLETELY
//     ORIGINAL ad for Vitality's real service.
//   * NEVER A COPY. Not one of the competitor's words, sentences, claims, figures,
//     percentages, prices, guarantees, brand names, reviews or rankings may appear in
//     the output. This is a hard, deterministic gate, not a request to the model.
//
// TWO GATES, both deterministic:
//   1. scanBannedText  - the SAME funnel/landing compliance scan (testimonials,
//      guarantees, pain-free, superlatives, NHS/private funding words, banned
//      symbols, invented proof). A generated ad passes the exact rules a landing
//      page must pass.
//   2. the ECHO guard  - the two-point rule: the output shares NO figure, ranking or
//      review claim, brand name or verbatim phrase with the source ad. This is what
//      guarantees "a competitor claim/figure/review in the source never appears in
//      the output", independently of gate 1.
//
// One REPAIR pass: on a first failure the flow regenerates once, quoting the exact
// failures back. If it still fails, the draft is BLOCKED with the reasons (there is
// no fabricated fallback for a competitor recreate: an honest block is the safe
// outcome, and the owner sees why).
//
// British English, GBP, no dash characters.

import type { Treatment } from "@/lib/treatments/catalog";
import { TREATMENTS } from "@/lib/treatments/catalog";
import { scanBannedText } from "@/lib/landing/compliance";
import { cleanCopy } from "./ai";

/** The minimal shape of a stored winning ad this transform needs (StoredWinningAd is assignable). */
export interface RecreateSourceAd {
  pageName: string | null;
  title: string | null;
  bodyText: string | null;
  ctaText: string | null;
  ctaType: string | null;
  keyword: string;
}

/** The generated, compliance-checked ad copy (mirrors MetaCampaignCopy). */
export interface RecreatedCopy {
  headline: string;
  primaryText: string;
  description: string;
  cta: string;
  complianceNote: string;
}

/** One reason a recreated ad was rejected, for the repair prompt and the UI. */
export interface RecreateFailure {
  category: "banned" | "echo-figure" | "echo-claim" | "echo-brand" | "echo-phrase";
  /** The offending phrase / token. */
  matched: string;
  /** A one-line, human explanation. */
  detail: string;
}

/** A single system+user round trip to the model. Returns the raw reply text. */
export type CallModel = (system: string, user: string) => Promise<string>;

export type RecreateCopyResult =
  | { ok: true; copy: RecreatedCopy; source: "model" | "model-repair" }
  | { ok: false; reason: "compliance"; failures: RecreateFailure[] }
  | { ok: false; reason: "model_unavailable" };

// ---------------------------------------------------------------------------
// TREATMENT RESOLUTION. The winning-ads library tags each ad with a derived
// `keyword`; a recreate is for one of VITALITY'S REAL catalogue services, so we map
// that keyword to a real treatment and fall back to a general consultation when the
// competitor's treatment is not one Vitality offers (we never invent a service).
// ---------------------------------------------------------------------------

const KEYWORD_TO_TREATMENT_KEY: Record<string, string> = {
  "dental-implants": "implant",
  "clear-aligners": "invisalign",
  orthodontics: "invisalign",
  veneers: "veneers",
  "teeth-whitening": "whitening",
  "root-canal": "root_canal",
  hygiene: "hygiene",
  checkup: "checkup",
  // No direct Vitality catalogue service: recreate as a general consultation rather
  // than misrepresent a treatment the practice does not list.
  "crowns-bridges": "checkup",
  dentures: "checkup",
  "general-dentistry": "checkup",
};

/** The fallback treatment key: a general new-patient consultation Vitality genuinely offers. */
export const FALLBACK_TREATMENT_KEY = "checkup";

function treatmentByKey(key: string): Treatment | null {
  return TREATMENTS.find((t) => t.key === key) ?? null;
}

/**
 * The real Vitality treatment to recreate the ad for. An explicit, valid `overrideKey`
 * (the owner choosing) wins; otherwise the ad's keyword is mapped; otherwise the
 * general-consultation fallback. Always a real catalogue treatment, never null in
 * practice (the fallback is a real key).
 */
export function resolveRecreateTreatment(keyword: string, overrideKey?: string | null): Treatment {
  if (overrideKey) {
    const override = treatmentByKey(overrideKey);
    if (override) return override;
  }
  const mapped = treatmentByKey(KEYWORD_TO_TREATMENT_KEY[keyword] ?? FALLBACK_TREATMENT_KEY);
  return mapped ?? (treatmentByKey(FALLBACK_TREATMENT_KEY) as Treatment);
}

// ---------------------------------------------------------------------------
// SOURCE SIGNATURES. What the output must never echo.
// ---------------------------------------------------------------------------

/** Every numeric/money/percent figure in a text, normalised to a comparable token. */
function numericSignatures(text: string): { raw: string; canonical: string }[] {
  const out: { raw: string; canonical: string }[] = [];
  if (!text) return out;
  // Money, percentages, and "35K members / 35,000 members / 10,000 patients" style
  // scale claims. Each is normalised to a bare integer so "35K" and "35,000" collide.
  const re = /(£\s?\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?\s?%)|(\d[\d,]*(?:\.\d+)?\s?[kKmM])\b|(\d[\d,]{2,})/g;
  for (const m of text.matchAll(re)) {
    const raw = (m[0] ?? "").trim();
    const digits = raw.replace(/[^0-9.]/g, "");
    if (!digits) continue;
    let value = Number(digits);
    if (!Number.isFinite(value)) continue;
    if (/[kK]/.test(raw)) value *= 1_000;
    else if (/[mM]/.test(raw)) value *= 1_000_000;
    const canonical = String(Math.round(value));
    // Ignore trivially small, benign numbers ("3 steps", "1 visit"); a competitor's
    // headline claim (16995, 35000, 70) is what we are guarding against.
    if (value < 10) continue;
    out.push({ raw, canonical });
  }
  return out;
}

// Ranking / review / rating claim shapes. These are ALSO banned outright by
// scanBannedText, but the echo guard checks them source-relative so the "never
// echoes the source" guarantee stands on its own.
const CLAIM_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /#\s?\d+/, label: "a ranking claim" },
  { re: /\bno\.? ?1\b/i, label: "a number-one claim" },
  { re: /\bnumber one\b/i, label: "a number-one claim" },
  { re: /\brated\b/i, label: "a rating claim" },
  { re: /\brating\b/i, label: "a rating claim" },
  { re: /\breviews?\b/i, label: "a reviews claim" },
  { re: /\b(?:five|5)[ -]?stars?\b/i, label: "a star-rating claim" },
  { re: /\bworld[ -]?class\b/i, label: "a world-class claim" },
  { re: /\bmembers?\b/i, label: "a membership-count claim" },
  { re: /\bguarantee(?:d|s)?\b/i, label: "a guarantee" },
];

/** Generic words in a page name that are not distinctive enough to be a brand echo. */
const GENERIC_BRAND_WORDS = new Set([
  "dental", "dentist", "dentistry", "clinic", "clinique", "care", "centre", "center",
  "smile", "smiles", "teeth", "tooth", "practice", "surgery", "the", "and", "of", "uk",
  "studio", "group", "co", "ltd", "implant", "implants", "orthodontics", "aesthetics",
]);

function distinctiveBrandTokens(pageName: string | null): string[] {
  if (!pageName) return [];
  return pageName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !GENERIC_BRAND_WORDS.has(w));
}

function words(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Contiguous n-grams of length `n`. */
function ngrams(tokens: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i += 1) {
    out.add(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

/**
 * THE ECHO GUARD (the two-point rule). Returns every source claim / figure / brand /
 * verbatim phrase that leaked into the output. Empty means the output is genuinely
 * original with respect to this source.
 */
export function outputEchoesSource(copy: RecreatedCopy, sourceAd: RecreateSourceAd): RecreateFailure[] {
  const failures: RecreateFailure[] = [];
  const sourceText = `${sourceAd.title ?? ""} ${sourceAd.bodyText ?? ""} ${sourceAd.ctaText ?? ""}`;
  const outputText = [copy.headline, copy.primaryText, copy.description, copy.cta, copy.complianceNote].join(" ");
  const outputLower = outputText.toLowerCase();

  // (1) FIGURES: any competitor figure that reappears in the output, matched on the
  //     normalised value so "35K" and "35,000" are the same claim.
  const sourceNums = new Set(numericSignatures(sourceText).map((s) => s.canonical));
  for (const { raw, canonical } of numericSignatures(outputText)) {
    if (sourceNums.has(canonical)) {
      failures.push({
        category: "echo-figure",
        matched: raw,
        detail: `the figure "${raw}" is the competitor's own claim and must not appear in Vitality's ad`,
      });
    }
  }

  // (2) CLAIMS: a ranking / rating / reviews / membership / guarantee claim present in
  //     BOTH the source and the output.
  for (const { re, label } of CLAIM_PATTERNS) {
    const inSource = re.exec(sourceText);
    const inOutput = re.exec(outputText);
    if (inSource && inOutput) {
      failures.push({
        category: "echo-claim",
        matched: inOutput[0],
        detail: `${label} ("${inOutput[0]}") echoes the competitor and must not appear`,
      });
    }
  }

  // (3) BRAND: the competitor's distinctive name tokens must never appear.
  for (const token of distinctiveBrandTokens(sourceAd.pageName)) {
    if (new RegExp(`\\b${token}\\b`, "i").test(outputLower)) {
      failures.push({
        category: "echo-brand",
        matched: token,
        detail: `the competitor's brand name "${token}" must not appear in Vitality's ad`,
      });
    }
  }

  // (4) VERBATIM PHRASE: any shared run of 6+ words is a copied sentence, not a
  //     structural influence.
  const sourceGrams = ngrams(words(sourceText), 6);
  if (sourceGrams.size > 0) {
    const outputGrams = ngrams(words(outputText), 6);
    for (const gram of outputGrams) {
      if (sourceGrams.has(gram)) {
        failures.push({
          category: "echo-phrase",
          matched: gram,
          detail: `the phrase "${gram}" is copied verbatim from the competitor`,
        });
        break; // one is enough to reject and repair
      }
    }
  }

  return failures;
}

/**
 * The full gate: the shared funnel/landing compliance scan PLUS the source-echo
 * guard, over one recreated copy. `ok` only when both are clean.
 */
export function scanRecreatedCopy(
  copy: RecreatedCopy,
  sourceAd: RecreateSourceAd,
): { ok: boolean; failures: RecreateFailure[] } {
  const failures: RecreateFailure[] = [];
  const combined = [copy.headline, copy.primaryText, copy.description, copy.cta, copy.complianceNote].join("\n");
  for (const hit of scanBannedText(combined)) {
    failures.push({
      category: "banned",
      matched: hit.matched,
      detail: `"${hit.matched}" is not allowed in UK dental ad copy (${hit.category})`,
    });
  }
  failures.push(...outputEchoesSource(copy, sourceAd));
  return { ok: failures.length === 0, failures };
}

/** A one-line, model-facing summary of the failures for the repair prompt. */
export function describeRecreateFailures(failures: RecreateFailure[]): string {
  return failures.map((f) => `- [${f.category}] ${f.detail}`).join("\n");
}

// ---------------------------------------------------------------------------
// THE PROMPT.
// ---------------------------------------------------------------------------

/** A cheap, non-echoing description of the source's hook shape (structure only). */
export function deriveHookShape(sourceAd: RecreateSourceAd): string {
  const head = `${sourceAd.title ?? ""} ${sourceAd.bodyText ?? ""}`.trim();
  const firstChunk = head.slice(0, 80);
  if (/\?/.test(firstChunk)) return "opens with a question that names the reader's worry";
  if (/£|\d+\s?%|\boff\b|\bsave\b|\bfree\b|\bfrom\b/i.test(firstChunk)) return "leads with an offer or a price hook";
  if (/^[A-Z][^.!?]{0,60}[.!]/.test(firstChunk)) return "opens with a short, bold statement";
  return "opens with a warm, benefit-led line";
}

/** The exact competitor claims/figures the output is forbidden to reuse, as a list. */
export function forbiddenEchoList(sourceAd: RecreateSourceAd): string[] {
  const sourceText = `${sourceAd.title ?? ""} ${sourceAd.bodyText ?? ""} ${sourceAd.ctaText ?? ""}`;
  const items = new Set<string>();
  for (const { raw } of numericSignatures(sourceText)) items.add(raw);
  for (const { re } of CLAIM_PATTERNS) {
    const m = re.exec(sourceText);
    if (m) items.add(m[0]);
  }
  if (sourceAd.pageName) items.add(sourceAd.pageName);
  return [...items];
}

const HOUSE_RULES = [
  "British English. Money in GBP with the £ symbol. Never use an em-dash or en-dash; use commas, full stops or brackets.",
  "Never use NHS vs private framing, and never mention funding, bands or plans.",
  "No patient testimonials, reviews, ratings, star claims, awards or 'as seen in'.",
  "No guarantees, no 'pain free', no before and after or specific-result promises.",
  "No superlatives (best, number one, world class, leading, cheapest).",
  "Do not invent prices, review counts, ratings or patient numbers.",
  "Make clear that treatment is subject to a consultation where relevant.",
].join(" ");

/**
 * The recreate prompt. Gives the model the competitor's structure to LEARN FROM and
 * the competitor's exact claims to NEVER reuse, then asks for an original Vitality ad.
 */
export function buildRecreatePrompt(input: {
  sourceAd: RecreateSourceAd;
  treatment: Treatment;
  practiceName: string;
}): { system: string; user: string } {
  const { sourceAd, treatment, practiceName } = input;
  const forbidden = forbiddenEchoList(sourceAd);

  const system = [
    `You are an expert UK dental marketing copywriter writing a Meta (Facebook and Instagram) ad for ${practiceName}.`,
    "You are shown a competitor's ad ONLY so you can learn its STRUCTURE: its hook shape, how it frames the offer, and its call-to-action type.",
    "You must write a COMPLETELY ORIGINAL ad for Vitality's own service. This is inspired-by-structure, never a copy.",
    "ABSOLUTE RULE: do not reuse any of the competitor's words, sentences, claims, statistics, prices, percentages, brand or clinic name, or any review, rating or ranking. Not one figure from their ad may appear in yours.",
    HOUSE_RULES,
    "Write a headline (under 12 words), primary text (2 to 4 short, warm, benefit-led sentences leading with the patient's real motivation), a one-line description, and a single clear call to action.",
    "Also give a one-line complianceNote naming the specific rule you applied.",
    "Do not use double-quote characters inside any string value (it breaks the JSON); use single quotes if you must quote.",
    'Respond with ONLY a JSON object: {"headline": "...", "primaryText": "...", "description": "...", "cta": "...", "complianceNote": "..."}',
  ].join("\n");

  const user = [
    `Vitality's real service to advertise: ${treatment.name}. ${treatment.summary}`,
    treatment.financeAvailable ? "Finance to spread the cost is available for this treatment." : null,
    `Structure to learn from (do NOT reuse any wording or numbers): the competitor ${deriveHookShape(sourceAd)}, and its call to action type is ${sourceAd.ctaType ?? "a booking prompt"}.`,
    `Competitor copy, shown for structure only, never to reuse: "${(sourceAd.title ? sourceAd.title + ". " : "") + (sourceAd.bodyText ?? "")}".`,
    forbidden.length
      ? `These are the competitor's OWN claims and must NEVER appear in your ad: ${forbidden.join("; ")}.`
      : "The competitor made no specific numeric claims; still write entirely original copy.",
    "Now write Vitality's original ad as JSON.",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  return { system, user };
}

/** The repair user message: the failing reply plus the exact reasons to fix. */
export function buildRepairUser(previousReply: string, failuresText: string): string {
  return [
    "Your previous reply did not pass the compliance and originality checks.",
    "Previous reply:",
    previousReply,
    "",
    "It failed these checks. Rewrite the ad so every one is resolved, keeping it original and compliant:",
    failuresText,
    "",
    'Respond again with ONLY the JSON object {"headline","primaryText","description","cta","complianceNote"}.',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// PARSE + ORCHESTRATE.
// ---------------------------------------------------------------------------

/** Parse a model reply into cleaned copy, or null when it is not usable JSON. */
export function parseRecreatedCopy(reply: string): RecreatedCopy | null {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const copy: RecreatedCopy = {
    headline: cleanCopy(String(parsed.headline ?? "")),
    primaryText: cleanCopy(String(parsed.primaryText ?? "")),
    description: cleanCopy(String(parsed.description ?? "")),
    cta: cleanCopy(String(parsed.cta ?? "")),
    complianceNote: cleanCopy(String(parsed.complianceNote ?? "")),
  };
  if (!copy.headline || !copy.primaryText) return null;
  return copy;
}

/**
 * Generate one compliant, original Vitality ad from a competitor's winning ad, with a
 * single repair pass. Blocks (never fabricates) if it still fails compliance/originality.
 * The model call is injected, so this is fully unit-testable.
 */
export async function recreateAdCopy(input: {
  sourceAd: RecreateSourceAd;
  treatment: Treatment;
  practiceName: string;
  callModel: CallModel;
}): Promise<RecreateCopyResult> {
  const { sourceAd, treatment, practiceName, callModel } = input;
  const { system, user } = buildRecreatePrompt({ sourceAd, treatment, practiceName });

  let parsedAny = false;
  let lastFailures: RecreateFailure[] = [];

  try {
    // Attempt 1.
    const firstReply = await callModel(system, user);
    const first = parseRecreatedCopy(firstReply);
    if (first) {
      parsedAny = true;
      const scan = scanRecreatedCopy(first, sourceAd);
      if (scan.ok) return { ok: true, copy: first, source: "model" };
      lastFailures = scan.failures;
    }

    // Attempt 2: repair once, quoting the failures (or asking for valid JSON).
    const repairUser = first
      ? buildRepairUser(firstReply, describeRecreateFailures(lastFailures))
      : buildRepairUser(firstReply, "- your reply was not valid JSON; return only the JSON object");
    const secondReply = await callModel(system, repairUser);
    const second = parseRecreatedCopy(secondReply);
    if (second) {
      parsedAny = true;
      const scan = scanRecreatedCopy(second, sourceAd);
      if (scan.ok) return { ok: true, copy: second, source: "model-repair" };
      lastFailures = scan.failures;
    }
  } catch {
    // A model / network error is not a compliance verdict.
    return { ok: false, reason: "model_unavailable" };
  }

  // Parsed at least once but never passed the gates: an honest compliance block.
  if (parsedAny) return { ok: false, reason: "compliance", failures: lastFailures };
  // Never got usable copy at all: the model, not compliance, is the problem.
  return { ok: false, reason: "model_unavailable" };
}

// ---------------------------------------------------------------------------
// THE IMAGE PROMPT. Built from OUR original copy + Vitality's brand direction, never
// from the competitor's image. Written to contain zero banned tokens; the route
// scans it once more before it is ever sent to a provider.
// ---------------------------------------------------------------------------

/** Vitality's brand colours, most important first (the platform blues, a placeholder until a real palette is captured). */
export const BRAND_COLOURS = ["#16559a", "#2379ab"];

export function buildBrandImagePrompt(input: {
  treatment: Treatment;
  practiceName: string;
  brandColours?: string[];
  locationsLine?: string | null;
}): string {
  const { treatment, practiceName } = input;
  const colours = (input.brandColours ?? BRAND_COLOURS).join(", ");
  const locations = input.locationsLine ? ` in ${input.locationsLine}` : "";
  return [
    `Create a polished, professional marketing photograph for ${practiceName}, a UK dental practice${locations}.`,
    `Subject: ${treatment.name}.`,
    "Visual direction: a bright, welcoming, contemporary dental studio that feels calm and reassuring, with natural soft light and a clean, uncluttered composition.",
    `Weave the practice brand colours (${colours}) through tasteful accents such as walls, uniforms or props, kept subtle.`,
    "People and honesty: if a person appears, use a generic, friendly model in an ordinary everyday moment. Never present anyone as a named or actual patient, and never imply a personal story. Do not show a comparison of before and after, and avoid implying any specific clinical result.",
    "Keep the frame free of logos, badges, icons, numeric scores and written slogans.",
    "Output: photorealistic, editorial quality, suitable for a paid social ad.",
  ].join("\n");
}
