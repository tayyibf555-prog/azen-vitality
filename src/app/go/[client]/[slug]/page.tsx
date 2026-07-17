import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getClient } from "@/lib/mock/clients";
import { TREATMENTS } from "@/lib/treatments/catalog";
import { getLivePageBySlug, getPageBySlug } from "@/lib/landing/repository";
import { verifyPreviewToken } from "@/lib/landing/preview-token";
import { assignVariant, coinToss, variantCookieName, variantCookiePath } from "@/lib/landing/assignment";
import type { LandingPageVariant } from "@/lib/landing/types";
import type { VariantKey } from "@/lib/landing/winner";
import { LandingContent } from "@/components/landing/landing-content";
import { LandingTracker } from "@/components/landing/landing-tracker";

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

  const content = (
    <LandingContent
      content={chosen.content}
      practiceName={record.name}
      clientSlug={client}
      landingSlug={slug}
      variant={variant}
      siteId={found.page.siteId}
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
