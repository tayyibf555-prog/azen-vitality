// Onboarding domain types.
//
// One OnboardingSubmission per completed new-patient onboarding form. The form is
// public and branded, filled in by a new customer at /onboard/<client>. It captures
// contact, address, a brief free-text medical intake (never clinical advice), the
// reason for joining, attribution, optional uploaded documents and consent choices.
//
// Files are stored in the private `onboarding` Storage bucket; a submission only
// holds references ({ path, name, size, type }) — never the bytes, never a URL.

/** A reference to a document uploaded to the private `onboarding` bucket. */
export interface OnboardingFile {
  /** Storage path under onboarding/<clientSlug>/... */
  path: string;
  /** Sanitised display name. */
  name: string;
  /** Size in bytes. */
  size: number;
  /** MIME type (one of the bucket's allowed set). */
  type: string;
}

/** Patient consent choices captured on the final step. */
export interface OnboardingConsent {
  sms: boolean;
  email: boolean;
  marketing: boolean;
  /** Consent to store and process the information they have given us. */
  data: boolean;
}

export interface OnboardingAddress {
  line1?: string;
  line2?: string;
  city?: string;
  postcode?: string;
}

export interface OnboardingMedical {
  conditions?: string;
  medications?: string;
  allergies?: string;
  gp?: string;
}

export interface OnboardingDental {
  reason?: string;
  last_visit?: string;
  concerns?: string;
}

export type OnboardingStatus = "new" | "reviewed" | "registered" | "archived";

/** The full onboarding_submission row, mapped to camelCase. */
export interface OnboardingSubmission {
  id: string;
  clientId: string;
  siteId: string | null;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null; // ISO date string
  phone: string | null;
  email: string | null;
  address: OnboardingAddress | null;
  medical: OnboardingMedical | null;
  dental: OnboardingDental | null;
  heardAbout: string | null;
  files: OnboardingFile[];
  consent: OnboardingConsent | null;
  /** Answers to the practice's own custom questions, keyed by their custom- key. */
  custom: Record<string, string> | null;
  status: OnboardingStatus;
  createdAt: string; // ISO
}

// ---------------------------------------------------------------------------
// Form definition types — drive the public, one-or-two-questions-per-screen UI.
// ---------------------------------------------------------------------------

export type OnboardingFieldType =
  | "text"
  | "email"
  | "tel"
  | "date"
  | "textarea"
  | "select"
  | "yesno"
  | "consent";

export interface OnboardingFieldOption {
  value: string;
  label: string;
}

export interface OnboardingField {
  key: string;
  label: string;
  type: OnboardingFieldType;
  required?: boolean;
  options?: OnboardingFieldOption[];
  placeholder?: string;
  help?: string;
}

export interface OnboardingStep {
  id: string;
  title: string;
  intro?: string;
  /** 1 to 2 fields per step so the public form is one or two questions per screen. */
  fields: OnboardingField[];
}

// ---------------------------------------------------------------------------
// Configurable form — a per-practice library + custom questions, saved as a
// config the PUBLIC form reads. The owner/coordinator picks which pre-loaded
// library questions to include and adds their own, and resolveSteps() turns the
// config into the OnboardingStep[] the form renders.
// ---------------------------------------------------------------------------

/** Where a question sits in the flow. Used to group questions into sensible steps. */
export type OnboardingCategory =
  | "personal"
  | "contact"
  | "address"
  | "medical"
  | "dental"
  | "preferences"
  | "marketing";

/**
 * A pre-loaded question the owner can include in their form. Stable `key` is the
 * contract the submit mapper reads by name, so library keys never change once shipped.
 */
export interface LibraryQuestion {
  /** Stable kebab-case key. The submit mapper reads answers by key, so keep it fixed. */
  key: string;
  label: string;
  /** Reuses the public form's field types so the renderer needs no new cases. */
  type: OnboardingFieldType;
  category: OnboardingCategory;
  /** For select / yesno questions. */
  options?: OnboardingFieldOption[];
  /** True for the questions the default flow includes out of the box. */
  defaultEnabled: boolean;
  /** Whether the owner is allowed to mark this question required. */
  requirable: boolean;
  help?: string;
}

/** A practice's own question, written in the builder. Keys are generated, prefixed custom-. */
export interface CustomQuestion {
  /** Generated, always prefixed `custom-` so it can never collide with a library key. */
  key: string;
  label: string;
  type: OnboardingFieldType;
  /** For select / yesno questions. */
  options?: OnboardingFieldOption[];
  required: boolean;
  category: OnboardingCategory;
}

/**
 * The saved per-practice form configuration. `enabledKeys` are library keys the owner
 * has switched on; `required` overrides a library question's default required flag by
 * key; `custom` are the practice's own questions (which carry their own required flag).
 * A null/empty config means "use the default flow".
 */
export interface OnboardingConfig {
  enabledKeys: string[];
  required: Record<string, boolean>;
  custom: CustomQuestion[];
  updatedAt?: string;
}
