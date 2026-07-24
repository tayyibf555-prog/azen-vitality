/* eslint-disable @next/next/no-img-element */
import { getClient } from "@/lib/mock/clients";
import {
  getBespokeTemplate,
  bespokeVariantCopy,
  type BespokeVariantCopy,
} from "@/lib/landing/bespoke/registry";
import type { TreatmentLandingCopy } from "@/lib/landing/bespoke/copy";
import type { VariantKey } from "@/lib/landing/winner";
import { ConsultationForm } from "./consultation-form";
import { RevealOnScroll } from "./reveal-on-scroll";
import { VITALITY_INVISALIGN_CSS } from "./vitality-invisalign-landing.styles";

// SHARED bespoke renderer for the four remaining Vitality Dental treatment landing
// pages (whitening, veneers, implant, checkup). A PURE SERVER component: no hooks, no
// function props, apart from the embedded <ConsultationForm> (a client island). The
// four per-slug components (vitality-<slug>-landing.tsx) are thin wrappers that pass
// their own compliance-scanned corpus (copy.ts) plus their authored icon arrays here,
// so all four share ONE design and the JSX is never forked four ways.
//
// It REUSES the Invisalign scoped stylesheet verbatim (the same VITALITY_INVISALIGN_CSS
// export, injected once under the single `.vd-landing` root) so every bespoke page
// shares one design system. Its per-variant hero + CTA copy (the A/B surface) comes
// from the bespoke registry; everything else is the shared, compliance-scanned corpus.
//
// A/B PARITY: variants a and b are IDENTICAL in layout. They differ ONLY in the hero
// headline/accent/subhead and the CTA label (the registry surface). There are no
// per-variant layout flags here (no hero price chip, no sticky bar), so a and b render
// structurally byte-identical apart from that copy.
//
// TRACKING: each major <section> carries a static snake_case `data-lp-section` and the
// scroll-to-form CTAs carry `data-lp-cta`, so the LandingTracker fires viewed /
// cta_clicked / section_<name> exactly as for the other bespoke pages.
//
// COMPLIANCE: there are no real photos yet, so the patient-story + before/after
// sections render clearly LABELLED PLACEHOLDER slots (never fabricated images), and the
// consent disclaimer is kept. Pricing shows the real catalogue figure, and the finance
// chip renders ONLY when the corpus supplies one (whitening/veneers/implant); checkup
// has no finance, so it shows a finance-free note instead. Full detail in copy.ts.

/** Base props the /go seam passes to every bespoke landing component. */
export interface BespokeLandingBaseProps {
  variant: VariantKey;
  clientSlug: string;
  landingSlug: string;
  siteId?: string | null;
  practiceName: string;
}

interface Props extends BespokeLandingBaseProps {
  /** The shared, compliance-scanned corpus for this treatment. */
  copy: TreatmentLandingCopy;
  /** Six authored line-icons for the pain-points grid (paired by index). */
  painPointIcons: React.ReactNode[];
  /** Six authored line-icons for the "what it helps with" grid (paired by index). */
  helpIcons: React.ReactNode[];
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

// Six generic why-us line-icons, shared across all four pages (shield-check, person,
// clock, location pin, card, speech bubble). The why copy differs per treatment; these
// icons are treatment-neutral, in the same thin stroke, currentColor style.
export const WHY_ICONS: React.ReactNode[] = [
  <>
    <path d="M12 3.2 19 5.6v4.9c0 4.4-3 7.4-7 8.9-4-1.5-7-4.5-7-8.9V5.6Z" />
    <path d="M9 11.8l2 2 4-4.2" />
  </>,
  <>
    <circle cx="12" cy="8" r="3.4" />
    <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
  </>,
  <>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M12 7.4V12l3.2 2" />
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
  <path d="M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-4 3v-3H4.5A1.5 1.5 0 0 1 3 14.5v-7A1.5 1.5 0 0 1 4.5 5.5Z" />,
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

export function StandardTreatmentLanding({
  variant,
  clientSlug,
  landingSlug,
  siteId,
  practiceName,
  copy: C,
  painPointIcons,
  helpIcons,
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

      {/* ---- SOUND FAMILIAR? (pain points, line-icon cards) -------------- */}
      <section className="lt" data-lp-section="pain_points" data-reveal="">
        <div className="wrap">
          <div className="sec-head center">
            <div className="eyebrow">{C.painPoints.head.eyebrow}</div>
            <h2>{C.painPoints.head.title}</h2>
            {C.painPoints.head.intro ? <p>{C.painPoints.head.intro}</p> : null}
          </div>
          <div className="cards6">
            {C.painPoints.items.map((item, i) => (
              <div className="pcard" key={item.title}>
                <div className="ic">
                  <Icon>{painPointIcons[i]}</Icon>
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

      {/* ---- WHAT IT HELPS WITH (line-icon cards) ------------------------- */}
      <section className="lt" data-lp-section="helps" data-reveal="">
        <div className="wrap">
          <div className="sec-head center">
            <div className="eyebrow">{C.helps.head.eyebrow}</div>
            <h2>{C.helps.head.title}</h2>
          </div>
          <div className="cards6">
            {C.helps.items.map((item, i) => (
              <div className="pcard" key={item.title}>
                <div className="ic">
                  <Icon>{helpIcons[i]}</Icon>
                </div>
                <h4>{item.title}</h4>
                <p>{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- PATIENT STORIES (labelled placeholder slots) ---------------- */}
      <section className="lt alt" data-lp-section="stories" data-reveal="">
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
            {C.beforeAfter.head.intro ? <p>{C.beforeAfter.head.intro}</p> : null}
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

      {/* ---- PRICING (real catalogue price; finance chip only where offered) */}
      <section className="lt alt" data-lp-section="pricing" data-reveal="">
        <div className="wrap">
          <div className="sec-head center">
            <div className="eyebrow">{C.pricing.head.eyebrow}</div>
            <h2>{C.pricing.head.title}</h2>
            {C.pricing.head.intro ? <p>{C.pricing.head.intro}</p> : null}
          </div>
          <div className="price">
            <div className="pcard-dark">
              <div className="fe">{C.pricing.priceEyebrow}</div>
              <div className="big">{C.pricing.priceLabel}</div>
              {C.pricing.financeChip ? (
                <>
                  <div className="chip">
                    <span style={{ color: "var(--blue-light)" }}>{CHECK}</span> {C.pricing.financeChip}
                  </div>
                  <div className="fin">{C.pricing.financeNote}</div>
                </>
              ) : (
                <div className="fin">{C.pricing.priceNote}</div>
              )}
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
      <section className="lt" data-lp-section="faq" data-reveal="">
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
