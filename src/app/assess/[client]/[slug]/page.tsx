import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AssessmentQuiz } from "@/components/assess/assessment-quiz";
import { getActiveCampaignBySlug } from "@/lib/smile-assessment/campaign-repository";
import { toPublicCampaign } from "@/lib/smile-assessment/campaign";
import { getClient } from "@/lib/mock/clients";

// Public campaign landing page (/assess/<client>/<slug>). The ad destination for a
// Smile Assessment CAMPAIGN: it reuses the generic quiz, but framed by the
// campaign's headline/intro and attributing the submission to the campaign.
//
// SERVER component: it resolves the practice and the active campaign (service-role
// reads via the repository), then passes ONLY safe public fields down to the
// client quiz. A missing practice or campaign 404s. The /assess/* paths are public
// (the proxy gates only /agency, /owner, /c/*).

export const dynamic = "force-dynamic";

interface Params {
  client: string;
  slug: string;
}
type Search = Promise<{ [key: string]: string | string[] | undefined }>;

function firstParam(v: string | string[] | undefined): string | undefined {
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { client, slug } = await params;

  // Per-campaign browser tab title only (no sitemap/robots — intentionally not
  // needed). Fall back to a generic title rather than throwing if anything is
  // missing, so the page can still render its own notFound().
  const clientRecord = getClient(client);
  if (!clientRecord) return { title: "Smile Assessment" };

  // A transient read error must never 500 a public, paid ad-destination URL; fall
  // back to a generic title (the page body separately degrades to notFound()).
  try {
    const campaign = await getActiveCampaignBySlug(clientRecord.id, slug);
    if (!campaign) return { title: `Smile Assessment | ${clientRecord.name}` };
    const pub = toPublicCampaign(campaign);
    // Patient-facing headline only; the internal campaign name is never exposed.
    return {
      title: `${pub.headline || "Smile Assessment"} | ${clientRecord.name}`,
      description: pub.intro || pub.headline || undefined,
    };
  } catch {
    return { title: `Smile Assessment | ${clientRecord.name}` };
  }
}

export default async function CampaignAssessmentPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Search;
}) {
  const { client, slug } = await params;

  const clientRecord = getClient(client);
  if (!clientRecord) notFound();

  // Degrade a transient read error to a clean 404 rather than a 500.
  let campaign = null;
  try {
    campaign = await getActiveCampaignBySlug(clientRecord.id, slug);
  } catch {
    campaign = null;
  }
  if (!campaign) notFound();

  const pub = toPublicCampaign(campaign);

  // ?style=guided opts into the premium Guided quiz; anything else (including
  // absent) stays Classic. ?preview=1 is the internal admin live-preview flag:
  // it never gates access (this campaign is already public/active either way),
  // it only tells the quiz to no-op telemetry and disable the final submit.
  const sp = await searchParams;
  const style = firstParam(sp.style) === "guided" ? "guided" : "classic";
  const previewMode = firstParam(sp.preview) === "1";

  return (
    <AssessmentQuiz
      clientSlug={client}
      campaignSlug={slug}
      headline={pub.headline}
      intro={pub.intro}
      practiceName={clientRecord.name}
      style={style}
      previewMode={previewMode}
    />
  );
}
