/* eslint-disable @next/next/no-img-element */
import { getClient } from "@/lib/mock/clients";
import {
  getBespokeTemplate,
  bespokeVariantCopy,
  type BespokeVariantCopy,
} from "@/lib/landing/bespoke/registry";
import { HYGIENE_LANDING_COPY as C } from "@/lib/landing/bespoke/copy";
import type { VariantKey } from "@/lib/landing/winner";
import { ConsultationForm } from "./consultation-form";
import { BeforeAfterSlider } from "./before-after-slider";
import { VITALITY_INVISALIGN_CSS } from "./vitality-invisalign-landing.styles";

// The bespoke, hand-designed Vitality Dental hygiene (scale and polish) landing page,
// a SERVER component that ADAPTS the Invisalign/bonding design. PURE and presentational
// apart from two client islands: the embedded <ConsultationForm> and the interactive
// <BeforeAfterSlider>. No hooks, no function props in this component itself.
//
// It REUSES the Invisalign scoped stylesheet verbatim (the same VITALITY_INVISALIGN_CSS
// export, injected once under the single `.vd-landing` root) so all three pages share
// one design system and the CSS is never forked. Its per-variant hero + CTA copy (the
// A/B surface) comes from the bespoke registry; everything else is the shared,
// compliance-scanned hygiene copy module.
//
// TRACKING: each major <section> carries a static snake_case `data-lp-section` and the
// scroll-to-form CTAs carry `data-lp-cta`, so the LandingTracker that wraps this on the
// public page fires viewed / cta_clicked / section_<name> exactly as for the other pages.
//
// COMPLIANCE: hygiene has NO finance, so there is no 0%/interest wording anywhere. The
// before/after band shows a stylised ILLUSTRATION (never a real patient photo), inside a
// slider whose verbatim caption says so. Pricing shows the real catalogue figure (Hygiene
// visit from GBP 75). Full detail in copy.ts.

interface Props {
  variant: VariantKey;
  clientSlug: string;
  landingSlug: string;
  siteId?: string | null;
  practiceName: string;
}

const LOGO = "/copilot-logo.png";
const PRODUCT_IMG = "/landing/hygiene/fresh-smile.jpg";
const BEFORE_IMG = "/landing/hygiene/smile-before.png";
const AFTER_IMG = "/landing/hygiene/smile-after.png";

const CHECK = "✓"; // tick
const DOT = "●"; // filled circle (header locations pin)

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

// A clean single-tooth glyph, reused across the hygiene line-icons.
const TOOTH =
  "M12 4.2c-2.3-1.6-5-1.7-6.4-.2-1.6 1.7-1.3 4.6-.6 7.2.5 1.9.8 3.4 1.1 5.1.3 1.7.6 3.4 1.6 3.4 1.2 0 1.2-2.2 1.5-3.9.2-1.2.5-2.1 1.2-2.1s1 .9 1.2 2.1c.3 1.7.3 3.9 1.5 3.9 1 0 1.3-1.7 1.6-3.4.3-1.7.6-3.2 1.1-5.1.7-2.6 1-5.5-.6-7.2-1.4-1.5-4.1-1.4-6.4.2Z";

// Authored line-icons for the "sound familiar" concerns grid, paired by index with
// C.concerns.items: rough/furry tooth, tea/coffee mug, tender gums droplet, freshness
// air lines, a clock (it has been a while), a refresh arrow (fresh start).
const CONCERN_ICONS: React.ReactNode[] = [
  <>
    <path d={TOOTH} />
    <circle cx="9.8" cy="10.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="13.6" cy="9.6" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="11.4" cy="13" r="0.9" fill="currentColor" stroke="none" />
  </>,
  <>
    <path d="M5 8h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4Z" />
    <path d="M16 9.5h2.2a2 2 0 0 1 0 4H16" />
    <path d="M8 3.6c-.6.8-.6 1.5 0 2.3M11.5 3.6c-.6.8-.6 1.5 0 2.3" />
  </>,
  <path d="M12 3.5s5 5.5 5 9.2a5 5 0 0 1-10 0C7 9 12 3.5 12 3.5Z" />,
  <>
    <path d="M4 8.5h9a2.2 2.2 0 1 0-2.2-2.2" />
    <path d="M4 12h13a2.4 2.4 0 1 1-2.4 2.4" />
    <path d="M4 15.5h7a2 2 0 1 1-2 2" />
  </>,
  <>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M12 7.4V12l3.2 2" />
  </>,
  <>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 4.5V9h-4.5" />
  </>,
];

// "What a professional clean helps with" icons, paired by index with C.helps.items:
// cleaned tooth (check), sparkle (stain lifted), health cross, smile, calendar, house.
const HELP_ICONS: React.ReactNode[] = [
  <>
    <path d={TOOTH} />
    <path d="M9.3 11.4l1.8 1.8 3.5-3.7" />
  </>,
  <>
    <path d="M12 3.5l1.7 4.3 4.3 1.7-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7Z" />
    <path d="M18.4 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z" />
  </>,
  <>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M12 8.4v7.2M8.4 12h7.2" />
  </>,
  <>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M8 13.5a4.2 4.2 0 0 0 8 0" />
    <path d="M9.2 9.6h.01M14.8 9.6h.01" />
  </>,
  <>
    <rect x="4" y="5.5" width="16" height="14" rx="2.4" />
    <path d="M4 9.5h16M8 3.6v4M16 3.6v4" />
    <path d="M9.5 13.6l1.6 1.6 3.4-3.6" />
  </>,
  <>
    <path d="M4 11 12 4.5 20 11" />
    <path d="M6 10v9h12v-9" />
    <path d="M10 19v-5h4v5" />
  </>,
];

// Six why-us icons (shield-check, person, heart, location pin, card, speech bubble).
const WHY_ICONS: React.ReactNode[] = [
  <>
    <path d="M12 3.2 19 5.6v4.9c0 4.4-3 7.4-7 8.9-4-1.5-7-4.5-7-8.9V5.6Z" />
    <path d="M9 11.8l2 2 4-4.2" />
  </>,
  <>
    <circle cx="12" cy="8" r="3.4" />
    <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
  </>,
  <path d="M12 20s-6.5-4.2-8.4-8.1C2.2 9 3.6 6 6.4 6c1.9 0 3 1.1 3.6 2.1C10.6 7.1 11.7 6 13.6 6c2.8 0 4.2 3 2.8 5.9C18.5 15.8 12 20 12 20Z" />,
  <>
    <path d="M12 21.5s6.8-5.4 6.8-10.7a6.8 6.8 0 1 0-13.6 0c0 5.3 6.8 10.7 6.8 10.7Z" />
    <circle cx="12" cy="10.6" r="2.5" />
  </>,
  <>
    <rect x="3" y="6" width="18" height="12" rx="2.5" />
    <path d="M3 10h18" />
    <path d="M7 14.5h4" />
  </>,
  <path d="M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-4 3v-3H4.5A1.5 1.5 0 0 1 3 14.5v-7A1.5 1.5 0 0 1 4.5 5.5Z" />,
];

export function VitalityHygieneLanding({
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
        heroHeadline: C.treatment.head.title,
        heroAccent: "",
        heroSubhead: "",
        ctaLabel: C.form.submitFallback,
      };

  return (
    <div className="vd-landing">
      {/* Design CSS, scoped under .vd-landing. Reused from the Invisalign page (not forked). */}
      <style dangerouslySetInnerHTML={{ __html: VITALITY_INVISALIGN_CSS }} />

      {/* ---- HEADER ------------------------------------------------------- */}
      <header>
        <div className="wrap">
          <div className="brand">
            <img src={LOGO} alt={`${practiceName} logo`} />
            <div>
              <b>{C.header.brand}</b>
              <span>{C.header.brandSub}</span>
            </div>
          </div>
          <div className="locs">
            <span className="pin">{DOT}</span> {C.header.locations}
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

      {/* ---- SOUND FAMILIAR? (concerns, line-icon cards) ----------------- */}
      <section className="lt" data-lp-section="pain_points">
        <div className="wrap">
          <div className="sec-head center">
            <div className="eyebrow">{C.concerns.head.eyebrow}</div>
            <h2>{C.concerns.head.title}</h2>
            <p>{C.concerns.head.intro}</p>
          </div>
          <div className="cards6">
            {C.concerns.items.map((item, i) => (
              <div className="pcard" key={item.title}>
                <div className="ic">
                  <Icon>{CONCERN_ICONS[i]}</Icon>
                </div>
                <h4>{item.title}</h4>
                <p>{item.body}</p>
              </div>
            ))}
          </div>
          <div className="banner">
            {C.concerns.banner.lead}
            <span className="acc">{C.concerns.banner.accent}</span>
            {C.concerns.banner.tail}
          </div>
        </div>
      </section>

      {/* ---- THE VISIT (about + how it works) ---------------------------- */}
      <section className="lt alt" data-lp-section="treatment">
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

      {/* ---- WHAT A PROFESSIONAL CLEAN HELPS WITH (line-icon cards) ------- */}
      <section className="lt" data-lp-section="helps">
        <div className="wrap">
          <div className="sec-head center">
            <div className="eyebrow">{C.helps.head.eyebrow}</div>
            <h2>{C.helps.head.title}</h2>
          </div>
          <div className="cards6">
            {C.helps.items.map((item, i) => (
              <div className="pcard" key={item.title}>
                <div className="ic">
                  <Icon>{HELP_ICONS[i]}</Icon>
                </div>
                <h4>{item.title}</h4>
                <p>{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- PRODUCT BAND (a clean you can feel) ------------------------- */}
      <section className="lt alt" data-lp-section="product">
        <div className="wrap">
          <div className="align-band">
            <div className="align-media">
              <img src={PRODUCT_IMG} alt={C.product.alt} loading="lazy" />
            </div>
            <div className="align-copy">
              <div className="eyebrow">{C.product.eyebrow}</div>
              <h2>{C.product.title}</h2>
              <p className="align-intro">{C.product.intro}</p>
              <ul className="align-feats">
                {C.product.features.map((f, i) => (
                  <li key={f.title}>
                    <span className="an">{String(i + 1).padStart(2, "0")}</span>
                    <div>
                      <h4>{f.title}</h4>
                      <p>{f.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ---- BEFORE & AFTER (interactive slider, illustration) ----------- */}
      <section className="dk" data-lp-section="before_after">
        <div className="wrap">
          <div className="sec-head center">
            <div className="eyebrow">{C.beforeAfter.head.eyebrow}</div>
            <h2>{C.beforeAfter.head.title}</h2>
            <p>{C.beforeAfter.head.intro}</p>
          </div>
          <div className="ba-card">
            <BeforeAfterSlider
              beforeSrc={BEFORE_IMG}
              afterSrc={AFTER_IMG}
              beforeAlt={C.beforeAfter.beforeAlt}
              afterAlt={C.beforeAfter.afterAlt}
              beforeLabel={C.beforeAfter.beforeLabel}
              afterLabel={C.beforeAfter.afterLabel}
              caption={C.beforeAfter.caption}
            />
          </div>
        </div>
      </section>

      {/* ---- WHY VITALITY DENTAL ------------------------------------------ */}
      <section className="lt" data-lp-section="why">
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

      {/* ---- PRICING (real catalogue price, NO finance) ------------------- */}
      <section className="lt alt" data-lp-section="pricing">
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
              <div className="fin">{C.pricing.priceNote}</div>
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

      {/* ---- FAQ ---------------------------------------------------------- */}
      <section className="lt" data-lp-section="faq">
        <div className="wrap">
          <div className="sec-head center">
            <div className="eyebrow">{C.faq.head.eyebrow}</div>
            <h2>{C.faq.head.title}</h2>
            {C.faq.head.intro ? <p>{C.faq.head.intro}</p> : null}
          </div>
          <div className="faqs">
            {C.faq.items.map((item) => (
              <details className="faq-item" key={item.q}>
                <summary>{item.q}</summary>
                <div className="faq-a">{item.a}</div>
              </details>
            ))}
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
