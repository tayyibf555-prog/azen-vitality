import { patientTab, type PatientTabSlug } from "@/lib/patient/tabs";

/**
 * The panel for a tab we cannot fill: Medical, Chart and Perio.
 *
 * It renders the copy from lib/patient/tabs.ts VERBATIM and adds nothing. The words
 * are clinical-safety sentences and they live in a tested module for that reason;
 * this component's only job is to put them on the screen legibly.
 *
 * WHAT IT MUST NEVER DO. It must never render as an empty state. An empty shell on a
 * Medical tab reads as "this patient has no medical history", which is a fabrication
 * a clinician could act on. The first line is a plain, unmissable statement that we
 * cannot read it; the second says what the tab will hold once we can, so the tab is
 * not a dead end.
 *
 * There is no warning colour here on purpose. This is a permanent property of the
 * connection, not an incident, and amber on a permanent condition trains people to
 * ignore amber. The weight comes from the type, not from a tint.
 */
export function UnavailablePanel({ slug }: { slug: PatientTabSlug }) {
  const tab = patientTab(slug);
  return (
    <section className="max-w-2xl space-y-3 rounded-xl border border-line bg-card-muted/40 px-5 py-5">
      <h3 className="text-[14px] font-semibold tracking-[-0.1px] text-navy">{tab.label}</h3>
      <p className="text-[13.5px] font-medium leading-[1.5] text-ink">{tab.cannotRead}</p>
      <p className="text-[12.5px] leading-[1.5] text-muted">{tab.willHold}</p>
    </section>
  );
}
