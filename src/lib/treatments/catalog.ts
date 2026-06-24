// Canonical, lightweight treatments + pricing + USP source of truth.
//
// This is the single place patient-facing pricing and selling points live, so
// every agent says the same thing (the [PILOT] "Pricing & USPs" source). It is
// NON-CLINICAL by design: what a treatment is, a "from" price, finance, and a
// selling point. No clinical suitability, no medical advice. Anything clinical
// (is it right for me, will it hurt, etc.) must be escalated to a human.
//
// Money is in GBP. No em-dashes in any patient-facing copy.

export interface Treatment {
  key: string;
  name: string;
  /** Other ways a patient might refer to it, lower-cased matching. */
  aliases: string[];
  /** Plain, non-clinical description of what it is and what to expect logistically. */
  summary: string;
  /** Indicative starting price in GBP. A coordinator confirms the exact price per case. */
  priceFrom: number;
  /** Whether 0 percent or spread payment finance is offered for this treatment. */
  financeAvailable: boolean;
  /** A short, honest selling point. */
  usp: string;
  /** Indicative number of visits. */
  typicalVisits: string;
  /** Appointment length used when checking diary availability for this treatment. */
  durationMinutes: number;
}

export const TREATMENTS: Treatment[] = [
  {
    key: "checkup",
    name: "Checkup",
    aliases: ["check up", "check-up", "exam", "examination", "dental checkup", "routine checkup"],
    summary: "A routine dental examination with the dentist to check your teeth and gums and catch anything early.",
    priceFrom: 60,
    financeAvailable: false,
    usp: "Same week appointments are usually available.",
    typicalVisits: "1 visit",
    durationMinutes: 30,
  },
  {
    key: "hygiene",
    name: "Hygiene visit",
    aliases: ["hygiene", "hygienist", "scale and polish", "scale & polish", "cleaning", "clean"],
    summary: "A professional clean with the hygienist, a scale and polish to remove build up and keep your gums healthy.",
    priceFrom: 75,
    financeAvailable: false,
    usp: "Leaves your teeth feeling fresh and helps prevent gum problems.",
    typicalVisits: "1 visit",
    durationMinutes: 30,
  },
  {
    key: "invisalign",
    name: "Invisalign",
    aliases: ["invisalign", "clear aligners", "aligners", "teeth straightening", "straighten", "braces"],
    summary: "Clear, removable aligners that gradually straighten your teeth. Most people barely notice you are wearing them.",
    priceFrom: 2500,
    financeAvailable: true,
    usp: "0 percent finance available to spread the cost, and a free initial consultation.",
    typicalVisits: "a consultation, then check ins every few weeks",
    durationMinutes: 30,
  },
  {
    key: "implant",
    name: "Dental implant",
    aliases: ["implant", "implants", "dental implant", "tooth implant", "implant and crown"],
    summary: "A long lasting way to replace a missing tooth, a small fixture that supports a natural looking crown.",
    priceFrom: 2400,
    financeAvailable: true,
    usp: "A permanent, natural looking replacement, with finance available.",
    typicalVisits: "a consultation, then placement and fitting over a few visits",
    durationMinutes: 60,
  },
  {
    key: "veneers",
    name: "Veneers",
    aliases: ["veneer", "veneers", "porcelain veneers", "smile makeover"],
    summary: "Thin covers bonded to the front of your teeth to improve their shape, colour and overall look.",
    priceFrom: 450,
    financeAvailable: true,
    usp: "A popular way to transform a smile, with finance to spread the cost.",
    typicalVisits: "a consultation, then usually 2 visits",
    durationMinutes: 60,
  },
  {
    key: "whitening",
    name: "Teeth whitening",
    aliases: ["whitening", "teeth whitening", "whiten", "bleaching"],
    summary: "A safe way to brighten your smile, with a home kit, an in chair treatment, or both.",
    priceFrom: 350,
    financeAvailable: true,
    usp: "A noticeable lift to your smile, often in a single visit.",
    typicalVisits: "1 to 2 visits",
    durationMinutes: 60,
  },
  {
    key: "bonding",
    name: "Composite bonding",
    aliases: ["bonding", "composite bonding", "composite", "tooth bonding"],
    summary: "Tooth coloured material shaped onto your teeth to fix chips, gaps or small imperfections.",
    priceFrom: 180,
    financeAvailable: true,
    usp: "A quick, minimal way to tidy up your smile, usually in one visit.",
    typicalVisits: "usually 1 visit",
    durationMinutes: 45,
  },
  {
    key: "root_canal",
    name: "Root canal",
    aliases: ["root canal", "rct", "root canal treatment", "root filling"],
    summary: "Treatment to save a tooth that is badly decayed or infected, so it can stay in place rather than be removed.",
    priceFrom: 350,
    financeAvailable: false,
    usp: "Helps you keep your natural tooth.",
    typicalVisits: "1 to 2 visits",
    durationMinutes: 60,
  },
];

/**
 * Match a free-text treatment query to a catalogue entry. Tolerant of natural
 * phrasing ("how much is invisalign", "scale and polish") but deliberately does
 * NOT match when a catalogue term merely contains the query: that mis-routed
 * partial/unknown words (e.g. "clear" -> "clear aligners"). We only match when
 * the query equals a term or contains a known term, so an unknown treatment
 * returns null and the agent can ask to clarify or escalate.
 */
export function findTreatment(query: string): Treatment | null {
  const q = query.trim().toLowerCase();
  if (q.length < 3) return null;
  let best: Treatment | null = null;
  let bestLen = 0;
  for (const t of TREATMENTS) {
    const needles = [t.key, t.name.toLowerCase(), ...t.aliases.map((a) => a.toLowerCase())];
    for (const n of needles) {
      if ((q === n || q.includes(n)) && n.length > bestLen) {
        best = t;
        bestLen = n.length;
      }
    }
  }
  return best;
}
