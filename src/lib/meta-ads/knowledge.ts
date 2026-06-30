// Meta Ads knowledge base: campaign templates, the launch guide, UK compliance
// rules, and proven creative patterns. PURE DATA, grounded in current (2026) UK
// dental advertising best practice. British English, GBP, no testimonials, no
// NHS-vs-private framing. Consumed by the dashboard's Meta Ads section and, later,
// by the AI agents that draft ad copy.
//
// Compliance baseline baked into every template: all advertising must be legal,
// decent, honest, truthful and not misleading (GDC + ASA / CAP); patient
// testimonials are prohibited in dental advertising; before / after imagery is
// high-risk (tightly restricted by the GDC and further restricted by Meta in
// health ads); ads must make clear treatment is subject to a clinical
// consultation and may not be suitable for everyone; pricing must be transparent
// (CMA); every claim must be substantiable.

import type {
  CampaignTemplate,
  GuideStep,
  ComplianceRule,
  CreativePattern,
} from "./types";

// Six ready-to-launch templates. Headlines are kept under ~12 words. Each
// complianceNote names the specific rule that most applies to that template.
export const CAMPAIGN_TEMPLATES: CampaignTemplate[] = [
  {
    id: "new-patient-special",
    name: "New Patient Special",
    treatment: "New patient exam",
    objective: "leads",
    goal: "Fill new-patient slots with a low-friction first visit offer.",
    audience:
      "Adults within an 8 mile radius of each site (City Centre, Riverside, Northgate), broad targeting with the algorithm optimising for leads. Exclude existing patients. Layer a lookalike of your highest-value patients once the pixel has data.",
    dailyBudgetGbp: { min: 12, max: 20 },
    offer:
      "New patient exam and scan for a clear, stated price, with a same-week appointment.",
    angle:
      "Make switching practice feel easy and welcoming, especially for people who have put off seeing a dentist.",
    formats: ["reel", "image", "carousel"],
    cta: "Book now",
    copy: {
      headline: "New patients welcome at Vitality Dental",
      primaryText:
        "Looking for a new dental home in the area? Our friendly team makes your first visit simple and unhurried. Your new patient exam and scan are just £49, with same-week appointments across our three local sites. Suitability is confirmed at your visit.",
      description: "Exam and scan, £49. Same-week slots.",
    },
    complianceNote:
      "State the £49 price clearly and honestly (CMA transparency). Do not imply a clinical outcome. Avoid patient testimonials in the creative.",
  },
  {
    id: "invisalign",
    name: "Invisalign Clear Aligners",
    treatment: "Invisalign",
    objective: "leads",
    goal: "Generate consultation enquiries for clear aligner treatment.",
    audience:
      "Adults 20 to 45 within a 10 mile radius, broad with the algorithm optimising for leads. Add a household-income qualifier. Build a lookalike from past cosmetic and orthodontic patients.",
    dailyBudgetGbp: { min: 15, max: 30 },
    offer:
      "Free Invisalign consultation (worth £75) with a clear-aligner suitability scan, and finance available to spread the cost.",
    angle:
      "Straighter teeth without metal braces, focused on the confidence of smiling freely rather than clinical detail.",
    formats: ["reel", "video", "image"],
    cta: "Book consultation",
    copy: {
      headline: "Straighten your smile with clear aligners",
      primaryText:
        "Want straighter teeth without obvious braces? Invisalign uses near-invisible aligners that fit around your life. Book a free consultation (worth £75) to see if it suits you, and spread the cost with finance. Treatment is subject to a clinical assessment.",
      description: "Free consultation worth £75. Finance available.",
    },
    complianceNote:
      "Add that treatment is subject to a clinical assessment and may not be suitable for everyone. State the £75 consultation value honestly. No testimonials; treat any before / after as high-risk and avoid.",
  },
  {
    id: "dental-implants",
    name: "Dental Implants",
    treatment: "Dental implants",
    objective: "leads",
    goal: "Generate qualified implant consultation enquiries from higher-intent adults.",
    audience:
      "Adults 45 to 75 within a 12 mile radius, broad with a household-income qualifier for a higher-value treatment. Build a lookalike from previous implant and high-value patients. Exclude recent enquirers to avoid fatigue.",
    dailyBudgetGbp: { min: 18, max: 35 },
    offer:
      "Free implant consultation with a 3D scan and a written treatment plan, finance available to spread the cost.",
    angle:
      "Eat, speak and smile with confidence again, framed around restored everyday life rather than the surgical procedure.",
    formats: ["reel", "video", "carousel"],
    cta: "Book consultation",
    copy: {
      headline: "Replace missing teeth with dental implants",
      primaryText:
        "Missing teeth making eating or smiling harder than it should be? Dental implants are a long-lasting way to restore a natural-feeling bite. Book a free consultation with a 3D scan and a clear written plan, and ask about finance. Implants are subject to a clinical assessment and are not suitable for everyone.",
      description: "Free consultation and 3D scan. Finance options.",
    },
    complianceNote:
      "Implants must clearly state treatment is subject to a clinical assessment and not suitable for everyone. Substantiate any longevity claim. No testimonials; avoid before / after imagery (GDC restricted and Meta restricts before / after in health ads).",
  },
  {
    id: "teeth-whitening",
    name: "Teeth Whitening",
    treatment: "Teeth whitening",
    objective: "leads",
    goal: "Drive low-cost, high-volume whitening enquiries to grow the patient base.",
    audience:
      "Adults 22 to 50 within an 8 mile radius, broad with the algorithm optimising for leads. Retarget engagers and site visitors with a second ad set. Lookalike from past whitening and hygiene patients.",
    dailyBudgetGbp: { min: 10, max: 18 },
    offer:
      "Professional teeth whitening included with a new patient checkup, for a clear, stated price.",
    angle:
      "A brighter, more confident smile for an upcoming event or simply for everyday confidence.",
    formats: ["reel", "image", "carousel"],
    cta: "Book now",
    copy: {
      headline: "A brighter smile, professionally done",
      primaryText:
        "Want a noticeably brighter smile in time for your next big occasion? Our professional whitening is safer and more even than shop-bought kits, and it is included when you book a checkup. Suitability is confirmed at your appointment.",
      description: "Whitening included with a checkup.",
    },
    complianceNote:
      "Only registered dental professionals may legally whiten teeth in the UK; keep claims factual. State the price clearly (CMA). No testimonials; avoid before / after imagery.",
  },
  {
    id: "emergency-same-day",
    name: "Emergency / Same-day Appointments",
    treatment: "Emergency dental care",
    objective: "leads",
    goal: "Capture high-intent, in-pain searchers who need to be seen today.",
    audience:
      "Adults within a 10 mile radius, broad and kept simple so the algorithm reaches people actively in need. No income qualifier; speed and proximity matter most. Run continuously rather than in bursts.",
    dailyBudgetGbp: { min: 10, max: 20 },
    offer:
      "Same-day emergency appointments with fast pain relief and a clear, stated assessment fee.",
    angle:
      "Immediate reassurance and relief for someone in pain, with the simplest possible path to being seen today.",
    formats: ["image", "reel", "video"],
    cta: "Call now",
    copy: {
      headline: "In pain? Same-day dental appointments",
      primaryText:
        "Toothache or a dental emergency? We keep same-day slots across our three local sites so you can be seen quickly and get the pain under control. Your assessment fee is £65, with treatment confirmed after we examine you.",
      description: "Same-day slots. Assessment £65.",
    },
    complianceNote:
      "Be honest about availability; only promise same-day if genuinely offered. State the £65 fee transparently (CMA). Treatment is confirmed after clinical assessment.",
  },
  {
    id: "smile-assessment-quiz",
    name: "Smile Assessment Quiz",
    treatment: "Smile assessment",
    objective: "leads",
    goal: "Use a 60-second smile quiz as a low-friction lead magnet feeding the /assess funnel.",
    audience:
      "Adults 25 to 60 within a 10 mile radius, broad with the algorithm optimising for the quiz completion. Retarget quiz starters who did not finish. Lookalike from past cosmetic enquirers.",
    dailyBudgetGbp: { min: 12, max: 22 },
    offer:
      "A free 60-second smile assessment that suggests the right next step, no commitment.",
    angle:
      "Curiosity and self-discovery: a quick, pressure-free way to find out what could improve your smile.",
    formats: ["reel", "video", "image"],
    cta: "Take the quiz",
    copy: {
      headline: "What could your smile look like?",
      primaryText:
        "Not sure where to start with your smile? Take our free 60-second assessment and get a personalised idea of your options, with no pressure and no commitment. Any recommendation is confirmed at a clinical consultation.",
      description: "Free 60-second smile quiz.",
    },
    complianceNote:
      "Drive to /assess. Make clear the quiz is informational and any recommendation is subject to a clinical consultation. No diagnostic or guaranteed-outcome claims. No testimonials.",
  },
];

// Eight-step launch guide. Bodies are practical paragraphs; tips are concrete.
// UK compliance is woven in where it matters.
export const GUIDE_STEPS: GuideStep[] = [
  {
    n: 1,
    title: "Set up your Meta foundations",
    body: "Before any ad runs, get the plumbing right. Create a Meta Business account, an ad account, and a Facebook Page for the practice, then install the Meta Pixel (and the Conversions API where possible) on your website so Meta can learn from real leads. Without the Pixel, the algorithm is flying blind and your cost per lead will stay high.",
    tips: [
      "Use a Business account, not a personal profile, so billing and access are clean.",
      "Verify the Pixel fires on your booking and quiz-completion pages before spending.",
      "Add the practice's real address and contact details to the Page for trust and local relevance.",
    ],
  },
  {
    n: 2,
    title: "Pick the right objective",
    body: "For most dental campaigns choose the Leads objective with a Meta Instant Form (Lead Ad). The form stays inside Meta, which removes friction and works especially well for cold audiences. Use Reach or Video Views only for top-of-funnel awareness Reels, and Traffic only when you genuinely want people on a specific web page (such as the /assess quiz).",
    tips: [
      "Instant Forms convert cold traffic better than sending people to a website to fill in a form.",
      "Reserve awareness objectives for short vertical videos that warm a local radius.",
      "Match the objective to the money: Leads is the primary money campaign.",
    ],
  },
  {
    n: 3,
    title: "Define the audience",
    body: "Set a geo-radius of 5 to 15 miles (roughly 8 to 24 km) around each of your three sites. Keep targeting broad and let the algorithm optimise rather than stacking lots of interests. For cosmetic and implant treatments, add a household-income qualifier, and skew implants towards ages 45 to 75. Once the Pixel has data, build lookalike audiences from your highest-value existing patients.",
    tips: [
      "Broad plus a good Pixel usually beats narrow interest stacking in 2026.",
      "Exclude existing patients from acquisition campaigns to avoid wasted spend.",
      "Build a separate retargeting ad set for engagers and site visitors.",
    ],
  },
  {
    n: 4,
    title: "Set the budget and structure",
    body: "Start at roughly £40 to £60 per day across the account. On small or test budgets use ABO (set the budget per ad set, around £10 to £15 each) so each test gets a fair share of spend. Once you have a winner, scale with CBO / Advantage+ campaign budgets, which let Meta move money to the best performers. Remember Meta needs around 50 conversions per week per ad set to exit the learning phase.",
    tips: [
      "Test with ABO, scale with CBO / Advantage+.",
      "Expect 20 to 50% higher cost per lead during the learning phase, then it settles.",
      "Raise budgets gradually (around 20% at a time) so you do not reset learning.",
    ],
  },
  {
    n: 5,
    title: "Build the creative",
    body: "Produce a mix of vertical 9:16 Reels, 1:1 feed images, and carousels. Lead with the transformation and the patient's real motivation (confidence, eating, smiling) rather than clinical jargon, and use one clear call to action per ad. Test 3 to 5 variants, pause the losers, and refresh creative regularly to beat fatigue. Avoid before / after imagery: it is tightly restricted for UK dental ads and Meta further restricts it in health ads.",
    tips: [
      "Kill an ad after around 1,000 impressions if it clearly underperforms.",
      "Use proven hooks: problem-first, outcome-first, objection-handling, specificity.",
      "Never use patient testimonials; they are prohibited in UK dental advertising.",
    ],
  },
  {
    n: 6,
    title: "Write the Instant Form",
    body: "Keep the lead form short, ideally under six questions, so completion stays high while still qualifying intent. Ask for name, phone, the treatment of interest, and one qualifying question (such as preferred site or timeframe). Add a short, honest intro line and make clear that any treatment is subject to a clinical consultation.",
    tips: [
      "Fewer fields means more leads, but one qualifying question filters out tyre-kickers.",
      "Pre-fill name and contact from Meta where the user allows it.",
      "State up front that suitability is confirmed at a consultation.",
    ],
  },
  {
    n: 7,
    title: "Connect fast follow-up",
    body: "Speed of response is the single biggest lever on lead quality. Responding within five minutes raises the chance of qualifying a lead dramatically, so wire your Instant Form leads straight into the practice's Speed-to-lead module so the first contact is near-instant rather than hours later. A great ad with slow follow-up wastes the spend.",
    tips: [
      "Route Meta leads into Speed-to-lead so first contact happens within five minutes.",
      "Have a clear, friendly first message ready that books or qualifies.",
      "Track which campaign each lead came from so you can judge real cost per booked patient.",
    ],
  },
  {
    n: 8,
    title: "Read the numbers and iterate",
    body: "Judge campaigns on cost per lead first, then cost per booked patient and a rough return multiple. Watch CTR, CPM, reach and frequency to spot fatigue (rising frequency with falling CTR means it is time to refresh). Give the learning phase time, pause clear losers, and put more budget behind proven winners. A well-run campaign can return roughly 3 to 6 times its spend.",
    tips: [
      "Cost per lead for dental is roughly £25 to £75 (implants higher, whitening lower).",
      "Do not judge a brand-new ad set until it has left the learning phase.",
      "Scale winners, refresh creative, and cut anything still underperforming after a fair test.",
    ],
  },
];

// Six core UK compliance rules. severity drives UI treatment.
export const UK_COMPLIANCE: ComplianceRule[] = [
  {
    title: "Be honest and not misleading",
    detail:
      "All advertising must be legal, decent, honest, truthful and not misleading (GDC plus ASA / CAP). Do not exaggerate results, imply guaranteed outcomes, or create a false sense of scarcity. Misleading dental ads can trigger a GDC fitness-to-practise investigation.",
    severity: "must",
  },
  {
    title: "No patient testimonials",
    detail:
      "Patient testimonials are prohibited in dental advertising in any medium. Do not use patient quotes, reviews, or testimonial-style copy in ads, captions, or video. Build trust through clear, factual information about the team and the service instead.",
    severity: "must",
  },
  {
    title: "Treat before / after as high-risk",
    detail:
      "Before / after photos are tightly restricted: they must be genuine, unretouched, and backed by signed, dated patient consent, and Meta itself restricts before / after imagery in health ads. Treat before / after as high-risk and avoid it in paid creative.",
    severity: "avoid",
  },
  {
    title: "State treatment is subject to assessment",
    detail:
      "Ads for treatments must make clear that the treatment may not be suitable for everyone and is subject to a clinical assessment or consultation. Add a short line to each ad and lead form to that effect, especially for implants, Invisalign and whitening.",
    severity: "must",
  },
  {
    title: "Be transparent about pricing",
    detail:
      "Be clear and transparent about pricing (CMA). If you state a price or an offer value (for example a consultation worth £75), it must be genuine, complete and not hide material conditions. Avoid 'from' prices that mislead.",
    severity: "must",
  },
  {
    title: "Substantiate every claim",
    detail:
      "Any claim about results, longevity, or superiority must be substantiable with evidence before you publish it. If you cannot back it up, do not say it. Keep clinical language factual and avoid absolute promises.",
    severity: "note",
  },
];

// Six winning creative patterns, each with a UK-compliant example line.
export const CREATIVE_PATTERNS: CreativePattern[] = [
  {
    name: "Problem-first hook",
    whatItIs:
      "Open by naming the problem the viewer is living with, so they feel understood in the first second.",
    example: "Struggling to smile in photos because of stained or crooked teeth?",
  },
  {
    name: "Outcome-first hook",
    whatItIs:
      "Lead with the desirable end state and a realistic timeframe, focused on confidence rather than clinical steps.",
    example: "Get a straighter smile with near-invisible aligners, subject to a consultation.",
  },
  {
    name: "Objection-handling",
    whatItIs:
      "Address the biggest reason people hesitate (cost or nerves) right in the hook to disarm it early.",
    example: "Nervous about the dentist? Gentle, unhurried care, with finance to spread the cost.",
  },
  {
    name: "Specificity and numbers",
    whatItIs:
      "Use concrete, honest numbers (price, time, slots) to make the offer feel real and credible.",
    example: "New patient exam and scan for £49, with same-week appointments at three local sites.",
  },
  {
    name: "Single clear offer",
    whatItIs:
      "Make one offer with one call to action, so the ad never splits the viewer's attention.",
    example: "Book your free consultation (worth £75). One tap, one form, one team to call you back.",
  },
  {
    name: "Finance and accessibility angle",
    whatItIs:
      "Reframe a higher-value treatment as affordable and approachable by leading with how the cost is handled.",
    example: "Spread the cost of dental implants with finance, and start with a free 3D-scan consultation.",
  },
];
