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
