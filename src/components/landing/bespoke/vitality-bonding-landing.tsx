/* eslint-disable @next/next/no-img-element */
import { getClient } from "@/lib/mock/clients";
import {
  getBespokeTemplate,
  bespokeVariantCopy,
  type BespokeVariantCopy,
} from "@/lib/landing/bespoke/registry";
import { BONDING_LANDING_COPY as C } from "@/lib/landing/bespoke/copy";
import type { VariantKey } from "@/lib/landing/winner";
import { ConsultationForm } from "./consultation-form";
import { RevealOnScroll } from "./reveal-on-scroll";
import { VITALITY_INVISALIGN_CSS } from "./vitality-invisalign-landing.styles";

// The bespoke, hand-designed Vitality Dental composite bonding landing page, a
// SERVER component that ADAPTS the Invisalign design. PURE and presentational apart
// from the embedded <ConsultationForm> (a client island): no hooks, no function props.
//
// It REUSES the Invisalign scoped stylesheet verbatim (the same VITALITY_INVISALIGN_CSS
// export, injected once under the single `.vd-landing` root) so the two pages share
// one design system and the CSS is never forked. Its per-variant hero + CTA copy (the
// A/B surface) comes from the bespoke registry; everything else is the shared,
// compliance-scanned bonding copy module.
//
// TRACKING: each major <section> carries a static snake_case `data-lp-section` and
// the scroll-to-form CTAs carry `data-lp-cta`, so the LandingTracker that wraps this
// on the public page fires viewed / cta_clicked / section_<name> exactly as it does
// for the generic renderer and the Invisalign page.
//
// COMPLIANCE (vs the Invisalign design): there are NO real bonding photos yet, so the
// Invisalign 3D condition-model grid is replaced with a line-icon "what bonding fixes"
// section, and the patient-story + before/after sections render clearly LABELLED
// PLACEHOLDER slots (never the Invisalign photos, never fabricated images). The
// before/after consent disclaimer is kept. Pricing shows the real catalogue figure
// (Composite bonding from GBP 180) + "0% finance available". Full detail in copy.ts.

interface Props {
  variant: VariantKey;
  clientSlug: string;
  landingSlug: string;
  siteId?: string | null;
  practiceName: string;
}

const LOGO = "/copilot-logo.png";

const CHECK = "✓"; // tick

/** Highlight the accent phrase (first, case-insensitive occurrence) in the headline. */
function AccentedHeadline({ headline, accent }: { headline: string; accent: string }) {
  const idx = accent ? headline.toLowerCase().indexOf(accent.toLowerCase()) : -1;
  if (idx < 0) return <>{headline}</>;
  return (
    <>
      {headline.slice(0, idx)}
      <span className="acc">{headline.slice(idx, idx + accent.length)}</span>
      {headline.slice(idx + accent.length)}
    </>
  );
}

/** Shared 24x24 line-icon wrapper (stroke-based, decorative), matching the Invisalign style. */
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

// Authored line-icons for the "what composite bonding fixes" grid, in the same thin
// stroke, currentColor style as the Invisalign icons. Paired by index with C.fixes.items:
// chipped tooth, gaps/spacing, uneven/worn edges, small/peg tooth, discolouration, edge shaping.
const FIX_ICONS: React.ReactNode[] = [
  // Chipped corner (a chip taken out of a rounded panel).
  <>
    <path d="M5 8.5A3.5 3.5 0 0 1 8.5 5H14l5 5v5.5A3.5 3.5 0 0 1 15.5 19h-7A3.5 3.5 0 0 1 5 15.5Z" />
    <path d="M14 5v5h5" />
  </>,
  // Gaps and spacing (two teeth with a measured gap between).
  <>
    <rect x="4" y="6" width="5" height="12" rx="1.6" />
    <rect x="15" y="6" width="5" height="12" rx="1.6" />
    <path d="M10.6 12h2.8" />
    <path d="M11.6 10.6 10.2 12l1.4 1.4" />
    <path d="M12.4 10.6 13.8 12l-1.4 1.4" />
  </>,
  // Uneven or worn edges (a wavy top over a baseline).
  <>
    <path d="M4 10q2-3 4 0t4 0 4 0 4 0" />
    <path d="M4 15.5h16" />
  </>,
  // Small or peg shaped tooth (short bar built up between two tall ones).
  <>
    <rect x="4" y="6" width="4" height="12" rx="1.3" />
    <rect x="16" y="6" width="4" height="12" rx="1.3" />
    <rect x="10" y="12" width="4" height="6" rx="1.3" />
    <path d="M12 10.5V7" />
    <path d="M10.5 8.5 12 7l1.5 1.5" />
  </>,
  // Minor discolouration (a half-shaded circle, a shade/colour mark).
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 4a8 8 0 0 0 0 16Z" />
  </>,
  // Edge shaping (a pencil shaping an edge over a line).
  <>
    <path d="M4 20h16" />
    <path d="M14.5 5.5 18 9l-8.5 8.5L6 18l.5-3.5z" />
    <path d="M13 7 16.5 10.5" />
  </>,
];

// Three benefit-card icons (check, clock, banknote).
const BENEFIT_ICONS: React.ReactNode[] = [
  <>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M8.5 12.2l2.4 2.4 4.6-4.8" />
  </>,
  <>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M12 7.4V12l3.2 2" />
  </>,
  <>
    <rect x="3.5" y="7" width="17" height="10" rx="2" />
    <circle cx="12" cy="12" r="2.2" />
    <path d="M6 9.5v5" />
    <path d="M18 9.5v5" />
  </>,
];

// Six why-us icons (shield-check, person, shade droplet, location pin, card, speech bubble).
const WHY_ICONS: React.ReactNode[] = [
  <>
    <path d="M12 3.2 19 5.6v4.9c0 4.4-3 7.4-7 8.9-4-1.5-7-4.5-7-8.9V5.6Z" />
    <path d="M9 11.8l2 2 4-4.2" />
  </>,
  <>
    <circle cx="12" cy="8" r="3.4" />
    <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
  </>,
  <>
    <path d="M12 4s5 5.2 5 9a5 5 0 0 1-10 0c0-3.8 5-9 5-9Z" />
  </>,
  <>
    <path d="M12 21.5s6.8-5.4 6.8-10.7a6.8 6.8 0 1 0-13.6 0c0 5.3 6.8 10.7 6.8 10.7Z" />
    <circle cx="12" cy="10.6" r="2.5" />
  </>,
  <>
    <rect x="3" y="6" width="18" height="12" rx="2.5" />
    <path d="M3 10h18" />
    <path d="M7 14.5h4" />
  </>,
  <>
    <path d="M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-4 3v-3H4.5A1.5 1.5 0 0 1 3 14.5v-7A1.5 1.5 0 0 1 4.5 5.5Z" />
  </>,
];

// A larger "photo placeholder" glyph for the empty story / before-after slots.
function PhotoPlaceholderIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="34"
      height="34"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <circle cx="8.5" cy="10" r="1.6" />
      <path d="M4 17l4.5-4 3 2.5L15 11l5 5" />
    </svg>
  );
}

export function VitalityBondingLanding({
  variant,
  clientSlug,
  landingSlug,
  siteId,
  practiceName,
}: Props) {
  // Resolve the per-variant copy from the registry (keyed by the resolved clientId).
  const clientId = getClient(clientSlug)?.id ?? clientSlug;
  const template = getBespokeTemplate(clientId, landingSlug);
  const v: BespokeVariantCopy = template
    ? bespokeVariantCopy(template, variant)
    : {
        // Defensive fallback (the render seam only mounts this when a template exists).
        heroHeadline: C.fixes.head.title,
        heroAccent: "",
        heroSubhead: "",
        ctaLabel: C.form.submitFallback,
      };

  return (
    <div className="vd-landing">
      {/* Design CSS, scoped under .vd-landing. Reused from the Invisalign page (not forked). */}
      <style dangerouslySetInnerHTML={{ __html: VITALITY_INVISALIGN_CSS }} />
      {/* Scroll-reveal + sticky-header controller (client island, no-JS safe). */}
      <RevealOnScroll />

      {/* ---- HEADER ------------------------------------------------------- */}
      <header>
        <div className="wrap">
          <div className="brand">
            <img src={LOGO} alt={`${practiceName} logo`} />
            <div>
              <b>{C.header.brand}</b>
            </div>
          </div>
          <a className="btn-blue" href="#consultation" data-lp-cta>
            {v.ctaLabel}
          </a>
        </div>
      </header>

      {/* ---- HERO --------------------------------------------------------- */}
      <section className="hero" data-lp-section="hero">
        <div className="glow" />
        <div className="wrap">
          <div className="grid">
            <div>
              <div className="eyebrow">{C.heroEyebrow}</div>
              <h1>
                <AccentedHeadline headline={v.heroHeadline} accent={v.heroAccent} />
              </h1>
              <p className="lede">{v.heroSubhead}</p>
              <div className="pills">
                {C.heroPills.map((pill) => (
                  <span className="pill" key={pill}>
                    <span className="ck">{CHECK}</span> {pill}
                  </span>
                ))}
              </div>
              <div className="trust">
                {C.trust.map((t) => (
                  <div key={t.label}>
                    <b>{t.value}</b>
                    <span>{t.label}</span>
                  </div>
                ))}
              </div>
            </div>
            <ConsultationForm
              variant={variant}
              clientSlug={clientSlug}
              landingSlug={landingSlug}
              siteId={siteId}
              submitLabel={v.ctaLabel}
              copy={C.form}
            />
          </div>
        </div>
      </section>

      {/* ---- WHAT COMPOSITE BONDING FIXES (line-icon cards) --------------- */}
      <section className="lt" data-lp-section="fixes" data-reveal="">
        <div className="wrap">
          <div className="sec-head center">
            <div className="eyebrow">{C.fixes.head.eyebrow}</div>
            <h2>{C.fixes.head.title}</h2>
          </div>
          <div className="cards6">
            {C.fixes.items.map((item, i) => (
              <div className="pcard" key={item.title}>
                <div className="ic">
                  <Icon>{FIX_ICONS[i]}</Icon>
                </div>
                <h4>{item.title}</h4>
                <p>{item.body}</p>
              </div>
            ))}
          </div>
          <div className="banner">
            {C.fixes.banner.lead}
            <span className="acc">{C.fixes.banner.accent}</span>
            {C.fixes.banner.tail}
          </div>
        </div>
      </section>

      {/* ---- THE TREATMENT (about + how it works) ------------------------- */}
      <section className="lt alt" data-lp-section="treatment" data-reveal="">
        <div className="wrap">
          <div className="split-head">
            <div>
              <div className="eyebrow">{C.treatment.head.eyebrow}</div>
              <h2>{C.treatment.head.title}</h2>
            </div>
            <p>{C.treatment.head.intro}</p>
          </div>
          <div className="tpanel">
            <div>
              <h3>{C.treatment.aboutTitle}</h3>
              <p>{C.treatment.aboutBody}</p>
            </div>
            <div className="facts">
              <div className="fe">{C.treatment.keyFactsTitle}</div>
              <ul>
                {C.treatment.keyFacts.map((f) => (
                  <li key={f}>
                    <span className="ck">{CHECK}</span> {f}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="eyebrow" style={{ marginTop: 44 }}>
            {C.treatment.stepsEyebrow}
          </div>
          <div className="steps">
            {C.treatment.steps.map((s, i) => (
              <div className="step" key={s.title}>
                <div className="n">{String(i + 1).padStart(2, "0")}</div>
                <h4>{s.title}</h4>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- BENEFITS ----------------------------------------------------- */}
      <section className="lt" data-lp-section="benefits" data-reveal="">
        <div className="wrap">
          <div className="sec-head center">
            <div className="eyebrow">{C.benefits.head.eyebrow}</div>
            <h2>{C.benefits.head.title}</h2>
          </div>
          <div className="cards6">
            {C.benefits.items.map((item, i) => (
              <div className="pcard" key={item.title}>
                <div className="ic">
                  <Icon>{BENEFIT_ICONS[i]}</Icon>
                </div>
                <h4>{item.title}</h4>
                <p>{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- SUITABILITY (is bonding right for you) ----------------------- */}
      <section className="lt alt" data-lp-section="suitability" data-reveal="">
        <div className="wrap">
          <div className="sec-head center">
            <div className="eyebrow">{C.suitability.head.eyebrow}</div>
            <h2>{C.suitability.head.title}</h2>
          </div>
          <div className="cards6">
            {C.suitability.items.map((item) => (
              <div className="pcard" key={item.title}>
                <div className="ic">
                  <Icon>
                    <path d="M8.5 12.2l2.4 2.4 4.6-4.8" />
                    <circle cx="12" cy="12" r="8.3" />
                  </Icon>
                </div>
                <h4>{item.title}</h4>
                <p>{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- PATIENT STORIES (labelled placeholder slots) ---------------- */}
      <section className="lt" data-lp-section="stories" data-reveal="">
        <div className="wrap">
          <div className="split-head">
            <div>
              <div className="eyebrow">{C.stories.head.eyebrow}</div>
              <h2>{C.stories.head.title}</h2>
            </div>
            <p>{C.stories.head.intro}</p>
          </div>
          <div className="stories">
            {[1, 2, 3].map((n) => (
              <div className="story" key={n}>
                <div
                  className="ph"
                  style={{
                    border: "1.5px dashed var(--frame)",
                    padding: 22,
                    textAlign: "center",
                  }}
                >
                  <div style={{ color: "var(--blue)" }}>
                    <PhotoPlaceholderIcon />
                    <div style={{ marginTop: 10, fontSize: 13, fontWeight: 700, color: "var(--navy)" }}>
                      {C.stories.placeholderTitle}
                    </div>
                    <div style={{ marginTop: 5, fontSize: 12, color: "var(--tx-soft)", lineHeight: 1.4 }}>
                      {C.stories.placeholderNote}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- BEFORE & AFTER (placeholder slots + kept consent disclaimer) - */}
      <section className="dk" data-lp-section="before_after" data-reveal="">
        <div className="wrap">
          <div className="sec-head center">
            <div className="eyebrow">{C.beforeAfter.head.eyebrow}</div>
            <h2>{C.beforeAfter.head.title}</h2>
            <p>{C.beforeAfter.head.intro}</p>
          </div>
          <div className="ba">
            {[1, 2, 3].map((n) => (
              <div className="bacard" key={n}>
                <div
                  style={{
                    aspectRatio: "1 / 1",
                    display: "grid",
                    placeItems: "center",
                    textAlign: "center",
                    padding: 20,
                    border: "1.5px dashed rgba(255,255,255,.18)",
                    color: "var(--tx-on-soft)",
                  }}
                >
                  <div>
                    <PhotoPlaceholderIcon />
                    <div style={{ marginTop: 10, fontSize: 13, fontWeight: 700, color: "#fff" }}>
                      {C.beforeAfter.placeholderTitle}
                    </div>
                    <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.4 }}>
                      {C.beforeAfter.placeholderNote}
                    </div>
                  </div>
                </div>
                <div className="cap">
                  <b>{C.beforeAfter.capTitle}</b>
                  <span>{C.beforeAfter.capNote}</span>
                </div>
              </div>
            ))}
          </div>
          <p className="disc">{C.beforeAfter.disclaimer}</p>
        </div>
      </section>

      {/* ---- WHY VITALITY DENTAL ------------------------------------------ */}
      <section className="lt" data-lp-section="why" data-reveal="">
        <div className="wrap">
          <div className="sec-head center">
            <div className="eyebrow">{C.why.head.eyebrow}</div>
            <h2>{C.why.head.title}</h2>
          </div>
          <div className="cards6">
            {C.why.items.map((item, i) => (
              <div className="pcard" key={item.title}>
                <div className="ic">
                  <Icon>{WHY_ICONS[i]}</Icon>
                </div>
                <h4>{item.title}</h4>
                <p>{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- PRICING (real catalogue price) ------------------------------- */}
      <section className="lt alt" data-lp-section="pricing" data-reveal="">
        <div className="wrap">
          <div className="sec-head center">
            <div className="eyebrow">{C.pricing.head.eyebrow}</div>
            <h2>{C.pricing.head.title}</h2>
            <p>{C.pricing.head.intro}</p>
          </div>
          <div className="price">
            <div className="pcard-dark">
              <div className="fe">{C.pricing.priceEyebrow}</div>
              <div className="big">{C.pricing.priceLabel}</div>
              <div className="chip">
                <span style={{ color: "var(--blue-light)" }}>{CHECK}</span> {C.pricing.financeChip}
              </div>
              <div className="fin">{C.pricing.financeNote}</div>
              <a className="btn-blue block" href="#consultation" data-lp-cta>
                {v.ctaLabel}
              </a>
              <p className="fine">{C.pricing.fineprint}</p>
            </div>
            <div className="getcard">
              <div className="fe">{C.pricing.getTitle}</div>
              {C.pricing.getItems.map((item) => (
                <div className="getrow" key={item.title}>
                  <span className="ck">{CHECK}</span>
                  <div>
                    <b>{item.title}</b>
                    <span>{item.body}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ---- FOOTER ------------------------------------------------------- */}
      <footer>
        <div className="wrap">
          <span>
            <b>{C.footer.brand}</b> {C.footer.tagline}
          </span>
          <span>{C.footer.builtBy}</span>
          <span className="compliance">{C.footer.compliance}</span>
        </div>
      </footer>
    </div>
  );
}
