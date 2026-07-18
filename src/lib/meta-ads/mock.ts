// Meta Ads REFERENCE data: a curated library of illustrative "winning" UK dental
// ads. This is competitor inspiration, explicitly framed as examples, NOT the
// practice's own data. It stands in for the Meta Ad Library API until that is
// connected, and powers the ad-inspiration library and Creative Intelligence.
//
// The practice's own campaigns and account analytics are NOT mocked here: those
// come from the live Meta account once it is connected (see isMetaConnected in
// ./connection), so no fabricated campaign spend or account summary is shipped.

import type { AdLibraryItem } from "./types";

// Ten curated, anonymised "winning" UK dental ads from the (mock) Ad Library.
// Long-running ads (high daysRunning) are almost certainly profitable; the mix
// spans 14 to 140 days, varied treatments, formats and locations. aiAnalysis
// explains why the creative works; complianceFlag warns where the pattern would
// be risky for a UK practice to copy, else null.
export const MOCK_AD_LIBRARY: AdLibraryItem[] = [
  {
    id: "adlib-bright-smile-whitening",
    advertiser: "Bright Smile Dental",
    location: "Manchester",
    treatment: "Teeth whitening",
    format: "reel",
    objective: "Leads",
    headline: "A brighter smile before your big day",
    primaryText:
      "Wedding, holiday or just fancy a confidence boost? Our professional whitening is gentler and more even than shop-bought kits. Book a checkup and we will include whitening. Suitability confirmed at your visit.",
    offer: "Whitening included with a checkup",
    hookType: "Outcome-first (event-led)",
    daysRunning: 96,
    estPerformance: "strong",
    aiAnalysis:
      "It ties whitening to a concrete life event, which gives the viewer a reason to act now rather than later. The bundle (whitening with a checkup) lowers the perceived price barrier while still driving a full appointment. Running for over three months signals it converts reliably.",
    complianceFlag: null,
  },
  {
    id: "adlib-implant-clinic-implants",
    advertiser: "The Implant Clinic",
    location: "Leeds",
    treatment: "Dental implants",
    format: "video",
    objective: "Leads",
    headline: "Eat the foods you love again",
    primaryText:
      "Missing teeth holding you back? Dental implants can restore a natural-feeling bite that lasts. Book a free consultation with a 3D scan and a written plan, and ask about finance. Implants are subject to a clinical assessment.",
    offer: "Free consultation and 3D scan",
    hookType: "Outcome-first (lifestyle)",
    daysRunning: 140,
    estPerformance: "strong",
    aiAnalysis:
      "The hook sells the everyday outcome (eating freely) instead of the surgery, which broadens appeal to a 45 to 75 audience. A free 3D-scan consultation plus finance removes both the information and the cost objection in one line. At 140 days running it is clearly a proven evergreen.",
    complianceFlag: null,
  },
  {
    id: "adlib-smilecare-invisalign",
    advertiser: "SmileCare Studio",
    location: "Bristol",
    treatment: "Invisalign",
    format: "reel",
    objective: "Leads",
    headline: "Straighten up without the metal",
    primaryText:
      "Want straighter teeth that fit around your life? Near-invisible aligners, a free consultation worth £75, and finance to spread the cost. Treatment is subject to a clinical assessment.",
    offer: "Free consultation worth £75, finance available",
    hookType: "Objection-handling (cost and appearance)",
    daysRunning: 73,
    estPerformance: "strong",
    aiAnalysis:
      "It pre-empts the two biggest aligner objections (visible braces and price) directly in the copy, which lifts qualified clicks. Stating the consultation value and finance makes the offer feel concrete and low-risk. The clinical-assessment line keeps it UK-compliant while still selling hard.",
    complianceFlag: null,
  },
  {
    id: "adlib-citydental-newpatient",
    advertiser: "City Dental Practice",
    location: "Birmingham",
    treatment: "New patient exam",
    format: "image",
    objective: "Leads",
    headline: "New patients welcome, same-week slots",
    primaryText:
      "Looking for a new dental home? Friendly team, unhurried visits, and a new patient exam and scan for £49. Same-week appointments available now.",
    offer: "Exam and scan £49",
    hookType: "Specificity and numbers",
    daysRunning: 110,
    estPerformance: "steady",
    aiAnalysis:
      "A clear, honest price and a same-week promise reduce friction for people who have been putting off switching practices. The single image and single offer keep the ad focused and cheap to run. Its long run time suggests a dependable, low cost-per-lead workhorse.",
    complianceFlag: null,
  },
  {
    id: "adlib-perfectsmile-beforeafter",
    advertiser: "Perfect Smile Co",
    location: "London",
    treatment: "Composite bonding",
    format: "carousel",
    objective: "Engagement",
    headline: "Swipe to see the transformation",
    primaryText:
      "See how composite bonding reshaped these smiles in a single visit. Book a consultation to find out what is possible for you.",
    offer: "Free bonding consultation",
    hookType: "Before / after reveal",
    daysRunning: 41,
    estPerformance: "steady",
    aiAnalysis:
      "Before / after carousels earn strong swipe and engagement because the visual change is instantly legible. The 'single visit' line adds a speed benefit that bonding buyers care about. The mechanics work, but the format is the problem for a UK practice.",
    complianceFlag:
      "Before / after imagery is tightly restricted for UK dental ads and Meta restricts it in health ads. Do not copy this format; sell the outcome in words instead.",
  },
  {
    id: "adlib-gentledental-nervous",
    advertiser: "Gentle Dental Care",
    location: "Sheffield",
    treatment: "General dentistry",
    format: "reel",
    objective: "Leads",
    headline: "Nervous patients are our speciality",
    primaryText:
      "Put off the dentist because you are anxious? Our calm, unhurried team takes things at your pace, with plenty of time to talk it through first. Book a gentle first visit.",
    offer: "Relaxed new patient visit",
    hookType: "Objection-handling (anxiety)",
    daysRunning: 88,
    estPerformance: "strong",
    aiAnalysis:
      "Naming dental anxiety speaks directly to a large, underserved audience that most ads ignore. The reassurance-led tone matches the emotion, which lifts both watch time and click quality. It avoids any clinical claim, so it stays comfortably compliant.",
    complianceFlag: null,
  },
  {
    id: "adlib-towncentre-emergency",
    advertiser: "Town Centre Dental",
    location: "Nottingham",
    treatment: "Emergency dental care",
    format: "image",
    objective: "Leads",
    headline: "In pain today? We can see you today",
    primaryText:
      "Toothache or a broken tooth? We hold same-day emergency slots so you can be seen fast and get the pain under control. Assessment £65, treatment confirmed after we examine you.",
    offer: "Same-day appointment, assessment £65",
    hookType: "Problem-first (urgency)",
    daysRunning: 62,
    estPerformance: "strong",
    aiAnalysis:
      "It targets the highest-intent moment there is (active pain) with an instant, proximity-based promise. The stated assessment fee sets honest expectations and filters out price-shock drop-offs. Simple image plus phone CTA keeps cost per high-intent lead low.",
    complianceFlag: null,
  },
  {
    id: "adlib-lakeside-quiz",
    advertiser: "Lakeside Dental",
    location: "Liverpool",
    treatment: "Smile assessment",
    format: "video",
    objective: "Leads",
    headline: "What could your smile look like?",
    primaryText:
      "Not sure where to start? Take our free 60-second smile quiz for a personalised idea of your options. No pressure, no commitment. Any recommendation is confirmed at a consultation.",
    offer: "Free 60-second smile quiz",
    hookType: "Curiosity (quiz lead magnet)",
    daysRunning: 35,
    estPerformance: "steady",
    aiAnalysis:
      "A 60-second quiz is a very low-commitment first step, so it captures undecided browsers who would never book a consultation cold. The personalised-result promise gives a reason to finish, feeding a warm retargeting pool. Quiz funnels also generate cheap, high-volume top-of-funnel leads.",
    complianceFlag: null,
  },
  {
    id: "adlib-reviewstar-testimonial",
    advertiser: "ReviewStar Dental",
    location: "Glasgow",
    treatment: "Cosmetic dentistry",
    format: "video",
    objective: "Engagement",
    headline: "Hear what our patients say",
    primaryText:
      "Real patients share how their new smiles changed their confidence. Watch their stories and book your own consultation today.",
    offer: "Free cosmetic consultation",
    hookType: "Social proof (testimonial)",
    daysRunning: 28,
    estPerformance: "new",
    aiAnalysis:
      "Patient stories build trust fast and tend to hold attention through a video, which is why the format spreads. The emotional confidence angle is well chosen for cosmetic buyers. The trust mechanism is sound, but the execution is not allowed in UK dental ads.",
    complianceFlag:
      "Patient testimonials are prohibited in UK dental advertising. Do not copy this; build trust with factual information about the team and service instead.",
  },
  {
    id: "adlib-meadowview-finance",
    advertiser: "Meadowview Dental",
    location: "Cardiff",
    treatment: "Dental implants",
    format: "carousel",
    objective: "Leads",
    headline: "Implants from a manageable monthly amount",
    primaryText:
      "Replacing missing teeth feels more achievable when you can spread the cost. Start with a free consultation and a clear written plan. Finance is subject to status; implants are subject to a clinical assessment.",
    offer: "Finance available, free consultation",
    hookType: "Finance and accessibility angle",
    daysRunning: 14,
    estPerformance: "new",
    aiAnalysis:
      "Leading with affordability reframes a daunting, high-ticket treatment as approachable, which widens the qualified audience. A carousel lets it show steps and reassurance without overloading one frame. Newer ad, but the finance angle is a consistently strong performer for implants.",
    complianceFlag:
      "If you advertise finance you must include the required finance representative wording and 'subject to status'. Keep any monthly figure genuine and not misleading (CMA).",
  },
];
