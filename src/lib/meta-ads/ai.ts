import { UK_COMPLIANCE } from "./knowledge";
import type { AdLibraryItem } from "./types";

// Prompt builders for the Meta Ads AI features. Kept pure (no network) so the
// routes stay thin and the prompts are testable. Both bake in the UK advertising
// rules so generated copy and analysis are compliant by construction.

/** Strip dash characters and tidy whitespace (house style: no em/en-dash). */
export function cleanCopy(s: string): string {
  return s.replace(/[—–]/g, ", ").replace(/[ \t]+\n/g, "\n").trim();
}

const COMPLIANCE_LINES = UK_COMPLIANCE.map((r) => `- ${r.title}: ${r.detail}`).join("\n");

const HOUSE_RULES = [
  "British English. Money in GBP with the £ symbol. Never use an em-dash or en-dash; use commas, full stops or brackets.",
  "Never use NHS vs private framing.",
  "This is for a single UK dental practice, Vitality Dental.",
].join(" ");

/** System + user prompt for generating one compliant ad's copy. */
export function buildCopyPrompt(input: {
  treatment: string;
  offer?: string;
  angle?: string;
  practiceName: string;
}): { system: string; user: string } {
  const system = [
    `You are an expert UK dental marketing copywriter writing Meta (Facebook and Instagram) ad copy for ${input.practiceName}.`,
    "The copy MUST comply with UK advertising rules for dentists (GDC and ASA/CAP):",
    COMPLIANCE_LINES,
    "So: no patient testimonials, no before/after claims, no unsubstantiated or absolute claims, and make clear treatment is subject to a consultation where relevant.",
    HOUSE_RULES,
    "Write a headline (under 12 words), primary text (2 to 4 short sentences, warm and benefit-led, leading with the patient's real motivation not clinical jargon), a one-line description, and a single clear call to action.",
    "Also give a one-line complianceNote naming the specific rule you applied (for example: state the treatment is subject to a consultation).",
    "Do not use double-quote characters inside any string value (it breaks the JSON); use single quotes if you must quote.",
    'Respond with ONLY a JSON object: {"headline": "...", "primaryText": "...", "description": "...", "cta": "...", "complianceNote": "..."}',
  ].join("\n");

  const user = [
    `Treatment / focus: ${input.treatment}`,
    input.offer ? `Offer to feature: ${input.offer}` : "Offer: choose a sensible, compliant entry offer (for example a consultation).",
    input.angle ? `Angle / tone: ${input.angle}` : "Angle: choose the most persuasive compliant angle.",
  ].join("\n");

  return { system, user };
}

/** System + user prompt for the AI overview of the winning-ads library. */
export function buildOverviewPrompt(items: AdLibraryItem[], practiceName: string): { system: string; user: string } {
  const system = [
    `You are a senior UK dental marketing strategist briefing the owner of ${practiceName}.`,
    "You are given a library of winning dental ads (from the Meta Ad Library). Analyse them and brief the owner on what is working and how to apply it, compliantly.",
    "Honour UK rules: no patient testimonials, before/after imagery is high risk for health ads, claims must be honest and substantiated, treatment is subject to a consultation.",
    HOUSE_RULES,
    "Be specific and practical, like a sharp strategist, not generic. Keep each insight and item to one or two sentences.",
    "Do not use double-quote characters inside any string value (it breaks the JSON); use single quotes if you must quote.",
    'Respond with ONLY a JSON object: {"patterns": [{"title": "...", "insight": "..."}], "whatToTry": ["..."], "cautions": ["..."]}. Give 3 to 5 patterns, 3 to 5 whatToTry items, and 2 to 4 cautions.',
  ].join("\n");

  const lines = items
    .map(
      (a) =>
        `- ${a.treatment} | ${a.format} | hook: ${a.hookType} | offer: ${a.offer} | running ${a.daysRunning} days (${a.estPerformance}) | headline: "${a.headline}"`,
    )
    .join("\n");
  const user = `Winning ads (${items.length}):\n${lines}`;

  return { system, user };
}
