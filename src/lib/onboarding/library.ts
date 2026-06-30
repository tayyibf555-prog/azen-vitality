// The catalogue of pre-loaded questions a UK dental practice can include on its
// new-patient onboarding form. The owner picks which of these to switch on (and may
// add their own custom questions); resolveSteps() turns the saved config into the
// OnboardingStep[] the public form renders.
//
// CONTRACT: each `key` is stable. The submit mapper reads answers by key, so a key
// that has shipped must never change — only add new questions. The keys that the
// current default flow uses (and the columns/jsonb the submit route maps them into)
// are preserved exactly, so the default config reproduces today's form.
//
// Tone: warm, plain British English. NO clinical advice, NO NHS/private framing — the
// medical questions are a plain intake the practice reviews, not guidance. The consent
// step and the documents step are handled by the form itself, not listed here.
//
// `defaultEnabled` marks the questions the out-of-the-box flow includes. `requirable`
// says whether the owner may mark a question required (we never let a marketing or
// purely optional intake field be forced).

import type { LibraryQuestion } from "./types";

export const ONBOARDING_LIBRARY: LibraryQuestion[] = [
  // --- Personal -----------------------------------------------------------
  {
    key: "first_name",
    label: "First name",
    type: "text",
    category: "personal",
    defaultEnabled: true,
    requirable: true,
  },
  {
    key: "last_name",
    label: "Last name",
    type: "text",
    category: "personal",
    defaultEnabled: true,
    requirable: true,
  },
  {
    key: "date_of_birth",
    label: "Date of birth",
    type: "date",
    category: "personal",
    defaultEnabled: true,
    requirable: true,
    help: "So we can match you to your records.",
  },

  // --- Contact ------------------------------------------------------------
  {
    key: "phone",
    label: "Mobile number",
    type: "tel",
    category: "contact",
    defaultEnabled: true,
    requirable: true,
  },
  {
    key: "email",
    label: "Email address",
    type: "email",
    category: "contact",
    defaultEnabled: true,
    requirable: true,
  },
  {
    key: "preferred_contact",
    label: "How would you prefer we contact you?",
    type: "select",
    category: "contact",
    defaultEnabled: false,
    requirable: false,
    options: [
      { value: "text", label: "Text message" },
      { value: "email", label: "Email" },
      { value: "phone", label: "Phone call" },
      { value: "any", label: "Any of these is fine" },
    ],
  },
  {
    key: "emergency_contact_name",
    label: "Emergency contact name",
    type: "text",
    category: "contact",
    defaultEnabled: false,
    requirable: false,
    help: "Someone we can reach if we ever need to.",
  },
  {
    key: "emergency_contact_phone",
    label: "Emergency contact number",
    type: "tel",
    category: "contact",
    defaultEnabled: false,
    requirable: false,
  },

  // --- Address ------------------------------------------------------------
  {
    key: "address_line1",
    label: "Address line 1",
    type: "text",
    category: "address",
    defaultEnabled: true,
    requirable: true,
  },
  {
    key: "address_line2",
    label: "Address line 2",
    type: "text",
    category: "address",
    defaultEnabled: false,
    requirable: false,
    help: "Optional.",
  },
  {
    key: "address_city",
    label: "Town or city",
    type: "text",
    category: "address",
    defaultEnabled: false,
    requirable: false,
  },
  {
    key: "address_postcode",
    label: "Postcode",
    type: "text",
    category: "address",
    defaultEnabled: true,
    requirable: true,
  },

  // --- Preferences --------------------------------------------------------
  {
    key: "site",
    label: "Preferred practice",
    type: "select",
    category: "preferences",
    defaultEnabled: true,
    requirable: true,
    options: [
      { value: "site-cc", label: "City Centre" },
      { value: "site-rv", label: "Riverside" },
      { value: "site-ng", label: "Northgate" },
      { value: "any", label: "Any, happy with whichever is nearest" },
    ],
  },
  {
    key: "preferred_times",
    label: "When are appointments easiest for you?",
    type: "select",
    category: "preferences",
    defaultEnabled: false,
    requirable: false,
    options: [
      { value: "weekday_morning", label: "Weekday mornings" },
      { value: "weekday_afternoon", label: "Weekday afternoons" },
      { value: "weekday_evening", label: "Weekday evenings" },
      { value: "weekend", label: "Weekends" },
      { value: "flexible", label: "I'm flexible" },
    ],
  },
  {
    key: "nervous_patient",
    label: "Do you feel nervous about dental visits?",
    type: "yesno",
    category: "preferences",
    defaultEnabled: false,
    requirable: false,
    help: "It helps us make your visit as comfortable as possible.",
  },
  {
    key: "accessibility_needs",
    label: "Any accessibility needs we should plan for?",
    type: "textarea",
    category: "preferences",
    defaultEnabled: false,
    requirable: false,
    help: "For example step-free access or a hearing loop. Leave blank if none.",
  },

  // --- Dental -------------------------------------------------------------
  {
    key: "reason",
    label: "Your main reason for joining",
    type: "textarea",
    category: "dental",
    defaultEnabled: true,
    requirable: true,
    help: "For example a routine check-up, or something specific you'd like to look at.",
  },
  {
    key: "last_visit",
    label: "When did you last see a dentist?",
    type: "select",
    category: "dental",
    defaultEnabled: true,
    requirable: false,
    options: [
      { value: "under_6m", label: "Within the last 6 months" },
      { value: "6_12m", label: "6 to 12 months ago" },
      { value: "1_2y", label: "1 to 2 years ago" },
      { value: "over_2y", label: "More than 2 years ago" },
      { value: "cant_remember", label: "I can't remember" },
    ],
  },
  {
    key: "current_practice",
    label: "Which practice do you currently attend?",
    type: "text",
    category: "dental",
    defaultEnabled: false,
    requirable: false,
    help: "Optional. So we can request your records if you'd like us to.",
  },
  {
    key: "interested_treatments",
    label: "Anything you're interested in exploring?",
    type: "select",
    category: "dental",
    defaultEnabled: false,
    requirable: false,
    options: [
      { value: "checkup", label: "A routine check-up" },
      { value: "hygiene", label: "Hygiene and cleaning" },
      { value: "whitening", label: "Teeth whitening" },
      { value: "invisalign", label: "Invisalign or clear aligners" },
      { value: "implants", label: "Dental implants" },
      { value: "veneers", label: "Veneers" },
      { value: "not_sure", label: "Not sure yet" },
    ],
  },

  // --- Medical ------------------------------------------------------------
  {
    key: "medical_conditions",
    label: "Any medical conditions we should know about?",
    type: "textarea",
    category: "medical",
    defaultEnabled: true,
    requirable: false,
    help: "Optional. A quick note is fine, for example asthma or diabetes.",
  },
  {
    key: "medical_medications",
    label: "Any medication you take regularly?",
    type: "textarea",
    category: "medical",
    defaultEnabled: false,
    requirable: false,
    help: "Optional.",
  },
  {
    key: "medical_allergies",
    label: "Any allergies?",
    type: "textarea",
    category: "medical",
    defaultEnabled: true,
    requirable: false,
    help: "Optional, for example penicillin or latex.",
  },
  {
    key: "gp",
    label: "GP or surgery name",
    type: "text",
    category: "medical",
    defaultEnabled: true,
    requirable: false,
    help: "Optional.",
  },

  // --- Marketing / attribution -------------------------------------------
  {
    key: "concerns",
    label: "Anything else you'd like us to know?",
    type: "textarea",
    category: "marketing",
    defaultEnabled: true,
    requirable: false,
    help: "Any worries, preferences, or questions, we're listening.",
  },
  {
    key: "heard_about",
    label: "How did you hear about us?",
    type: "select",
    category: "marketing",
    defaultEnabled: true,
    requirable: false,
    options: [
      { value: "google", label: "Google" },
      { value: "social", label: "Facebook or Instagram" },
      { value: "referral", label: "A friend or family member" },
      { value: "walk_past", label: "Walked past the practice" },
      { value: "other", label: "Other" },
    ],
  },
  {
    key: "heard_about_detail",
    label: "Anything you'd like to add about how you found us?",
    type: "text",
    category: "marketing",
    defaultEnabled: false,
    requirable: false,
    help: "Optional, for example who referred you.",
  },
  {
    key: "marketing_opt_in",
    label: "Would you like occasional updates and offers from us?",
    type: "yesno",
    category: "marketing",
    defaultEnabled: false,
    requirable: false,
    help: "You can change your mind at any time.",
  },
];

/** Fast lookup of a library question by its key. */
export const ONBOARDING_LIBRARY_BY_KEY: Record<string, LibraryQuestion> =
  Object.fromEntries(ONBOARDING_LIBRARY.map((q) => [q.key, q]));
