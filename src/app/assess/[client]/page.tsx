import { notFound } from "next/navigation";
import { AssessmentQuiz } from "@/components/assess/assessment-quiz";
import { getClient } from "@/lib/mock/clients";

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

  return (
    <AssessmentQuiz
      clientSlug={clientSlug}
      practiceName={clientRecord.name}
      style={style}
      previewMode={previewMode}
    />
  );
}
