import type { Metadata } from "next";
import type { ComponentType } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getClient } from "@/lib/mock/clients";
import { TREATMENTS } from "@/lib/treatments/catalog";
import { getLivePageBySlug, getPageBySlug } from "@/lib/landing/repository";
import { verifyPreviewToken } from "@/lib/landing/preview-token";
import { assignVariant, coinToss, variantCookieName, variantCookiePath } from "@/lib/landing/assignment";
import { resolveEffectiveSite } from "@/lib/landing/site";
import type { LandingPageVariant } from "@/lib/landing/types";
import type { VariantKey } from "@/lib/landing/winner";
import { LandingContent } from "@/components/landing/landing-content";
import { LandingTracker } from "@/components/landing/landing-tracker";
import { getBespokeTemplate } from "@/lib/landing/bespoke/registry";
import { VitalityInvisalignLanding } from "@/components/landing/bespoke/vitality-invisalign-landing";
import { VitalityBondingLanding } from "@/components/landing/bespoke/vitality-bonding-landing";
import { VitalityHygieneLanding } from "@/components/landing/bespoke/vitality-hygiene-landing";
import { VitalityWhiteningLanding } from "@/components/landing/bespoke/vitality-whitening-landing";
import { VitalityVeneersLanding } from "@/components/landing/bespoke/vitality-veneers-landing";
import { VitalityImplantLanding } from "@/components/landing/bespoke/vitality-implant-landing";
import { VitalityCheckupLanding } from "@/components/landing/bespoke/vitality-checkup-landing";

// The props every bespoke landing component takes. The /go seam passes these
// identically regardless of which template renders.
type BespokeLandingProps = {
  variant: VariantKey;
  clientSlug: string;
  landingSlug: string;
  siteId?: string | null;
  practiceName: string;
};

// templateId -> the ONE bespoke server component that renders it. Adding a bespoke
// page is: register it (registry.ts), author its component, and list it here. The
// registry drives which (client, slug) is bespoke; this map drives which design.
const BESPOKE_COMPONENTS: Record<string, ComponentType<BespokeLandingProps>> = {
  "vitality-invisalign": VitalityInvisalignLanding,
  "vitality-bonding": VitalityBondingLanding,
  "vitality-hygiene": VitalityHygieneLanding,
  "vitality-whitening": VitalityWhiteningLanding,
  "vitality-veneers": VitalityVeneersLanding,
  "vitality-implant": VitalityImplantLanding,
  "vitality-checkup": VitalityCheckupLanding,
};

// Public campaign landing page (/go/<client>/<slug>). The ad destination for a
// custom landing page: it loads the LIVE page, assigns the visitor a sticky 50/50
// variant (or serves the promoted winner), and renders the ONE vetted content
// component. A DRAFT renders only with a valid preview token, so the owner can
// preview safely before publishing. Unknown or archived slugs 404 cleanly.
//
// SERVER component. Reads cookies (dynamic) to keep a returning visitor on the
// same variant. The /go/* paths are public (proxy gates only /agency, /owner, /c/*).

export const dynamic = "force-dynamic";

interface Params {
  client: string;
  slug: string;
}
type Search = Promise<{ [key: string]: string | string[] | undefined }>;

function firstParam(v: string | string[] | undefined): string | undefined {
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { client, slug } = await params;
  const record = getClient(client);
  if (!record) return { title: "Vitality Dental" };
  // Bespoke pages have a fixed, hand-authored title (the design does not render
  // from the DB content the generic metadata reads). The title uses the catalogue
  // treatment NAME, so it is "Invisalign | ..." / "Composite bonding | ..." etc.
  const bespoke = getBespokeTemplate(record.id, slug);
  if (bespoke) {
    const treatmentName = TREATMENTS.find((t) => t.key === bespoke.treatment)?.name ?? record.name;
    return {
      title: `${treatmentName} | ${record.name}`,
      description: bespoke.variants.a.heroSubhead,
    };
  }
  try {
    const found = await getLivePageBySlug(record.id, slug);
    const headline = found?.variants[0]?.content.hero.headline;
    return {
      title: headline ? `${headline} | ${record.name}` : record.name,
      description: found?.variants[0]?.content.hero.subhead || undefined,
    };
  } catch {
    return { title: record.name };
  }
}

/** Pick the servable variant row for the chosen key, avoiding retired variants. */
function pickVariant(variants: LandingPageVariant[], key: VariantKey): LandingPageVariant | null {
  return (
    variants.find((v) => v.variantKey === key && v.status !== "retired") ??
    variants.find((v) => v.status !== "retired") ??
    variants[0] ??
    null
  );
}

export default async function LandingPageRoute({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Search;
}) {
  const { client, slug } = await params;
  const record = getClient(client);
  if (!record) notFound();

  const sp = await searchParams;
  const previewToken = firstParam(sp.preview);

  // Live first; degrade a transient read error to a clean 404 rather than a 500.
  let found = null;
  try {
    found = await getLivePageBySlug(record.id, slug);
  } catch {
    found = null;
  }

  // A draft is servable only with a matching preview token (owner preview).
  let isPreview = false;
  if (!found && previewToken) {
    try {
      const any = await getPageBySlug(record.id, slug);
      if (any && any.page.status === "draft" && verifyPreviewToken(previewToken, any.page.id)) {
        found = any;
        isPreview = true;
      }
    } catch {
      found = null;
    }
  }

  if (!found) notFound();

  // Variant selection.
  let variant: VariantKey;
  let cookieToSet: { name: string; path: string } | null = null;
  if (isPreview) {
    // Preview honours ?v=a|b (default a) and never sets a bucket cookie.
    variant = firstParam(sp.v) === "b" ? "b" : "a";
  } else if (firstParam(sp.v) === "a" || firstParam(sp.v) === "b") {
    // Explicit ?v=a|b on a live page: force that variant for THIS render only (no
    // bucket cookie). Powers the console preview's variant switcher; a visitor
    // arriving on such a link simply sees, and is counted for, that variant.
    variant = firstParam(sp.v) as VariantKey;
  } else {
    const cookieStore = await cookies();
    const cookieName = variantCookieName(found.page.id);
    const existing = cookieStore.get(cookieName)?.value;
    const assignment = assignVariant(existing, coinToss(), found.page.winnerVariant);
    variant = assignment.variant;
    if (assignment.setCookie) {
      cookieToSet = { name: cookieName, path: variantCookiePath(client, slug) };
    }
  }

  const chosen = pickVariant(found.variants, variant);
  if (!chosen) notFound();
  // Serve the variant we will actually render (pickVariant may fall back).
  variant = chosen.variantKey;

  // An explicit ?site=<internalSiteId> lets ONE published page route its leads to
  // a different practice site than the page's own configured site (e.g. the same
  // Invisalign page linked from three sites' ad campaigns), without duplicating
  // the page. Honoured ONLY when it names a site that belongs to THIS client; a
  // foreign or unknown value is ignored silently and the page's own configured
  // site stands. `sp` is already resolved above, so this works for both the live
  // and the preview path.
  const requestedSiteId = firstParam(sp.site);
  const effectiveSiteId = resolveEffectiveSite(record.id, requestedSiteId, found.page.siteId);

  // A registered bespoke (hand-designed) template renders its own server component
  // INSTEAD of the generic renderer, picked by templateId. Everything around it is
  // unchanged: the same sticky A/B variant, the same preview banner path, and the
  // same LandingTracker wrapper (each bespoke component emits the same
  // data-lp-section / data-lp-cta markers the tracker relies on). The bespoke
  // component reads its per-variant copy from the registry, not from chosen.content.
  const bespoke = getBespokeTemplate(record.id, slug);
  const BespokeComponent = bespoke ? BESPOKE_COMPONENTS[bespoke.templateId] : undefined;
  const content = BespokeComponent ? (
    <BespokeComponent
      variant={variant}
      clientSlug={client}
      landingSlug={slug}
      siteId={effectiveSiteId}
      practiceName={record.name}
    />
  ) : (
    <LandingContent
      content={chosen.content}
      practiceName={record.name}
      clientSlug={client}
      landingSlug={slug}
      variant={variant}
      siteId={effectiveSiteId}
      // OWNER-VERIFIED facts from practice configuration: the ONLY source the
      // proof stats row / awards line / press mentions can render from.
      practiceFacts={record.facts ?? null}
      treatmentName={TREATMENTS.find((t) => t.key === found.page.treatment)?.name}
    />
  );

  // In preview, skip tracking entirely (it is not a real visit).
  if (isPreview) {
    return (
      <>
        <div className="mx-auto max-w-2xl px-4 pt-4">
          <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-center text-xs font-semibold text-[#9a6700]">
            Preview, variant {variant.toUpperCase()}. This draft is not public until you publish it.
          </p>
        </div>
        {content}
      </>
    );
  }

  return (
    <LandingTracker clientSlug={client} landingSlug={slug} variant={variant} cookie={cookieToSet}>
      {content}
    </LandingTracker>
  );
}
