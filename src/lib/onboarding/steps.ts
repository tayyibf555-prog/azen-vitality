// The new-patient onboarding flow: a warm, not-overwhelming sequence of short steps,
// one or two questions per screen, in British English. This is the single source of
// truth for the public form's fields — the validator checks answers against it, and
// the submit endpoint maps the answer keys into the submission's columns + jsonb.
//
// Tone: friendly and welcoming. NO clinical advice. NO NHS/private framing. The medical
// fields are a plain intake the practice will review, not a questionnaire that gives
// guidance. The consent step is handled in the final submit (not a form field here).
//
// Field keys are the contract. Keep them stable; the submit mapper reads them by name:
//   first_name, last_name, date_of_birth, phone, email,
//   address_line1, address_postcode,
//   site, reason, last_visit,
//   medical_conditions, medical_medications, medical_allergies, gp,
//   concerns, heard_about

import type { OnboardingStep } from "./types";

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: "name",
    title: "Welcome — let's start with your name",
    intro: "It only takes a couple of minutes to join us.",
    fields: [
      {
        key: "first_name",
        label: "First name",
        type: "text",
        required: true,
        placeholder: "e.g. Alex",
      },
    ],
  },
  {
    id: "you",
    title: "A little more about you",
    fields: [
      {
        key: "last_name",
        label: "Last name",
        type: "text",
        required: true,
        placeholder: "e.g. Morgan",
      },
      {
        key: "date_of_birth",
        label: "Date of birth",
        type: "date",
        required: true,
        help: "So we can match you to your records.",
      },
    ],
  },
  {
    id: "contact",
    title: "How can we reach you?",
    intro: "We'll use these to confirm appointments and send reminders.",
    fields: [
      {
        key: "phone",
        label: "Mobile number",
        type: "tel",
        required: true,
        placeholder: "07700 900123",
      },
      {
        key: "email",
        label: "Email address",
        type: "email",
        required: true,
        placeholder: "you@example.com",
      },
    ],
  },
  {
    id: "address",
    title: "Where do you live?",
    intro: "Just the basics for our records.",
    fields: [
      {
        key: "address_line1",
        label: "Address line 1",
        type: "text",
        required: true,
        placeholder: "e.g. 12 High Street",
      },
      {
        key: "address_postcode",
        label: "Postcode",
        type: "text",
        required: true,
        placeholder: "e.g. AB1 2CD",
      },
    ],
  },
  {
    id: "site",
    title: "Which practice is most convenient?",
    intro: "Pick the one that suits you best — you can always change later.",
    fields: [
      {
        key: "site",
        label: "Preferred practice",
        type: "select",
        required: true,
        options: [
          { value: "site-cc", label: "City Centre" },
          { value: "site-rv", label: "Riverside" },
          { value: "site-ng", label: "Northgate" },
          { value: "any", label: "Any — happy with whichever is nearest" },
        ],
      },
    ],
  },
  {
    id: "reason",
    title: "What brings you to us?",
    fields: [
      {
        key: "reason",
        label: "Your main reason for joining",
        type: "textarea",
        required: true,
        placeholder: "e.g. A routine check-up, or something specific you'd like to look at.",
      },
      {
        key: "last_visit",
        label: "When did you last see a dentist?",
        type: "select",
        options: [
          { value: "under_6m", label: "Within the last 6 months" },
          { value: "6_12m", label: "6 to 12 months ago" },
          { value: "1_2y", label: "1 to 2 years ago" },
          { value: "over_2y", label: "More than 2 years ago" },
          { value: "cant_remember", label: "I can't remember" },
        ],
      },
    ],
  },
  {
    id: "medical",
    title: "A few things we should know",
    intro:
      "This helps us look after you safely. Leave anything blank if it doesn't apply.",
    fields: [
      {
        key: "medical_conditions",
        label: "Any medical conditions or medication we should know about?",
        type: "textarea",
        placeholder: "e.g. asthma, diabetes, anything you take regularly.",
        help: "Optional. A quick note is fine.",
      },
      {
        key: "medical_allergies",
        label: "Any allergies?",
        type: "textarea",
        placeholder: "e.g. penicillin, latex.",
        help: "Optional.",
      },
    ],
  },
  {
    id: "gp",
    title: "Your doctor (GP)",
    fields: [
      {
        key: "gp",
        label: "GP or surgery name",
        type: "text",
        placeholder: "e.g. Riverside Medical Centre",
        help: "Optional.",
      },
    ],
  },
  {
    id: "extra",
    title: "Anything else?",
    fields: [
      {
        key: "concerns",
        label: "Anything else you'd like us to know?",
        type: "textarea",
        placeholder: "Any worries, preferences, or questions — we're listening.",
        help: "Optional.",
      },
      {
        key: "heard_about",
        label: "How did you hear about us?",
        type: "select",
        options: [
          { value: "google", label: "Google" },
          { value: "social", label: "Facebook or Instagram" },
          { value: "referral", label: "A friend or family member" },
          { value: "walk_past", label: "Walked past the practice" },
          { value: "other", label: "Other" },
        ],
      },
    ],
  },
  {
    id: "documents",
    title: "Any documents to share?",
    intro:
      "Optional. If you have a referral letter, previous records, or insurance details, you can add them here. You can also skip this and bring them along.",
    fields: [],
  },
];

/** Every known field key, derived from the steps. Used by the validator. */
export const ONBOARDING_FIELD_KEYS: string[] = ONBOARDING_STEPS.flatMap((s) =>
  s.fields.map((f) => f.key),
);
