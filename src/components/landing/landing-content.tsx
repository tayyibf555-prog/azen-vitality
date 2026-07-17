import type { CSSProperties } from "react";
import { Check, ShieldCheck, Star, MapPin, Building2 } from "lucide-react";
import type { LandingPageContent, Showcase3d } from "@/lib/landing/content";
import type { VariantKey } from "@/lib/landing/winner";
import type { PracticeFacts } from "@/lib/types";
import { buildCtaHref } from "@/lib/landing/links";

// The ONE vetted renderer for landing-page content (schema v2). PURE and
// presentational: no "use client", no hooks, no function props, so it is safe to
// render from the public server page AND from the client-side dashboard preview
// (the RSC shared-component boundary is only a problem for components that take
// function props; this takes none). All copy comes from a lint-passed content
// object, so no free-form model output ever reaches the DOM as markup.
//
// v2 layout (modelled on a high-performing conversion page, in Vitality's LIGHT
// brand): sticky topbar with one CTA -> hero (eyebrow, accented headline,
// checklist, proof stats, CTA) -> "Sound familiar?" empathy cards -> the
// treatment (what-is + key facts) -> numbered how-it-works -> suitability cards
// -> optional owner-configured 3D showcase -> pricing -> FAQs -> final CTA band
// -> quiet compliant footer.
//
// COMPLIANCE GATING: every proof claim (Google rating, review count, clinics
// count, awards line, press mentions) renders ONLY from the practiceFacts prop,
// which comes from practice configuration (owner-verified), never from content.
// A null/absent fact cleanly omits its element; no facts at all omits the whole
// proof row. The lint separately guarantees generated content cannot carry such
// claims itself.
//
// Mobile-first (90 percent of traffic is phones), on-brand with the assess pages
// (cream page, soft cards, navy ink, blue-royal accents). British English, GBP.

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});

// <model-viewer> is a custom element (vendored, self-hosted); declare it for TSX.
declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        poster?: string;
        alt?: string;
        loading?: "auto" | "lazy" | "eager";
        reveal?: "auto" | "manual";
        "camera-controls"?: boolean;
        "auto-rotate"?: boolean;
        "auto-rotate-delay"?: number | string;
        "rotation-per-second"?: string;
        "shadow-intensity"?: number | string;
        "touch-action"?: string;
        "interaction-prompt"?: string;
        "disable-zoom"?: boolean;
      };
    }
  }
}

interface Props {
  content: LandingPageContent;
  practiceName: string;
  clientSlug: string;
  landingSlug: string;
  variant: VariantKey;
  siteId?: string | null;
  /** Owner-verified practice facts; null/absent fields suppress their elements. */
  practiceFacts?: PracticeFacts | null;
  /** Display name of the treatment (for section headings); falls back generically. */
  treatmentName?: string;
  /**
   * Preview mode (dashboard): render CTAs as non-navigating spans so clicks in
   * the small preview do nothing and fire no attribution, and render the 3D
   * showcase as its static poster (no heavy script in the dashboard). Public
   * pages omit this.
   */
  preview?: boolean;
}

export function LandingContent({
  content,
  practiceName,
  clientSlug,
  landingSlug,
  variant,
  siteId,
  practiceFacts,
  treatmentName,
  preview,
}: Props) {
  const href = buildCtaHref({ clientSlug, cta: content.cta, variant, landingSlug, siteId });
  const facts = practiceFacts ?? null;

  return (
    <div className="min-h-screen">
      <Topbar
        practiceName={practiceName}
        locationsLine={facts?.locationsLine ?? null}
        ctaLabel={content.cta.label}
        preview={preview}
      />

      <main className="mx-auto w-full max-w-3xl px-4 pb-10 pt-6 sm:pt-10">
        {/* ---- HERO ---------------------------------------------------------- */}
        <section className="text-center" data-lp-section="hero">
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-blue-deep">
            {content.hero.eyebrow}
          </p>
          {facts?.awardsLine ? (
            // Owner-verified awards line ONLY (practice configuration, never AI copy).
            <p className="mt-1.5 text-xs font-semibold text-navy/70">{facts.awardsLine}</p>
          ) : null}
          <h1 className="mx-auto mt-3 max-w-2xl text-3xl font-bold leading-tight text-navy [text-wrap:balance] sm:text-4xl">
            <AccentedHeadline headline={content.hero.headline} accent={content.hero.headlineAccent} />
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-ink sm:text-base">
            {content.hero.subhead}
          </p>

          {/* Ticked benefit checklist (exactly four). */}
          <ul className="mx-auto mt-5 grid max-w-xl grid-cols-1 gap-2 text-left sm:grid-cols-2">
            {content.hero.checklist.map((item, i) => (
              <li key={i} className="flex items-center gap-2.5 rounded-xl border border-line bg-card px-3 py-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-royal/10 text-blue-royal">
                  <Check size={13} strokeWidth={3} />
                </span>
                <span className="text-[0.8rem] font-medium leading-snug text-navy">{item}</span>
              </li>
            ))}
          </ul>

          <ProofStats facts={facts} />

          {/* Primary CTA block; the topbar button anchors here. */}
          <div id="lp-cta" className="mt-7 scroll-mt-24">
            <CtaButton href={href} label={content.cta.label} preview={preview} large />
            <p className="mt-2.5 text-xs text-muted">
              Takes under a minute. No obligation, and no payment needed today.
            </p>
          </div>
        </section>

        {/* ---- SOUND FAMILIAR? (empathy) ------------------------------------- */}
        <section className="mt-12" data-lp-section="pain_points">
          <SectionHeading eyebrow="Sound familiar?" title="You are not the only one" />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {content.painPoints.items.map((p, i) => (
              <div key={i} className="rounded-2xl border border-line bg-card p-4">
                <h3 className="text-sm font-semibold text-navy">{p.title}</h3>
                <p className="mt-1 text-[0.8rem] leading-relaxed text-ink">{p.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-center text-sm font-medium leading-relaxed text-blue-deep">
            {content.painPoints.reassurance}
          </p>
        </section>

        {/* ---- THE TREATMENT (what it is + key facts) ------------------------ */}
        <section className="mt-12" data-lp-section="about">
          <SectionHeading
            eyebrow="The treatment"
            title={treatmentName ? `What is ${treatmentName}?` : "What is it?"}
          />
          <div className="mt-4 rounded-2xl border border-line bg-card p-5">
            <p className="text-sm leading-relaxed text-ink">{content.about.body}</p>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {content.about.keyFacts.map((f, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-royal/10 text-blue-royal">
                    <Check size={11} strokeWidth={3} />
                  </span>
                  <span className="text-[0.8rem] font-medium leading-snug text-navy">{f}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ---- HOW IT WORKS (01-04) ------------------------------------------ */}
        <section className="mt-12" data-lp-section="how_it_works">
          <SectionHeading eyebrow="How it works" title="Four simple steps" />
          <ol className="mt-4 space-y-3">
            {content.howItWorks.steps.map((s, i) => (
              <li key={i} className="flex gap-4 rounded-2xl border border-line bg-card p-4">
                <span
                  aria-hidden
                  className="mt-0.5 text-lg font-bold tabular-nums leading-none text-blue-royal/60"
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3 className="text-sm font-semibold text-navy">{s.title}</h3>
                  <p className="mt-1 text-[0.8rem] leading-relaxed text-ink">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* ---- SUITABILITY / CONDITIONS -------------------------------------- */}
        <section className="mt-12" data-lp-section="suitability">
          <SectionHeading eyebrow="Could it help you?" title={content.suitability.heading} />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {content.suitability.items.map((s, i) => (
              <div key={i} className="rounded-2xl border border-line bg-card p-4">
                <h3 className="text-sm font-semibold text-navy">{s.title}</h3>
                <p className="mt-1 text-[0.8rem] leading-relaxed text-ink">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---- 3D SHOWCASE (optional, owner-configured only) ----------------- */}
        {content.showcase3d ? (
          <section className="mt-12" data-lp-section="showcase">
            <SectionHeading eyebrow="Take a closer look" title="See it in 3D" />
            <ShowcaseViewer showcase={content.showcase3d} preview={preview} />
          </section>
        ) : null}

        {/* ---- PRICING -------------------------------------------------------- */}
        <section className="mt-12" data-lp-section="pricing">
          <SectionHeading eyebrow="Pricing" title="Clear, honest pricing" />
          <div className="mt-4 rounded-2xl border border-line bg-card p-5">
            <ul className="divide-y divide-line">
              {content.pricing.lines.map((l, i) => (
                <li key={i} className="flex items-baseline justify-between gap-4 py-2.5">
                  <span className="text-sm font-medium text-navy">{l.treatment}</span>
                  <span className="text-base font-bold tabular-nums text-navy">
                    from {GBP.format(l.fromPriceGBP)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs leading-relaxed text-muted">{content.pricing.caveat}</p>
          </div>
        </section>

        {/* ---- FAQs ----------------------------------------------------------- */}
        <section className="mt-12" data-lp-section="faq">
          <SectionHeading eyebrow="Common questions" title="Good to know" />
          <div className="mt-4 space-y-2.5">
            {content.faqs.map((f, i) => (
              <div key={i} className="rounded-2xl border border-line bg-card p-4">
                <h3 className="text-sm font-semibold text-navy">{f.q}</h3>
                <p className="mt-1 text-[0.8rem] leading-relaxed text-ink">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---- FINAL CTA BAND -------------------------------------------------- */}
        <section className="mt-12" data-lp-section="final_cta">
          <div className="rounded-3xl bg-blue-royal px-6 py-8 text-center sm:px-10">
            <h2 className="text-xl font-bold leading-tight text-white [text-wrap:balance] sm:text-2xl">
              Ready to take the first step?
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-white/85">
              Start today and the {practiceName} team will guide you from there.
            </p>
            <div className="mt-5">
              <CtaButton href={href} label={content.cta.label} preview={preview} inverted />
            </div>
          </div>
        </section>

        {/* GDC/ASA-safe footer: the required suitability line, no testimonials. */}
        <p className="mx-auto mt-8 flex max-w-md items-start justify-center gap-1.5 px-2 text-center text-[0.65rem] leading-relaxed text-muted">
          <ShieldCheck size={13} className="mt-px shrink-0 text-blue-deep" aria-hidden />
          <span>
            {practiceName}. Our dentists are GDC registered. Treatment suitability always depends
            on a clinical assessment.
          </span>
        </p>
      </main>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Topbar (sticky): brand + locations + one CTA anchoring to the hero CTA block.
 * ------------------------------------------------------------------------- */

function Topbar({
  practiceName,
  locationsLine,
  ctaLabel,
  preview,
}: {
  practiceName: string;
  locationsLine: string | null;
  ctaLabel: string;
  preview?: boolean;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-cream/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line bg-card">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/copilot-logo.png"
              alt={`${practiceName} logo`}
              width={26}
              height={26}
              className="h-[26px] w-[26px] object-contain"
            />
          </span>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-bold tracking-tight text-navy">{practiceName}</p>
            {locationsLine ? (
              <p className="flex items-center gap-1 truncate text-[0.65rem] text-muted">
                <MapPin size={10} className="shrink-0" aria-hidden />
                {locationsLine}
              </p>
            ) : null}
          </div>
        </div>
        {preview ? (
          <span className="inline-flex min-h-9 shrink-0 items-center rounded-lg bg-blue-royal px-3.5 text-sm font-semibold text-white" aria-hidden>
            {ctaLabel}
          </span>
        ) : (
          <a
            href="#lp-cta"
            className="inline-flex min-h-9 shrink-0 items-center rounded-lg bg-blue-royal px-3.5 text-sm font-semibold text-white transition-colors hover:bg-[#17579c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
          >
            {ctaLabel}
          </a>
        )}
      </div>
    </header>
  );
}

/* ---------------------------------------------------------------------------
 * Hero helpers
 * ------------------------------------------------------------------------- */

/** Headline with the accent phrase highlighted in blue-royal (first occurrence,
 *  case-insensitive). Falls back to the plain headline if the accent is absent
 *  (cannot happen for validated content; belt and braces for old data). */
function AccentedHeadline({ headline, accent }: { headline: string; accent: string }) {
  const idx = accent ? headline.toLowerCase().indexOf(accent.toLowerCase()) : -1;
  if (idx < 0) return <>{headline}</>;
  const before = headline.slice(0, idx);
  const match = headline.slice(idx, idx + accent.length);
  const after = headline.slice(idx + accent.length);
  return (
    <>
      {before}
      <span className="text-blue-royal">{match}</span>
      {after}
    </>
  );
}

/**
 * The proof stats row. OWNER-VERIFIED ONLY: renders exclusively from
 * PracticeFacts (practice configuration). Each stat is omitted when its value is
 * null; the whole row (and the press line) is omitted when nothing is set.
 */
function ProofStats({ facts }: { facts: PracticeFacts | null }) {
  if (!facts) return null;
  const stats: { key: string; icon: React.ReactNode; value: string; label: string }[] = [];
  if (typeof facts.googleRating === "number") {
    stats.push({
      key: "rating",
      icon: <Star size={13} className="fill-current" aria-hidden />,
      value: facts.googleRating.toFixed(1),
      label: "Google rating",
    });
  }
  if (typeof facts.reviewCount === "number") {
    stats.push({
      key: "reviews",
      icon: null,
      value: facts.reviewCount.toLocaleString("en-GB"),
      label: "Google reviews",
    });
  }
  if (typeof facts.clinicsCount === "number") {
    stats.push({
      key: "clinics",
      icon: <Building2 size={13} aria-hidden />,
      value: String(facts.clinicsCount),
      label: facts.clinicsCount === 1 ? "clinic" : "clinics",
    });
  }
  const press = facts.pressMentions.filter((p) => p.trim() !== "");
  if (stats.length === 0 && press.length === 0) return null;

  return (
    <div className="mt-5">
      {stats.length > 0 ? (
        <dl className="mx-auto flex max-w-xl flex-wrap items-stretch justify-center gap-2">
          {stats.map((s) => (
            <div
              key={s.key}
              className="flex min-w-[6.5rem] flex-1 flex-col items-center rounded-xl border border-line bg-card px-3 py-2.5"
            >
              <dd className="flex items-center gap-1 text-lg font-bold tabular-nums leading-none text-navy">
                {s.icon ? <span className="text-blue-royal">{s.icon}</span> : null}
                {s.value}
              </dd>
              <dt className="mt-1 text-[0.6rem] font-semibold uppercase tracking-wide text-muted">
                {s.label}
              </dt>
            </div>
          ))}
        </dl>
      ) : null}
      {press.length > 0 ? (
        <p className="mt-2.5 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-muted">
          As seen in {press.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * 3D showcase (owner-configured only)
 * ------------------------------------------------------------------------- */

// Removes auto-rotate for prefers-reduced-motion visitors. Static string (no
// interpolation), executed once after the viewer markup exists.
const REDUCED_MOTION_SCRIPT =
  "(function(){try{if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches){document.querySelectorAll('model-viewer[auto-rotate]').forEach(function(el){el.removeAttribute('auto-rotate');});}}catch(e){}})();";

const VIEWER_STYLE: CSSProperties = { width: "100%", height: "100%", backgroundColor: "transparent" };

/**
 * Renders the practice-supplied 3D model with the VENDORED, self-hosted
 * <model-viewer> component (/public/vendor/model-viewer, Apache-2.0; see the
 * NOTICE there). The script loads ONLY on pages whose content carries a
 * showcase3d section. Degrades cleanly: while loading (and wherever the script
 * or model cannot load, including no-JS) the poster image shows instead. In the
 * dashboard preview only the poster renders (no heavy script).
 */
function ShowcaseViewer({ showcase, preview }: { showcase: Showcase3d; preview?: boolean }) {
  const poster = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={showcase.posterUrl}
      alt={showcase.caption}
      className="h-full w-full rounded-2xl object-cover"
      loading="lazy"
    />
  );

  return (
    <figure className="mt-4">
      <div className="h-72 overflow-hidden rounded-2xl border border-line bg-card sm:h-80">
        {preview ? (
          <div className="h-full w-full">{poster}</div>
        ) : (
          <model-viewer
            src={showcase.modelUrl}
            poster={showcase.posterUrl}
            alt={showcase.caption}
            loading="lazy"
            reveal="auto"
            camera-controls
            auto-rotate
            shadow-intensity="0.6"
            touch-action="pan-y"
            interaction-prompt="none"
            style={VIEWER_STYLE}
          >
            {/* Shown until the element upgrades (slow script, blocked JS): a plain
                poster image, so the section never renders as an empty box. */}
            {poster}
          </model-viewer>
        )}
      </div>
      <figcaption className="mt-2 text-center text-xs text-muted">{showcase.caption}</figcaption>
      {preview ? null : (
        <>
          <script type="module" src="/vendor/model-viewer/model-viewer.min.js" async />
          {/* XSS-safe by construction: REDUCED_MOTION_SCRIPT is a static, hand
              authored module constant with no interpolation, so no user or model
              supplied data can ever reach this sink. React offers no other way to
              emit an inline script body from a server component. */}
          <script dangerouslySetInnerHTML={{ __html: REDUCED_MOTION_SCRIPT }} />
        </>
      )}
    </figure>
  );
}

/* ---------------------------------------------------------------------------
 * Shared bits
 * ------------------------------------------------------------------------- */

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="text-center">
      <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-blue-deep">{eyebrow}</p>
      <h2 className="mt-1.5 text-xl font-bold leading-tight text-navy [text-wrap:balance] sm:text-2xl">
        {title}
      </h2>
    </div>
  );
}

// Shared CTA button. A real link on the public page (tagged for the client
// tracker to wire the cta_clicked event); a non-navigating span in the preview.
function CtaButton({
  href,
  label,
  preview,
  large,
  inverted,
}: {
  href: string;
  label: string;
  preview?: boolean;
  large?: boolean;
  inverted?: boolean;
}) {
  const cls = [
    "inline-flex items-center justify-center rounded-xl font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2",
    large ? "min-h-13 px-8 text-base" : "min-h-12 px-6 text-base",
    inverted
      ? "bg-white text-blue-royal hover:bg-white/90 focus-visible:ring-white/60"
      : "bg-blue-royal text-white shadow-[0_4px_12px_rgba(28,102,184,0.28)] hover:bg-[#17579c] focus-visible:ring-blue-dark/40",
  ].join(" ");
  if (preview) {
    return (
      <span className={cls} aria-hidden>
        {label}
      </span>
    );
  }
  return (
    <a href={href} data-lp-cta className={cls}>
      {label}
    </a>
  );
}
