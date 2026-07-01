import type { CustomQuestion, OnboardingConfig } from "./types";

// Domain model + slug helpers for owner-created onboarding FORMS (the multi-form,
// per-URL onboarding, mirroring the Smile Assessment campaign model). Pure, no I/O,
// so it is safe to import from anywhere (server or client). The server-only CRUD lives
// in form-repository.ts.

export type OnboardingFormStatus = "active" | "paused";

/** A named onboarding form: a shareable /onboard/<client>/<slug> link with its own config. */
export interface OnboardingForm {
  id: string;
  clientId: string;
  siteId: string;
  slug: string;
  name: string;
  headline: string | null;
  intro: string | null;
  config: OnboardingConfig;
  status: OnboardingFormStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The only fields the public landing page needs; never exposes internal metadata. */
export interface PublicOnboardingForm {
  slug: string;
  name: string;
  headline: string | null;
  intro: string | null;
}

export function toPublicForm(form: OnboardingForm): PublicOnboardingForm {
  return { slug: form.slug, name: form.name, headline: form.headline, intro: form.intro };
}

// ---------------------------------------------------------------------------
// Slug: the URL-safe form identifier (the bit after /onboard/<client>/).
// ---------------------------------------------------------------------------

const SLUG_MAX = 60;
// Slugs we never let an owner take, because they would shadow the default onboarding
// flow or a future static child route under /onboard/<client>/.
const RESERVED_SLUGS = new Set(["", "api", "onboard", "new", "edit", "admin"]);

/**
 * Normalise an owner-supplied name (or slug) into a safe URL slug: lowercase,
 * spaces/underscores -> dashes, strip anything but [a-z0-9-], collapse repeats, trim
 * dashes, cap length. Returns "" if nothing usable remains (the caller rejects).
 */
export function slugify(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, ""); // re-trim if the slice landed on a dash
}

/** A slug is valid if it normalises to itself and is not reserved. */
export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && !RESERVED_SLUGS.has(slug) && slugify(slug) === slug;
}

// ---------------------------------------------------------------------------
// Config: coerce a stored jsonb blob into a valid OnboardingConfig so resolveSteps
// (which reads config.enabledKeys.length) can never crash on a partial/empty row.
// ---------------------------------------------------------------------------

export function normaliseFormConfig(raw: unknown): OnboardingConfig {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const enabledKeys = Array.isArray(obj.enabledKeys)
    ? obj.enabledKeys.filter((k): k is string => typeof k === "string")
    : [];
  const required: Record<string, boolean> = {};
  if (obj.required && typeof obj.required === "object") {
    for (const [k, v] of Object.entries(obj.required as Record<string, unknown>)) {
      if (v === true) required[k] = true;
    }
  }
  const custom = Array.isArray(obj.custom)
    ? (obj.custom.filter((c) => !!c && typeof c === "object") as CustomQuestion[])
    : [];
  return { enabledKeys, required, custom };
}

/** The empty-but-valid config, used to seed a new form when a client has no default. */
export const EMPTY_FORM_CONFIG: OnboardingConfig = { enabledKeys: [], required: {}, custom: [] };
