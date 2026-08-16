import { notFound } from "next/navigation";
import { AssessmentQuiz } from "@/components/assess/assessment-quiz";
import { MetaPixel } from "@/components/assess/meta-pixel";
import { getClient } from "@/lib/mock/clients";
import { resolveMetaPixel } from "@/lib/assess/meta-pixel-repository";
import { publicMetaPixelId } from "@/lib/assess/meta-pixel";
import { isSystemEnabledStrict } from "@/lib/systems/repository";

// Public, embeddable Smile Assessment quiz (generic, no campaign framing). A
// SERVER component: it resolves the [client] slug and the ?style/?preview query
// params from the URL, then hands everything to the shared quiz. No auth, no
// other SSR data fetch — the slug brands the funnel and resolves the practice.
// The campaign landing page (/assess/<client>/<slug>) reuses the same quiz with
// campaign framing (and the identical style/preview handling).

export const dynamic = "force-dynamic";

interface Params {
  client: string;
}
type Search = Promise<{ [key: string]: string | string[] | undefined }>;

function firstParam(v: string | string[] | undefined): string | undefined {
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
}

export default async function SmileAssessmentPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Search;
}) {
  const { client: clientSlug } = await params;
  const clientRecord = getClient(clientSlug);
  if (!clientRecord) notFound();

  // ?style=guided opts into the premium Guided quiz; anything else (including
  // absent) stays Classic. ?preview=1 is the internal admin live-preview flag:
  // it tells the quiz to no-op telemetry and disable the final submit.
  const sp = await searchParams;
  const style = firstParam(sp.style) === "guided" ? "guided" : "classic";
  const previewMode = firstParam(sp.preview) === "1";

  // THE PRACTICE'S META PIXEL (0083), read on the server and reduced to the one
  // field a browser is allowed to know. This page is the same public funnel as the
  // campaign one and is just as likely to be an ad destination, so it carries the
  // same tracking and — more to the point — the same consent gate. Off unless the
  // practice configured it; silent unless this visitor agrees; never in preview,
  // which is an owner looking at their own funnel rather than a patient.
  //
  // AND BEHIND THE KILL SWITCH, WHICH THIS PAGE OTHERWISE DOES NOT CHECK.
  //
  // The campaign page (/assess/<client>/<slug>) 404s outright when
  // `smile-assessment` is switched off, so by the time it reaches its own pixel the
  // switch is provably on. This page has no such check — a gap that predates this
  // feature and belongs to whoever closes it — and the rule for a NEW public
  // surface is that it honours the switch itself rather than inheriting somebody
  // else's. So the pixel is gated here even though the quiz around it is not.
  //
  // STRICT, uniquely on this line. `isSystemEnabled` fails OPEN, which is right for
  // a page whose failure mode is a 404 on a live funnel; the failure mode HERE is a
  // third-party request nobody sanctioned, so a systems read that errors must mean
  // "no pixel". Nothing about the quiz depends on this answer.
  const metaPixelId =
    previewMode || !(await isSystemEnabledStrict(clientRecord.id, "smile-assessment"))
      ? null
      : publicMetaPixelId(await resolveMetaPixel(clientRecord.id));

  return (
    <>
      <AssessmentQuiz
        clientSlug={clientSlug}
        practiceName={clientRecord.name}
        style={style}
        previewMode={previewMode}
      />
      <MetaPixel pixelId={metaPixelId} />
    </>
  );
}
