/* eslint-disable @next/next/no-img-element */
import { getClient } from "@/lib/mock/clients";
import {
  getBespokeTemplate,
  bespokeVariantCopy,
  type BespokeVariantCopy,
} from "@/lib/landing/bespoke/registry";
import { INVISALIGN_LANDING_COPY as C } from "@/lib/landing/bespoke/copy";
import type { VariantKey } from "@/lib/landing/winner";
import { ConsultationForm } from "./consultation-form";
import { RevealOnScroll } from "./reveal-on-scroll";
import { fraunces } from "./fonts";
import { VITALITY_INVISALIGN_CSS } from "./vitality-invisalign-landing.styles";

// The bespoke, hand-designed Vitality Dental Invisalign landing page, ported from
// the authored HTML/CSS to a SERVER component. PURE and presentational apart from
// the embedded <ConsultationForm> (a client island): no hooks, no function props.
//
// It does NOT read the DB variant content. Its per-variant hero + CTA copy (the
// A/B surface) comes from the bespoke registry; everything else is the shared,
// compliance-scanned copy module. All design CSS is injected once as an inline
// <style>, every selector scoped under the single `.vd-landing` root so it cannot
// leak into or collide with the app's global styles.
//
// TRACKING: each major <section> carries a static snake_case `data-lp-section` and
// the scroll-to-form CTAs carry `data-lp-cta`, so the LandingTracker that wraps
// this on the public page fires viewed / cta_clicked / section_<name> exactly as
// it does for the generic renderer.
//
// COMPLIANCE (vs the source design): the placeholder patient QUOTES + star ratings,
// the fabricated hero "star rating" trust stat, the clinician testimonial quote and
// the entire reviews wall are all omitted; the patient-story cards keep only the
// real photo + the "Invisalign" tag. The before/after section keeps its consent
// disclaimer. Pricing shows the real catalogue figure (from GBP 2,500) + "0%
// finance available". Full detail in copy.ts.

interface Props {
  variant: VariantKey;
  clientSlug: string;
  landingSlug: string;
  siteId?: string | null;
  practiceName: string;
}

const LOGO = "/copilot-logo.png";
const conditionImg = (key: string) => `/landing/invisalign/conditions/${key}.png`;
const patientImg = (n: number) => `/landing/invisalign/patients/story-${n}.jpg`;
const beforeAfterImg = (n: number) => `/landing/invisalign/before-after/case-${n}.jpg`;

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

/** Shared 24x24 line-icon wrapper (stroke-based, decorative). */
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

// The 12 authored line-icons, preserved exactly (paths verbatim from the source),
// paired by index with the "Sound familiar?" and "Why Vitality Dental" cards.
const PAIN_ICONS: React.ReactNode[] = [
  <path key="p" d="M7.3 3.6C5.5 3.6 4 5 4 7.3c0 1.8.8 2.9 1.4 4.8.5 1.7.5 5.2 1.8 5.6 1.2.4 1.3-2.5 1.8-4.2.3-1 .6-1.5 1.2-1.5s.9.5 1.2 1.5c.5 1.7.6 4.6 1.8 4.2 1.3-.4 1.3-3.9 1.8-5.6.6-1.9 1.4-3 1.4-4.8 0-2.3-1.5-3.7-3.3-3.7-1.6 0-2.3.9-3.8.9S8.9 3.6 7.3 3.6Z" />,
  <>
    <rect x="3.4" y="5.4" width="5.6" height="13.2" rx="2.8" />
    <rect x="15" y="5.4" width="5.6" height="13.2" rx="2.8" />
    <path d="M12 8.6v6.8" strokeDasharray="0.1 2.4" />
  </>,
  <>
    <rect x="6.5" y="6.4" width="14" height="4.4" rx="2.2" />
    <rect x="3.5" y="12.8" width="14" height="4.4" rx="2.2" />
  </>,
  <>
    <path d="M4 8.8A2.3 2.3 0 0 1 6.3 6.5h1.4l.9-1.5A1.4 1.4 0 0 1 9.8 4.3h4.4a1.4 1.4 0 0 1 1.2.7l.9 1.5h1.4A2.3 2.3 0 0 1 20 8.8v7.4a2.3 2.3 0 0 1-2.3 2.3H6.3A2.3 2.3 0 0 1 4 16.2Z" />
    <circle cx="12" cy="12.3" r="3.1" />
  </>,
  <>
    <path d="M3 12h18" />
    <rect x="4.4" y="9.6" width="3.2" height="4.8" rx="1" />
    <rect x="10.4" y="9.6" width="3.2" height="4.8" rx="1" />
    <rect x="16.4" y="9.6" width="3.2" height="4.8" rx="1" />
  </>,
  <>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M12 7.4V12l3.2 2" />
  </>,
];

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
    <path d="M12 21.5s6.8-5.4 6.8-10.7a6.8 6.8 0 1 0-13.6 0c0 5.3 6.8 10.7 6.8 10.7Z" />
    <circle cx="12" cy="10.6" r="2.5" />
  </>,
  <>
    <path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6Z" />
    <path d="M4 7.6l8 4.4 8-4.4" />
    <path d="M12 12v8.8" />
  </>,
  <>
    <rect x="3" y="6" width="18" height="12" rx="2.5" />
    <path d="M3 10h18" />
    <path d="M7 14.5h4" />
  </>,
  <>
    <path d="M6 21V4" />
    <path d="M6 5h10.5l-1.9 3.2 1.9 3.3H6" />
  </>,
];

export function VitalityInvisalignLanding({
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
        heroHeadline: C.stories.head.title,
        heroAccent: "",
        heroSubhead: "",
        ctaLabel: C.form.submitFallback,
      };

  return (
    <div className={`vd-landing ${fraunces.variable}`}>
      {/* Design CSS, scoped under .vd-landing. Static constant, no interpolation. */}
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

      {/* ---- PATIENT STORIES (photos + tag only) -------------------------- */}
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
                <div className="ph has-photo">
                  <img src={patientImg(n)} alt={C.stories.photoAlts[n - 1]} />
                  <span className="tag">{C.stories.tag}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- SOUND FAMILIAR? (empathy) ------------------------------------ */}
      <section className="lt alt" data-lp-section="pain_points" data-reveal="">
        <div className="wrap">
          <div className="sec-head center">
            <div className="eyebrow">{C.painPoints.head.eyebrow}</div>
            <h2>{C.painPoints.head.title}</h2>
            <p>{C.painPoints.head.intro}</p>
          </div>
          <div className="cards6">
            {C.painPoints.items.map((item, i) => (
              <div className="pcard" key={item.title}>
                <div className="ic">
                  <Icon>{PAIN_ICONS[i]}</Icon>
                </div>
                <h4>{item.title}</h4>
                <p>{item.body}</p>
              </div>
            ))}
          </div>
          <div className="banner">
            {C.painPoints.banner.lead}
            <span className="acc">{C.painPoints.banner.accent}</span>
            {C.painPoints.banner.tail}
          </div>
        </div>
      </section>

      {/* ---- THE TREATMENT ------------------------------------------------ */}
      <section className="lt" data-lp-section="treatment" data-reveal="">
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

      {/* ---- MEET YOUR ALIGNERS (product showcase) ----------------------- */}
      <section className="lt" data-lp-section="aligners" data-reveal="">
        <div className="wrap">
          <div className="align-band">
            <div className="align-media">
              <img src="/landing/invisalign/aligners.jpg" alt={C.aligners.alt} loading="lazy" />
            </div>
            <div className="align-copy">
              <div className="eyebrow">{C.aligners.eyebrow}</div>
              <h2>{C.aligners.title}</h2>
              <p className="align-intro">{C.aligners.intro}</p>
              <ul className="align-feats">
                {C.aligners.features.map((f, i) => (
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

      {/* ---- CONDITIONS TREATED (3D models) ------------------------------- */}
      <section className="lt alt" data-lp-section="conditions" data-reveal="">
        <div className="wrap">
          <div className="sec-head">
            <div className="eyebrow">{C.conditions.head.eyebrow}</div>
            <h2>{C.conditions.head.title}</h2>
          </div>
          <div className="conds">
            {C.conditions.items.map((item) => (
              <div className="cond" key={item.key}>
                <div className="img">
                  <img src={conditionImg(item.key)} alt={item.alt} />
                </div>
                <div className="bd">
                  <h4>{item.title}</h4>
                  <p>{item.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- BEFORE & AFTER (with consent disclaimer) --------------------- */}
      <section className="dk" data-lp-section="before_after" data-reveal="">
        <div className="wrap">
          <div className="sec-head center">
            <div className="eyebrow">{C.beforeAfter.head.eyebrow}</div>
            <h2>{C.beforeAfter.head.title}</h2>
            <p>{C.beforeAfter.head.intro}</p>
          </div>
          <div className="ba">
            {C.beforeAfter.cards.map((card, i) => (
              <div className="bacard" key={i}>
                <img className="baimg" src={beforeAfterImg(i + 1)} alt={card.alt} />
                <div className="cap">
                  <b>{card.title}</b>
                  <span>{card.caption}</span>
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
