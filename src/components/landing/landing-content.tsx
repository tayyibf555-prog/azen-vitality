import { Check, ShieldCheck } from "lucide-react";
import type { LandingPageContent } from "@/lib/landing/content";
import type { VariantKey } from "@/lib/landing/winner";
import { buildCtaHref } from "@/lib/landing/links";

// The ONE vetted renderer for landing-page content. PURE and presentational: no
// "use client", no hooks, no function props, so it is safe to render from the
// public server page AND from the client-side dashboard preview (the RSC
// shared-component boundary is only a problem for components that take function
// props; this takes none). All copy comes from a lint-passed content object, so
// no free-form model output ever reaches the DOM as markup.
//
// Mobile-first, on-brand with the assess pages (cream page, soft cards, navy ink,
// blue accents). British English, GBP.

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});

interface Props {
  content: LandingPageContent;
  practiceName: string;
  clientSlug: string;
  landingSlug: string;
  variant: VariantKey;
  siteId?: string | null;
  /**
   * Preview mode (dashboard): render the CTA as a non-navigating span so clicks in
   * the small preview do nothing and fire no attribution. Public pages omit this.
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
  preview,
}: Props) {
  const href = buildCtaHref({ clientSlug, cta: content.cta, variant, landingSlug, siteId });

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6 sm:py-10">
      {/* Brand lockup */}
      <header className="mb-6 flex items-center justify-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line bg-card shadow-[0_2px_10px_rgba(10,14,26,0.08)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/copilot-logo.png" alt={`${practiceName} logo`} width={26} height={26} className="h-[26px] w-[26px] object-contain" />
        </span>
        <p className="text-sm font-bold tracking-tight text-navy">{practiceName}</p>
      </header>

      {/* Hero */}
      <section className="text-center">
        <h1 className="text-2xl font-bold leading-tight text-navy [text-wrap:balance] sm:text-3xl">
          {content.hero.headline}
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-ink sm:text-base">
          {content.hero.subhead}
        </p>
        <div className="mt-5">
          <CtaButton href={href} label={content.cta.label} preview={preview} />
        </div>
      </section>

      {/* Benefits */}
      <section className="mt-8 grid gap-3 sm:grid-cols-3">
        {content.benefits.map((b, i) => (
          <div key={i} className="rounded-2xl border border-line bg-card p-4 shadow-[0_1px_2px_rgba(10,14,26,0.04)]">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-dark/10 text-blue-dark">
              <Check size={16} strokeWidth={2.5} />
            </span>
            <h2 className="mt-2.5 text-sm font-semibold text-navy">{b.title}</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink">{b.detail}</p>
          </div>
        ))}
      </section>

      {/* Pricing */}
      <section className="mt-6 rounded-2xl border border-line bg-card p-5 shadow-[0_1px_2px_rgba(10,14,26,0.04)]">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Pricing</h2>
        <ul className="mt-3 divide-y divide-line">
          {content.pricing.lines.map((l, i) => (
            <li key={i} className="flex items-baseline justify-between gap-4 py-2">
              <span className="text-sm font-medium text-navy">{l.treatment}</span>
              <span className="text-sm font-semibold tabular-nums text-navy">
                from {GBP.format(l.fromPriceGBP)}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs leading-relaxed text-muted">{content.pricing.caveat}</p>
      </section>

      {/* FAQs */}
      <section className="mt-6 space-y-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Common questions</h2>
        {content.faqs.map((f, i) => (
          <div key={i} className="rounded-2xl border border-line bg-card p-4 shadow-[0_1px_2px_rgba(10,14,26,0.04)]">
            <h3 className="text-sm font-semibold text-navy">{f.q}</h3>
            <p className="mt-1 text-xs leading-relaxed text-ink">{f.a}</p>
          </div>
        ))}
      </section>

      {/* Closing CTA */}
      <div className="mt-8 text-center">
        <CtaButton href={href} label={content.cta.label} preview={preview} />
      </div>

      {/* GDC/ASA-safe footer: the required suitability line, no testimonials. */}
      <p className="mx-auto mt-6 flex max-w-md items-start justify-center gap-1.5 px-2 text-center text-[0.65rem] leading-relaxed text-muted">
        <ShieldCheck size={13} className="mt-px shrink-0 text-blue-deep" aria-hidden />
        <span>
          Our dentists are GDC registered. Treatment suitability always depends on a clinical
          assessment.
        </span>
      </p>
    </main>
  );
}

// Shared button. A real link on the public page (tagged for the client tracker to
// wire the cta_clicked event); a non-navigating span in the dashboard preview.
function CtaButton({ href, label, preview }: { href: string; label: string; preview?: boolean }) {
  const cls =
    "inline-flex min-h-12 items-center justify-center rounded-xl bg-blue-royal px-6 text-base font-semibold text-white shadow-[0_4px_12px_rgba(28,102,184,0.28)] transition-colors hover:bg-[#17579c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40";
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
