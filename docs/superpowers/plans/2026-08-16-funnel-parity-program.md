# Funnel Parity Program — Perspective-class builder, our data advantage

Charter for the full build-out approved 2026-08-16. Source research: a live
tour of perspective.co's editor (Tayyib's trial workspace). Everything below
ships through Opus 5 subagent waves with adversarial verification; Fable
plans and integrates. Local commits only — production push stays a separate,
explicit decision.

## Non-negotiable constraints (apply to every lane)

- All rules live in pure `.ts` modules with sibling `.test.ts`; components
  stay dumb. vitest collects `src/**/*.test.ts` only.
- Flow edits go through `updateCampaignFlow` (compliance scan + version bump).
  The adaptive AI mode remains the universal fallback; existing links never
  break. Scoring weights never enter the public bundle.
- Patient-facing copy: no NHS/private funding jargon, GDC/ASA-compliant, and
  **AI never fabricates testimonials, reviews, or outcome claims** — a
  testimonial block renders only practice-entered quotes; AI may polish
  grammar, never invent.
- Public endpoints get `api_budget`-style cost guards; no pre-contact PII in
  analytics events. New API routes take `requireModuleApiAccess` (or an
  owner/approver guard) and join the coverage test.
- Kill switch: every new public surface honours the per-system switch
  fail-closed at the page level.
- Payment blocks: **out of scope permanently** (no platform payment path).
- Migrations: builders write files; Fable applies via MCP after verify.

## Phase A — the Perspective feel on our architecture

**A1. Click-to-edit on the phone.** The stage-2/3 split collapses: the flow
canvas's phone-screen minis become the editing surface. Selecting a screen
opens an inspector rail (question, options, branch targets, copy) —
Perspective's block-inspector pattern, scoped to whole screens first. The
abstract-card canvas retires only when the phone canvas covers everything it
did (add/remove/reorder/branch/validation states).

**A2. Content blocks + image-card answers.** FlowGraph nodes gain a bounded,
presentational block set — trust strip (logo bar), testimonial, FAQ, image —
valid only on welcome/outcome screens, plus optional images on question
options (image-card answers; curated assets, starting with
`/public/assess/conditions`). Blocks are cosmetic: `parseResponses` and
scoring are untouched, enforced by test. Validation rules extend
`flow-validate` (all-failures-at-once style). Public quiz + phone minis
render the same blocks from the same projection.

**A3. Step drop-off analytics.** The deterministic runtime posts anonymous
step-view events (campaign, flow version, step index, session nonce — no
PII) to a guarded public endpoint; a pure aggregation lib turns them into a
per-step drop-off funnel on the campaign view. Perspective charges for this;
we get it native.

## Phase B — retention + distribution

**B1. Custom themes.** "Your themes" alongside the 7 presets: owner-defined
palettes stored per client, validated server-side by the SAME computed
WCAG-AA contrast function that gates the preset catalogue (promote it from
palette.test.ts into a lib; the server rejects sub-AA). Closed token set,
colour-format validation, picker + public page consume customs exactly like
presets.

**B2. Per-assessment follow-up config.** Perspective's "Messages", our
infrastructure: per-campaign first-touch override (trigger: submission /
high score), on/off toggle, feeding the existing outbound layer and its
consent/suppression rules. No new send paths.

**B3. Meta pixel + CAPI on /assess.** Per-client pixel config (off by
default, consent-gated per UK GDPR) and server-side CAPI events on
submission — closes the loop with the Meta Ads module's campaign builder.

## Phase C — the step Perspective cannot copy

**C1. In-funnel booking.** The funnel's final screen can embed the existing
public booking flow (live Dentally availability). Quiz → qualified → books a
real slot without leaving the page. Reuses the booking module wholesale so it
inherits its write gates and the pending Dentally patient-create calibration
(422 on live registration is a known, separately-tracked blocker; mock/demo
paths work today). Kill-switch aware; no new Dentally write code.

## AI writes everything (parallel lane)

Extends the existing template-stage "Let AI write one":
1. **Whole-funnel write/rewrite** from inside the builder — fills every
   screen's copy (and A2 blocks) while preserving locked structure and core
   questions.
2. **Per-screen / per-field assist** — "write this for me" on any copy field
   in the A1 inspector.
3. Same engine rules as today: SONNET + NO_THINKING, budget consumed before
   the call, one repair pass quoting validation failures, template fallback,
   server-pinned contact/outcome nodes, compliance scan at the choke point.

## Image library (final lane — after the builds)

Replace stock-looking imagery with a small curated library generated via
Higgsfield (user-directed): a few strong options per slot type (hero,
answer-card, trust/lifestyle), UK-dental-appropriate, no fake before/afters
of real patients. Stored as optimised static assets behind the image-picker
built in A2. Generation count and credit spend confirmed with Tayyib before
running.

## Sequencing

1. Land the in-flight re-colour build (campaigns-panel is frozen until then).
2. A2-model + A3 start immediately (pure lib/server lanes, no panel files).
3. A1 starts the moment re-colour commits; A2-UI follows A1's inspector.
4. B lanes after A stabilises (B1 depends on picker surfaces; B2/B3 mostly
   disjoint). C after A2's step plumbing. AI-content UI rides on A1.
5. Each lane: build wave → gates (tsc, full vitest, eslint ≤ baseline) →
   independent adversarial verify → fix rounds until SHIP → commit.
6. Program close: /security-review over the whole diff + memory update.
