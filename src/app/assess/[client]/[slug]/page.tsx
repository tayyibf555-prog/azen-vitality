import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AssessmentQuiz } from "@/components/assess/assessment-quiz";
import { getActiveCampaignBySlug } from "@/lib/smile-assessment/campaign-repository";
import { toPublicCampaign, toPublicFlow, type PublicFlow } from "@/lib/smile-assessment/campaign";
import { normaliseAndValidateFlow, describeFlowFailures } from "@/lib/smile-assessment/flow-validate";
import { isSystemEnabled } from "@/lib/systems/repository";
import { getClient } from "@/lib/mock/clients";
import { paletteVars, paletteVarsFrom } from "@/lib/assess/palette";
import { resolveCustomTheme } from "@/lib/assess/custom-theme-repository";
import { resolveMetaPixel } from "@/lib/assess/meta-pixel-repository";
import { publicMetaPixelId } from "@/lib/assess/meta-pixel";
import { MetaPixel } from "@/components/assess/meta-pixel";

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
  //
  // ---------------------------------------------------------------------------
  // ...AND SINCE 0081 THE SCHEME MAY BE THE PRACTICE'S OWN.
  //
  // `theme` now holds either a catalogue key or `custom:<uuid>`. The prefix is
  // what makes this cheap: resolveCustomTheme returns null WITHOUT A QUERY for
  // every preset campaign, so the only page that pays for a database read is one
  // actually wearing a custom scheme.
  //
  // THREE THINGS PROTECT THIS SURFACE, and none of them is the write path:
  //   1. resolveCustomTheme NEVER THROWS. A missing table (0081 not applied yet), a
  //      deleted theme, a transient error — all resolve to null, and the page falls
  //      through to paletteVars exactly as it does for a retired preset key. A
  //      colour is not worth a 500 on a page ad spend points at.
  //   2. THE GRAMMAR IS RE-CHECKED ON THE WAY OUT (readbackVars, inside the
  //      repository). The write path validated these values, but a hand-edited row,
  //      a restored backup or a later migration are all ways a value changes without
  //      going through it — and this line is the last thing before a stylesheet.
  //   3. paletteVarsFrom iterates the CLOSED token list, never the row's own keys,
  //      so a row carrying an unexpected key cannot add a custom property here.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // ...AND SINCE 0083 THE PAGE MAY ALSO CARRY THE PRACTICE'S META PIXEL.
  //
  // Read HERE, on the server, alongside the theme — and read as a whole config of
  // which exactly ONE FIELD is sent to the browser (publicMetaPixelId). The
  // advanced-matching switch stays on the server because it decides whether a
  // submitter's hashed contact details may leave it, and the Conversions API token
  // is not in this object at all.
  //
  // FOUR THINGS PROTECT THIS SURFACE, and, as with the theme, none of them is the
  // write path:
  //   1. resolveMetaPixel NEVER THROWS. A missing table (0083 not applied), a
  //      deleted row, a transient error — all resolve to "tracking off", and the
  //      page renders precisely what it renders today.
  //   2. publicMetaPixelId RETURNS null WHENEVER TRACKING IS OFF, so an id cannot
  //      reach the browser on a switched-off practice by any route.
  //   3. THE ID'S GRAMMAR IS RE-CHECKED ON THE WAY OUT (metaPixelConfig, inside the
  //      repository, and again in metaPixelScript). A hand-edited row cannot put
  //      anything but digits into a script tag.
  //   4. PREVIEW MODE TRACKS NOTHING. ?preview=1 is the owner looking at their own
  //      funnel from the builder; counting that as a visit would teach the ad
  //      account that staff are patients. The step beacon takes the same line.
  // ---------------------------------------------------------------------------
  const [custom, metaPixel] = await Promise.all([
    resolveCustomTheme(clientRecord.id, pub.theme),
    resolveMetaPixel(clientRecord.id),
  ]);
  const themeVars = custom ? paletteVarsFrom(custom.vars) : paletteVars(pub.theme);
  const metaPixelId = previewMode ? null : publicMetaPixelId(metaPixel);

  return (
    <div className="min-h-screen w-full bg-cream" style={themeVars as CSSProperties}>
      <AssessmentQuiz
        clientSlug={client}
        campaignSlug={slug}
        headline={pub.headline}
        intro={pub.intro}
        practiceName={clientRecord.name}
        style={style}
        previewMode={previewMode}
        flow={flow}
        // WHICH SAVE of the funnel the patient is looking at, for step-drop-off
        // telemetry only. Passed from the server so the browser cannot claim a
        // version, and passed alongside `flow` so the two can never describe
        // different saves. Absent flow means no deterministic runtime and no
        // beacon, so this is inert on every adaptive session.
        flowVersion={campaign.flowVersion}
      />
      <MetaPixel pixelId={metaPixelId} />
    </div>
  );
}
