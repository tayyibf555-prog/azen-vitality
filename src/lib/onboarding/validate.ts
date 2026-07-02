// Pure validation + normalisation for an onboarding submission.
//
// Takes the raw answers map a public form POSTs and the step definition, and:
//   - keeps ONLY keys that exist in the steps (drops anything unknown / injected),
//   - trims every value,
//   - enforces that required fields are present,
//   - sanity-checks email and phone shape,
//   - for `select` fields, only accepts a value that is one of the declared options.
//
// On success it returns a flat, cleaned answers map keyed by the same field keys
// (the submit route maps those into columns/jsonb). On failure it returns an error
// message. No I/O, no side effects — easy to unit test.

import type { OnboardingField, OnboardingStep } from "./types";

export interface ParseOk {
  ok: true;
  answers: Record<string, string>;
}
export interface ParseErr {
  ok: false;
  error: string;
}
export type ParseResult = ParseOk | ParseErr;

// Plausible-email shape: matches the messaging layer's check so behaviour is
// consistent across the app. Not an RFC validator — just enough to reject obvious junk.
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** Does a trimmed string look like a phone number a person typed? */
function looksLikePhone(s: string): boolean {
  const digits = s.replace(/[^\d]/g, "");
  // 8-15 digits covers UK national (07...) and E.164; allow leading + and spacing.
  return /^\+?[\d\s().-]+$/.test(s) && digits.length >= 8 && digits.length <= 15;
}

function trimStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// Per-type length caps. This is a public, unauthenticated write into jsonb that is
// re-served in full by the worklist and every notifications build, so an unbounded
// answer is a cheap DoS (multi-megabyte strings). Reject over-long values with a
// clear message rather than storing them.
const MAX_LEN: Record<string, number> = {
  text: 200,
  email: 200,
  tel: 40,
  date: 40,
  select: 200,
  yesno: 10,
  consent: 10,
  textarea: 2000,
};

/**
 * Validate + normalise `raw` against `steps`. Pure.
 * @param raw the answers map posted by the form (untrusted).
 * @param steps the form definition to validate against (defaults handled by caller).
 */
export function parseSubmission(raw: unknown, steps: OnboardingStep[]): ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Answers must be an object" };
  }
  const input = raw as Record<string, unknown>;

  // Flatten the known fields once; the steps are the allow-list.
  const fields: OnboardingField[] = steps.flatMap((s) => s.fields);

  const answers: Record<string, string> = {};

  for (const field of fields) {
    const value = trimStr(input[field.key]);

    if (value === "") {
      if (field.required) {
        return { ok: false, error: `${field.label} is required` };
      }
      continue; // optional + empty: drop it.
    }

    // Bound the length before anything else so a giant paste is rejected cheaply.
    const cap = MAX_LEN[field.type] ?? 200;
    if (value.length > cap) {
      return { ok: false, error: `${field.label} is too long (maximum ${cap} characters)` };
    }

    switch (field.type) {
      case "email": {
        if (!EMAIL_RE.test(value.toLowerCase())) {
          return { ok: false, error: `${field.label} does not look like a valid email` };
        }
        answers[field.key] = value.toLowerCase();
        break;
      }
      case "tel": {
        if (!looksLikePhone(value)) {
          return { ok: false, error: `${field.label} does not look like a valid phone number` };
        }
        answers[field.key] = value;
        break;
      }
      case "select": {
        const allowed = (field.options ?? []).map((o) => o.value);
        if (!allowed.includes(value)) {
          return { ok: false, error: `${field.label} has an invalid selection` };
        }
        answers[field.key] = value;
        break;
      }
      case "yesno": {
        if (value !== "yes" && value !== "no") {
          return { ok: false, error: `${field.label} must be yes or no` };
        }
        answers[field.key] = value;
        break;
      }
      case "consent": {
        // Consent fields are a tick: accept a truthy marker, store canonically.
        answers[field.key] = value === "true" || value === "yes" ? "yes" : "no";
        break;
      }
      case "date":
      case "text":
      case "textarea":
      default: {
        answers[field.key] = value;
        break;
      }
    }
  }

  return { ok: true, answers };
}
