// Human labels for lead/response `source` values, shared by the Leads worklist
// and the assessment tabs so attribution reads the same everywhere.
//
// Sources in the wild:
//   smile:<campaign-slug>  — Smile Assessment via a named campaign link/embed
//   quiz / smile-assessment — the generic Smile Assessment funnel
//   missed-call            — after-hours missed call bridged into a lead
//   web / webform          — the public intake endpoint (website form)
//   abandoned-booking      — started the online booking but did not confirm

const FIXED: Record<string, string> = {
  "smile-assessment": "Smile Assessment",
  quiz: "Smile Assessment",
  "missed-call": "Missed call",
  web: "Website form",
  webform: "Website form",
  "abandoned-booking": "Abandoned booking",
};

export function sourceLabel(source: string | null | undefined): string {
  if (!source) return "Unknown";
  if (source.startsWith("smile:")) {
    const slug = source.slice("smile:".length);
    return slug ? `Smile Assessment · ${slug}` : "Smile Assessment";
  }
  // landing:<page-slug>, a lead from one of the bespoke treatment landing pages.
  // The worklist showed the raw value ("landing:invisalign"), which reads as debug
  // output to the staff member trying to work out where the enquiry came from.
  if (source.startsWith("landing:")) {
    const slug = source.slice("landing:".length);
    if (!slug) return "Landing page";
    const name = slug.replace(/[-_]+/g, " ").trim();
    return name ? `${name.charAt(0).toUpperCase()}${name.slice(1)} landing page` : "Landing page";
  }
  return FIXED[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}
