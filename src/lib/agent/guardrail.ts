// Deterministic OUTPUT guardrail for the conversational agent.
//
// The no-clinical-advice / no-unverified-price / no-NHS-or-private-or-funding
// rules live in the system prompt (prompt.ts), but a prompt is a soft control:
// a jailbreak, a model slip, or an owner USP could still produce a reply that
// says "on the NHS" or gives a clinical opinion. This is a hard, code-level
// backstop that scans the model's final replyText BEFORE it is sent and, on any
// hit, refuses to send the model text at all. The caller then hands the
// conversation to a human with a safe fallback.
//
// Conservative by design: British English, no em-dash. We would rather escalate
// a borderline-safe reply to a human than let a genuine violation reach a
// patient, so patterns err towards catching the wording the rules forbid.

/** The safe handover text sent in place of a blocked model reply. */
export const SAFE_HANDOVER =
  "Let me get a member of the team to help with that, they will be in touch shortly.";

export type GuardrailCategory = "funding" | "clinical" | "price";

export interface GuardrailResult {
  /** True when the reply is safe to send as-is. */
  ok: boolean;
  /** Which rule tripped (first match), when not ok. */
  category?: GuardrailCategory;
  /** The offending phrase, for logging. */
  matched?: string;
}

// --- Funding / category jargon: never patient-facing. -----------------------
// Matches the internal labels the prompt forbids: NHS, private (as a funding
// category, not "private message"), and explicit funding wording. Word
// boundaries keep "NHS" from matching inside another token, and the "private"
// forms are scoped to funding-ish usage.
const FUNDING_PATTERNS: RegExp[] = [
  /\bnhs\b/i,
  /\bprivate (?:patient|treatment|price|fee|list|care|dentist|dentistry|band|cover|option)\b/i,
  /\b(?:on|go|going|as) (?:a )?private\b/i,
  /\bprivately\b/i,
  /\bfunding (?:type|category|band|option)\b/i,
  /\bband [123]\b/i, // NHS charge bands
];

// --- Clinical advice: never give an opinion on suitability / diagnosis. -----
// Catches direct clinical opinions ("you need a filling", "this is safe for
// you", diagnosis language) while leaving neutral logistics untouched. The
// "you need ..." rule is scoped to CLINICAL things, so routine logistics
// ("you need to bring your ID", "you need a reference number") are NOT blocked.
const CLINICAL_OBJECT =
  "(?:filling|fillings|crown|crowns|bridge|bridges|root ?canal|extraction|extractions|" +
  "implant|implants|denture|dentures|veneer|veneers|brace|braces|aligner|aligners|" +
  "whitening|scale and polish|deep clean|treatment|treatments|procedure|procedures|" +
  "surgery|operation|tooth (?:out|removed|extracted|taken out)|teeth (?:out|removed)|" +
  "nerve treatment|antibiotics|filling replaced)";
const CLINICAL_PATTERNS: RegExp[] = [
  new RegExp(
    String.raw`\byou (?:definitely |probably |likely |certainly |really )?need (?:a |an |some |your |the )?` +
      CLINICAL_OBJECT + String.raw`\b`,
    "i",
  ),
  new RegExp(
    String.raw`\byou (?:should|must|will need to) (?:get|have|book|arrange|go for) (?:a |an |some |your |the )?` +
      CLINICAL_OBJECT + String.raw`\b`,
    "i",
  ),
  /\b(?:completely |perfectly |totally |quite )?safe for you\b/i,
  /\b(?:it is|it's|that is|that's|this is|you are|you're|it would be) (?:completely |perfectly |totally |quite )?safe\b/i,
  /\b(?:is|are) (?:clinically |medically )?(?:safe|suitable|fine|okay|ok) for you\b/i,
  /\bclinically\b/i,
  /\byou (?:have|are suffering from|are experiencing) (?:an? )?(?:infection|abscess|decay|cavity|gum disease)\b/i,
  /\b(?:take|use|try) (?:some |a |an )?(?:ibuprofen|paracetamol|antibiotics|amoxicillin|painkillers)\b/i,
  /\bi (?:would |'d )?recommend (?:you )?(?:get|have|a|an)\b/i,
  /\b(?:diagnos|prescrib)/i,
];

// --- Unverifiable / invented price: only a hedged "from" price is allowed. ---
// A concrete, unhedged GBP figure presented as the price is blocked. The safe
// path (a "from" price plus "a coordinator confirms the exact price") is left
// alone: those hedged forms are whitelisted before the figure check.
const PRICE_FIGURE = /£\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/;
const PRICE_SAFE_HEDGES: RegExp[] = [
  /\bfrom\s+£/i,
  /\bstart(?:s|ing)?\s+(?:from|at)\b/i,
  /\ba coordinator (?:will )?confirm/i,
  /\bconfirm(?:s|ed)? the exact price/i,
];
// Wording that asserts a firm, exact price (the thing we must not invent).
const PRICE_FIRM: RegExp[] = [
  /\b(?:the price is|it (?:is|'s)|that (?:is|'s)|costs?|total (?:is|of)|exactly|it will be|that will be|comes to)\s*£/i,
  /£\s?\d[\d,]*(?:\.\d{2})?\s*(?:exactly|in total|all in|flat)\b/i,
];

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/**
 * Scan an agent reply for a guardrail violation. Returns { ok: true } when the
 * reply is safe to send, otherwise the tripped category and matched phrase.
 *
 * `includePrice` (default true) also blocks a firm invented price. The
 * conversational agent must never quote an unverifiable price, so it keeps the
 * default. Module drafts (coordinator, recall) legitimately relay a real
 * treatment-plan figure from Dentally, so the shared-drain backstop calls this
 * with includePrice=false and only enforces the two hard, universal rules:
 * never funding/NHS/private jargon and never clinical advice to a patient.
 */
export function checkAgentReply(
  reply: string,
  opts: { includePrice?: boolean } = {},
): GuardrailResult {
  const includePrice = opts.includePrice ?? true;
  const text = reply ?? "";
  if (!text.trim()) return { ok: true };

  const funding = firstMatch(text, FUNDING_PATTERNS);
  if (funding) return { ok: false, category: "funding", matched: funding };

  const clinical = firstMatch(text, CLINICAL_PATTERNS);
  if (clinical) return { ok: false, category: "clinical", matched: clinical };

  // Price: only block a firm/exact figure. A hedged "from" price is allowed.
  if (includePrice && PRICE_FIGURE.test(text)) {
    const hedged = PRICE_SAFE_HEDGES.some((re) => re.test(text));
    const firm = firstMatch(text, PRICE_FIRM);
    if (firm && !hedged) return { ok: false, category: "price", matched: firm };
  }

  return { ok: true };
}
