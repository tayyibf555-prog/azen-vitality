// resolveSteps: turn a saved per-practice OnboardingConfig into the OnboardingStep[]
// the public form renders. Pure (no I/O) so it is trivially testable and can run on
// the server page and in the submit route to produce the SAME allow-list of fields.
//
// The contract the form depends on:
//   - one or two fields per step (one or two questions per screen),
//   - a final documents step (id "documents", no fields) which the form renders as the
//     optional upload screen,
//   - consent is NOT a field here — the form shows it as a synthetic screen after the
//     last step (see onboarding-form.tsx). resolveSteps never emits a consent field.
//
// A null/empty config reproduces today's default flow: the library questions whose
// defaultEnabled is true, in library order, grouped by category into short steps. A
// non-empty config takes the enabled library questions plus the custom questions,
// applies the required overrides, and groups them the same way.

import { ONBOARDING_LIBRARY, ONBOARDING_LIBRARY_BY_KEY } from "./library";
import type {
  CustomQuestion,
  LibraryQuestion,
  OnboardingCategory,
  OnboardingConfig,
  OnboardingField,
  OnboardingStep,
} from "./types";

/** The synthetic documents step the form renders as the optional upload screen. */
export const DOCUMENTS_STEP: OnboardingStep = {
  id: "documents",
  title: "Any documents to share?",
  intro:
    "Optional. If you have a referral letter, previous records, or insurance details, you can add them here. You can also skip this and bring them along.",
  fields: [],
};

/** Stable order the categories appear in, so steps read in a natural sequence. */
const CATEGORY_ORDER: OnboardingCategory[] = [
  "personal",
  "contact",
  "address",
  "preferences",
  "dental",
  "medical",
  "marketing",
];

/** A friendly step heading per category. Kept generic so it suits any practice. */
const CATEGORY_TITLE: Record<OnboardingCategory, string> = {
  personal: "A little about you",
  contact: "How can we reach you?",
  address: "Where do you live?",
  preferences: "Your preferences",
  dental: "Your dental history",
  medical: "A few things we should know",
  marketing: "Nearly there",
};

/** Optional sub-copy per category, only shown on the first step of that group. */
const CATEGORY_INTRO: Partial<Record<OnboardingCategory, string>> = {
  contact: "We'll use these to confirm appointments and send reminders.",
  medical:
    "This helps us look after you safely. Leave anything blank if it doesn't apply.",
};

/** Placeholder text for the few default fields that had one in the original flow. */
const PLACEHOLDER_BY_KEY: Record<string, string> = {
  first_name: "e.g. Alex",
  last_name: "e.g. Morgan",
  phone: "07700 900123",
  email: "you@example.com",
  address_line1: "e.g. 12 High Street",
  address_postcode: "e.g. AB1 2CD",
};

interface ResolvedField {
  field: OnboardingField;
  category: OnboardingCategory;
}

/**
 * Which default-enabled library questions are required in today's flow. Mirrors the
 * original ONBOARDING_STEPS: identity + contact + address line1/postcode + site +
 * reason are required; everything else (last visit, medical, gp, concerns, heard) is
 * optional. Used as the fallback when a config gives no explicit required override.
 */
const DEFAULT_REQUIRED_KEYS = new Set<string>([
  "first_name",
  "last_name",
  "date_of_birth",
  "phone",
  "email",
  "address_line1",
  "address_postcode",
  "site",
  "reason",
]);

export interface ResolveOptions {
  /**
   * The client's real sites, as select options. When provided, they REPLACE the
   * `site` library question's hardcoded (Vitality-mock) options so the form offers
   * this practice's actual sites — and the submit-route validator (which resolves
   * the same steps) rejects a site value that is not one of them, instead of the
   * mock ids passing for the wrong tenant.
   */
  siteOptions?: { value: string; label: string }[];
}

/** Build a renderable field from a library question, applying the required override. */
function fieldFromLibrary(
  q: LibraryQuestion,
  required: Record<string, boolean>,
  opts?: ResolveOptions,
): OnboardingField {
  // A question that can't be required is never required, whatever the config says.
  // Otherwise an explicit override wins; with no override we fall back to today's default.
  const isRequired = !q.requirable
    ? false
    : q.key in required
      ? Boolean(required[q.key])
      : DEFAULT_REQUIRED_KEYS.has(q.key);
  // The `site` question's options are per-client: use the caller's real sites when
  // given, keeping the "any" fallback so a patient can still defer the choice.
  const options =
    q.key === "site" && opts?.siteOptions && opts.siteOptions.length > 0
      ? [...opts.siteOptions, { value: "any", label: "Any, happy with whichever is nearest" }]
      : q.options;
  return {
    key: q.key,
    label: q.label,
    type: q.type,
    required: isRequired,
    options,
    placeholder: PLACEHOLDER_BY_KEY[q.key],
    help: q.help,
  };
}

/** Build a renderable field from a custom question (carries its own required flag). */
function fieldFromCustom(q: CustomQuestion): OnboardingField {
  return {
    key: q.key,
    label: q.label,
    type: q.type,
    required: q.required,
    options: q.options,
  };
}

/**
 * Chunk an ordered list of fields into steps of one or two fields, never crossing a
 * category boundary, and tag the first step of each category with its title/intro.
 */
function groupIntoSteps(items: ResolvedField[]): OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  let i = 0;
  // Track, per category, whether we've already emitted its first (titled) step so the
  // intro and the nicer heading only appear once.
  const seenCategory = new Set<OnboardingCategory>();

  while (i < items.length) {
    const cat = items[i].category;
    // Take up to two consecutive fields that share this category.
    const chunk: ResolvedField[] = [items[i]];
    if (i + 1 < items.length && items[i + 1].category === cat) {
      chunk.push(items[i + 1]);
      i += 2;
    } else {
      i += 1;
    }

    const first = !seenCategory.has(cat);
    seenCategory.add(cat);
    const stepIndex = steps.length;
    steps.push({
      id: `${cat}-${stepIndex}`,
      title: CATEGORY_TITLE[cat],
      // Intro only on the first step of a category, so it isn't repeated.
      intro: first ? CATEGORY_INTRO[cat] : undefined,
      fields: chunk.map((c) => c.field),
    });
  }
  return steps;
}

/**
 * Resolve a config into the form's steps. Pure.
 * @param config the saved per-practice config, or null for the default flow.
 */
export function resolveSteps(config: OnboardingConfig | null, opts?: ResolveOptions): OnboardingStep[] {
  const required = config?.required ?? {};

  // Decide which library questions are in play: the enabled set if a config exists,
  // otherwise the default-enabled catalogue.
  const enabledKeys =
    config && config.enabledKeys.length > 0
      ? config.enabledKeys.filter((k) => k in ONBOARDING_LIBRARY_BY_KEY)
      : ONBOARDING_LIBRARY.filter((q) => q.defaultEnabled).map((q) => q.key);
  const enabledSet = new Set(enabledKeys);

  // Library questions in stable library order (which is already grouped by category).
  const libraryItems: ResolvedField[] = ONBOARDING_LIBRARY.filter((q) =>
    enabledSet.has(q.key),
  ).map((q) => ({ field: fieldFromLibrary(q, required, opts), category: q.category }));

  // Custom questions, in the order the owner added them, after the library questions
  // of the same category so they read together.
  const customItems: ResolvedField[] = (config?.custom ?? []).map((q) => ({
    field: fieldFromCustom(q),
    category: q.category,
  }));

  // Order everything by category, keeping each source's internal order stable.
  const ordered: ResolvedField[] = [];
  for (const cat of CATEGORY_ORDER) {
    for (const it of libraryItems) if (it.category === cat) ordered.push(it);
    for (const it of customItems) if (it.category === cat) ordered.push(it);
  }
  // Any category not in CATEGORY_ORDER (defensive) falls through at the end.
  for (const it of [...libraryItems, ...customItems]) {
    if (!CATEGORY_ORDER.includes(it.category)) ordered.push(it);
  }

  const steps = groupIntoSteps(ordered);
  steps.push(DOCUMENTS_STEP);
  return steps;
}

/**
 * The active (non-documents) field keys for a config — the allow-list the validator
 * uses. The submit route validates against the resolved steps directly, but this is a
 * handy helper for callers that only need the key set.
 */
export function activeFieldKeys(config: OnboardingConfig | null): string[] {
  return resolveSteps(config).flatMap((s) => s.fields.map((f) => f.key));
}
