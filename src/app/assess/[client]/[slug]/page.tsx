import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AssessmentQuiz } from "@/components/assess/assessment-quiz";
import { getActiveCampaignBySlug } from "@/lib/smile-assessment/campaign-repository";
import { toPublicCampaign, toPublicFlow, type PublicFlow } from "@/lib/smile-assessment/campaign";
import { normaliseAndValidateFlow, describeFlowFailures } from "@/lib/smile-assessment/flow-validate";
import { isSystemEnabled } from "@/lib/systems/repository";
import { getClient } from "@/lib/mock/clients";
import { paletteVars } from "@/lib/assess/palette";

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

  // THE KILL SWITCH, checked on the PAGE and not only in the API.
  //
  // The owner-only per-system switch for `smile-assessment` was enforced in two
  // places: /api/smile-assessment/next (next/route.ts:192) and at submit
  // (submit/route.ts:266). Both are things the ADAPTIVE quiz calls. A funnel that
  // walks an authored graph never calls /next at all, so with the switch off it
  // would happily ask every question and only fail at the last step, after the
  // patient had typed their name and number in. Turning a system off has to mean
  // the door is shut, so the check belongs here, before anything renders.
  if (!(await isSystemEnabled(clientRecord.id, "smile-assessment"))) notFound();

  // Degrade a transient read error to a clean 404 rather than a 500.
  let campaign = null;
  try {
    campaign = await getActiveCampaignBySlug(clientRecord.id, slug);
  } catch {
    campaign = null;
  }
  if (!campaign) notFound();

  const pub = toPublicCampaign(campaign);

  // THE AUTHORED FUNNEL, if this campaign has one that is published AND still
  // valid. Both halves matter and neither is redundant:
  //
  //   published  the owner said so. There is no draft campaign status to hide a
  //              half-built funnel behind (0060), so the boolean is the gate.
  //   valid      re-checked HERE, on every request, not trusted from the write
  //              that stored it. quiz.ts can lose a question, the schema can move,
  //              a row can be edited by hand. Validating at read is what makes any
  //              of that a fallback instead of a broken quiz.
  //
  // Anything short of both, and the page serves the adaptive funnel, which always
  // works. It is never an empty screen and never a half-funnel: the whole point of
  // normaliseFlow being all-or-nothing (flow.ts) is that there is no middle state
  // to render. The reason is logged, because a funnel silently not running is
  // exactly the failure an owner would never notice.
  let flow: PublicFlow | null = null;
  if (campaign.flowPublished) {
    const checked = normaliseAndValidateFlow(campaign.flow);
    if (checked.graph) {
      flow = toPublicFlow(checked.graph);
      if (!flow) {
        console.warn(
          `[assess] ${client}/${slug}: funnel v${campaign.flowVersion} names a question that is no longer in the bank; using the adaptive funnel`,
        );
      }
    } else {
      console.warn(
        `[assess] ${client}/${slug}: published funnel v${campaign.flowVersion} did not validate; using the adaptive funnel\n${describeFlowFailures(checked.result.failures)}`,
      );
    }
  }

  // ?style=guided opts into the premium Guided quiz; anything else (including
  // absent) stays Classic. ?preview=1 is the internal admin live-preview flag:
  // it never gates access (this campaign is already public/active either way),
  // it only tells the quiz to no-op telemetry and disable the final submit.
  const sp = await searchParams;
  const style = firstParam(sp.style) === "guided" ? "guided" : "classic";
  const previewMode = firstParam(sp.preview) === "1";

  // THE COLOUR SCHEME, applied HERE and not inside the quiz.
  //
  // globals.css maps its brand tokens into Tailwind with `@theme inline`, so
  // `text-navy` compiles to `color: var(--navy)` — the raw token. Re-declaring
  // those tokens on a wrapper therefore re-themes every utility beneath it, and
  // the three quiz components need no theming code at all. paletteVars falls
  // back to the shipped values for null and for anything it does not recognise,
  // so this wrapper is a no-op on a campaign that never chose a scheme.
  //
  // WHY THE WRAPPER IS HERE AND CARRIES ITS OWN min-h-screen AND BACKGROUND.
  // The page background is painted by the assess LAYOUT (`min-h-screen bg-cream`),
  // which is above this page and shared with the un-campaigned /assess/<client>
  // quiz — so it cannot be themed per campaign. The quiz roots below are centred
  // and width-capped, so vars set there would leave the page's gutters in the old
  // colour: a teal card floating on a blue-grey page. This element sits between
  // the two, tall enough and wide enough to be the background the patient sees.
  // (The cast is because paletteVars is React-free by design and returns a plain
  // string map; CSS custom properties are not in React's CSSProperties.)
  return (
    <div className="min-h-screen w-full bg-cream" style={paletteVars(pub.theme) as CSSProperties}>
      <AssessmentQuiz
        clientSlug={client}
        campaignSlug={slug}
        headline={pub.headline}
        intro={pub.intro}
        practiceName={clientRecord.name}
        style={style}
        previewMode={previewMode}
        flow={flow}
      />
    </div>
  );
}
