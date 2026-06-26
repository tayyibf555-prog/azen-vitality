"use client";

import { useParams } from "next/navigation";
import { AssessmentQuiz } from "@/components/assess/assessment-quiz";

// Public, embeddable Smile Assessment quiz (generic). A thin client wrapper: it
// reads the [client] slug from the URL and hands it to the shared quiz. No auth,
// no SSR data fetch — the slug is used only to brand and to resolve the practice
// server-side. The campaign landing page (/assess/<client>/<slug>) reuses the same
// quiz with campaign framing.

export default function SmileAssessmentPage() {
  const params = useParams<{ client: string }>();
  const clientSlug = typeof params.client === "string" ? params.client : "";

  return <AssessmentQuiz clientSlug={clientSlug} />;
}
