// Human labels for lead/response `source` values, shared by the Leads worklist
// and the assessment tabs so attribution reads the same everywhere.
//
// Sources in the wild:
//   smile:<campaign-slug>  — Smile Assessment via a named campaign link/embed
//   quiz / smile-assessment — the generic Smile Assessment funnel
//   missed-call            — after-hours missed call bridged into a lead
//   web / webform          — the public intake endpoint (website form)

const FIXED: Record<string, string> = {
  "smile-assessment": "Smile Assessment",
  quiz: "Smile Assessment",
  "missed-call": "Missed call",
  web: "Website form",
  webform: "Website form",
};

export function sourceLabel(source: string | null | undefined): string {
  if (!source) return "Unknown";
  if (source.startsWith("smile:")) {
    const slug = source.slice("smile:".length);
    return slug ? `Smile Assessment · ${slug}` : "Smile Assessment";
  }
  return FIXED[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}
