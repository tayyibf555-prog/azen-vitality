# Quiz Funnels: Research + Recommendations for the Vitality Smile Assessment

Researched 11 July 2026 (Opus 4.8 deep-research pass): quiz-funnel fundamentals, the
Perspective (perspective.co) funnel anatomy, and a gap analysis of our live Smile
Assessment against both.

**Evidence-quality note:** almost every headline "quiz beats form" number comes from
vendors selling quiz software (Interact, Outgrow, Formstack, Venture Harbour,
Perspective). The *direction* is corroborated across many independent vendors and is
credible; treat *absolute* figures as optimistic ceilings. The genuinely
research-grounded numbers are the mobile ergonomics (Apple HIG, Google Material, WCAG).

---

## PART 1 — What measurably works in quiz funnels

### Structure

- **Question count: 5–7 is the consensus sweet spot** for a lead-gen quiz; 6–10 outer
  band; break anything past ~10 into parts (quiz fatigue). Our ~4–6 adaptive questions
  sit right in the zone. (landerlab, leadshook)
- **One question per screen** is the recommended default: lower per-step cognitive load,
  compounding micro-commitments. (automizy)
- **Contact-details gate belongs at the END — after the last question, immediately
  before the result reveal.** The single most consistent finding. A pre-quiz email gate
  "feels like a toll"; a gate at peak curiosity "feels like a fair trade." Post-quiz
  placement is cited as converting **3–5× higher** than upfront, and raises lead
  quality. Never gate before ~question 3. (heyflow, involve.me, woobox)
- **Progress indicators reduce abandonment** — but only when credible (tension with
  adaptive question counts; see Part 3).
- **Back buttons** are table stakes.
- **Answer style:** icon/image options out-engage plain text for visual/aesthetic
  decisions; images add weight. Use visuals where they aid the decision, light elsewhere.
- **Branching/personalisation** is the highest-leverage structural feature. A genuinely
  adaptive next-question engine (ours) is ahead of what most tools fake.
- **Time-to-complete:** first 3 questions answerable in under 10 seconds; ~60 seconds
  total before any sensitive ask (Perspective academy).

### Psychology

- **Micro-commitment / consistency** (Cialdini): each tap is a small "yes".
- **Sunk-cost of progress:** by the last question, abandoning feels like a loss.
- **Self-segmentation:** declaring their own goal makes the recommendation feel personal.
- **Results-teaser / curiosity gap:** promise the outcome, withhold it until the contact
  step — the engine that makes the end-gate convert.
- **Loss aversion in copy:** frame around what they'd miss, not "submit".
- **Social proof near the ask** — but UK dental: patient testimonials are banned (GDC).

### Benchmarks (flagged)

- ~65% completion, 40.1% start-to-lead across 100M+ leads (Interact platform data;
  vendor, self-selected; service-provider vertical ~50%).
- Quiz vs static form: ~40–47% vs ~2.8% (Outgrow); DemandGen ~70% vs 36%
  interactive-vs-passive. Directionally strong, vendor-sourced.
- Multi-step vs single form: Formstack 13.9% vs 4.5%; Venture Harbour up to +300%.
  Multi-step wins for 7+ fields / lower intent; single-step for small, high-intent asks.

### Mobile-first (research-grounded)

- **Tap targets ≥ 44–48px** (Apple 44pt, Material 48dp, WCAG 2.5.5); 44→30px roughly
  doubles error rates. 8px minimum spacing, 12–16px preferred.
- **Single-column, top-to-bottom**; ~15s faster completion than multi-column.
- **No scrolling per step**; one thumb-reach view per screen.
- **Speed is conversion:** sub-1s load ~24–30% vs ~8–11% at 5s+ (vendor framing, but
  speed→conversion is among the best-established facts in web perf).

### Healthcare/dental specifics

- **The "assessment" framing is itself the conversion tactic** — "Get Your Free Smile
  Assessment" beats "Book a Consultation" as a lower-resistance entry offer. Our funnel
  is built on exactly this.
- **UK compliance (GDC + ASA/CAP), non-negotiable in funnel copy:**
  - No patient testimonials in any medium. Permitted trust signals: GDC registration,
    years established, aggregate Google rating, clinician names/qualifications.
  - No claims creating "unjustified expectations" of results.
  - When promoting treatment: state suitability depends on a clinical assessment and it
    may not be right for everyone.
  - Whitening is specifically regulated (GDC-registered only; substantiated claims;
    avoid "instant"/"one visit").
  - House rule: no NHS/private funding jargon to patients.

---

## PART 2 — Perspective (perspective.co)

**Who they are:** German mobile-first funnel builder ("the #1 Mobile Funnel Builder",
~8,000+ users) aimed at agencies, recruiters, coaches and e-commerce running paid
social traffic. Thesis: "98.5% of your audience is scrolling on their phones."

**Headline numbers — treat skeptically:** "700% higher conversion", "42× faster
building", "300% better lead quality", "28% cold-traffic conversion" — uncontrolled
vendor/agency claims. Do not adopt as targets or quote to the client.

**Anatomy of a typical Perspective funnel:**
1. **Hero/welcome ("5-second hook")** — full-bleed image or vertical video, one
   outcome-focused headline, single CTA; sets time/effort expectation.
2. **Question steps** — one per screen, big tappable option cards, first 3 questions
   under 10 seconds, transitions between steps.
3. **Educational / "value" step** (optional) — a small insight so answering feels
   rewarding.
4. **Qualification questions near the end** (B2B: budget/timeline/authority last).
5. **Form/contact step** — minimal fields, late.
6. **Thank-you + close** — calendar booking embed (appointments) or VSL/checkout
   (sales); explicit "what happens next".

Modular blocks (text/image/video/form/button/Stripe), conditional logic, A/B testing.
Their engineering obsession: mobile-first + speed (sub-1s, compressed media).

**Worth copying:** one-decision-per-screen discipline; the 5-second value hook;
single-CTA screens; the speed obsession; logic jumps; closing on a live booking embed
(we already do).

---

## PART 3 — Applied to our Smile Assessment

### (a) Scorecard (honest)

| Area | Best practice | Us | Verdict |
|---|---|---|---|
| Question count | 5–7 | ~4–6 adaptive | OK |
| One-per-screen | Yes | Yes | OK |
| Personalisation | Highest leverage | Real AI-adaptive next question | Ahead |
| Contact gate | End, before result | Correct | OK |
| Contact friction | Minimal | Name + channel + one field | Excellent |
| Back button | Expected | Present | OK |
| Speed-to-lead | Fast follow-up | Instant SMS to high scorers | Strong |
| Booking close | Calendar embed | Live "Book now" calendar | OK |
| Trust signals | GDC-permitted only | Branded header only | THIN — add |
| Results-teaser at gate | Promise the outcome | Not explicit | MISSING leverage |
| Progress indicator | Credible progress | Adaptive-length tension | NEEDS pattern |
| Welcome hook | 5-sec value frame | Cold open on Q1 | TEST it |
| Tap ergonomics | ≥48px, no scroll | Verify at 375px | VERIFY |
| AI-step latency | Sub-1s, never blank | AI call can stall | DE-RISK |
| Compliance copy | Suitability line | Consent line only | ADD |

### (b) Ranked changes

1. **Results-teaser frame on the contact step** (copy tweak — highest ROI): reframe as
   the unlock of a promised, personalised outcome ("You're matched — where shall we
   send your tailored next step?"). GDC-safe: promise a next step, not a clinical result.
2. **Honest momentum pattern instead of the adaptive progress bar** (small redesign):
   verbal momentum microcopy ("Almost done — 2 quick things left") or a fixed-segment
   bar; a jumping bar undermines trust.
3. **Make the AI next-question step feel instant** (perf): render the transition line +
   an answer-shaped skeleton immediately; hard timeout falling back to a static next
   question; never a blank/spinner stall.
4. **A/B test a one-line value hook above Q1** ("5 quick questions, about 30 seconds")
   vs the current cold open — a real trade-off, test not assume.
5. **Verify mobile tap ergonomics at 375px**: buttons ≥48px, 12–16px gaps, zero
   scrolling per step, thumb-zone CTA.
6. **Add GDC/ASA-permitted trust signals + the suitability disclaimer** (copy, also
   compliance): GDC-registered, years established, aggregate rating; "treatment depends
   on a clinical assessment and may not be suitable for everyone."
7. **Test visual option cards on the goal question only** (inline SVG, not photos).
8. **Confirm the iframe embed adds no hop/double-scroll**; offer the full-page link for
   SMS/paid traffic (attribution links already exist).
9. **(Lower) soft abandonment fallback** on the contact step ("prefer we just call?").

### (c) What NOT to copy from Perspective

- Their headline stats (uncontrolled marketing; never set as targets).
- VSL / long vertical-video sales sequences (cold-paid-social tooling; heavy, slow,
  tonally wrong for regulated dental).
- Aggressive B2B qualification gates (budget/authority) — off-putting in a patient
  health context.
- Hype/urgency copy and any pre-quiz email "toll" (the one placement the evidence says
  actively hurts).
- Heavy autoplay-video hero (weight without benefit for warm website traffic).

**Net:** the funnel is already structurally right (end-gate, minimal fields, genuine
adaptivity, instant SMS, booking close). The cheap wins: results-teaser at the gate,
credible momentum pattern, AI-step latency de-risk, and the compliance trust
signals/suitability line (non-optional for UK dental).

---

## Sources

- Interact benchmarks: https://www.tryinteract.com/blog/quiz-conversion-rate-report/
- Quiz vs static: https://getaiform.com/blog/quiz-funnels-vs-static-lead-magnets-interactive-content-conversion-2026 · https://outgrow.co/blog/interactive-forms-lead-generation-2025/
- Multi-step forms: https://ivyforms.com/blog/multi-step-forms-single-step-forms/ · https://ventureharbour.com/multi-step-lead-forms-get-300-conversions/
- Question count: https://landerlab.io/blog/quiz-funnel-questions · https://www.leadshook.com/blog/how-many-questions-quiz/
- Gate placement: https://heyflow.com/blog/personalized-results-quiz-funnel/ · https://www.involve.me/blog/how-to-create-a-quiz-funnel · https://woobox.com/articles/lead-generation-quiz-strategy
- Psychology: https://heyflow.com/blog/the-psychology-of-micro-commitments/ · https://www.crazyegg.com/blog/science-of-micro-commitments/
- Mobile ergonomics: https://smart-interface-design-patterns.com/articles/accessible-tap-target-sizes/ · https://www.growthsuite.net/questions/what-s-the-ideal-button-size-for-mobile
- Perspective: https://www.perspective.co/ · https://www.perspective.co/templates · https://www.perspective.co/academy · https://intercom.help/perspective-funnels/en/articles/4754756-how-can-i-improve-my-funnel-to-attract-even-more-leads · https://www.markinblog.com/perspective-funnels-tutorial/ · https://stormy.ai/blog/perspective-quiz-funnel-playbook-2026
- Dental lead-gen: https://www.remedo.io/blog/how-to-market-invisalign-and-clear-aligners-services · https://leadcapture.io/blog/orthodontic-marketing-strategy/
- UK compliance: https://www.gdc-uk.org/standards-guidance/standards-and-guidance/gdc-guidance-for-dental-professionals/guidance-on-advertising · https://www.asa.org.uk/advice-online/teeth-whitening.html · https://whitehat-seo.co.uk/blog/dental-marketing-compliance-uk
