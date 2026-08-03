import { patientTab, type PatientTabSlug } from "@/lib/patient/tabs";

/**
 * The panel for something we cannot fill: the Medical and Perio TABS, and now any
 * REGION of a tab that Dentally holds and we cannot read (BPE, periodontal, chart
 * images, the cloud gallery, socket-level tooth status).
 *
 * It renders the copy from lib/patient/tabs.ts VERBATIM and adds nothing. The words
 * are clinical-safety sentences and they live in a tested module for that reason;
 * this component's only job is to put them on the screen legibly.
 *
 * TWO ENTRY POINTS, ONE PANEL. `{ slug }` is the original tab path and is unchanged
 * in what it renders. `{ title, cannotRead, willHold }` is the region path, added so
 * the chart can say the same thing in the same shape without a near-duplicate
 * component: two panels would drift in type scale and surface inside a release, and
 * the point of this file is that every "we cannot read this" on a patient record
 * looks and reads identically.
 *
 * WHAT IT MUST NEVER DO. It must never render as an empty state. An empty shell on a
 * Medical tab reads as "this patient has no medical history", which is a fabrication
 * a clinician could act on. The first line is a plain, unmissable statement that we
 * cannot read it; the second says what it will hold once we can, so it is not a dead
 * end.
 *
 * There is no warning colour here on purpose. This is a permanent property of the
 * connection, not an incident, and amber on a permanent condition trains people to
 * ignore amber. The weight comes from the type, not from a tint.
 */
export type UnavailablePanelProps =
  | { slug: PatientTabSlug; children?: React.ReactNode }
  | {
      title: string;
      cannotRead: string;
      /** What this will hold. A node rather than a string, so a region covering two
       *  unreadable things (BPE and periodontal) can state both. */
      willHold: React.ReactNode;
      children?: React.ReactNode;
    };

export function UnavailablePanel(props: UnavailablePanelProps) {
  // Branched on the discriminant rather than resolved through ternaries, so TypeScript
  // narrows and the two entry points cannot half-mix at a call site.
  if ("slug" in props) {
    const tab = patientTab(props.slug);
    return (
      <Panel title={tab.label} cannotRead={tab.cannotRead} willHold={tab.willHold}>
        {props.children}
      </Panel>
    );
  }
  return (
    <Panel title={props.title} cannotRead={props.cannotRead} willHold={props.willHold}>
      {props.children}
    </Panel>
  );
}

function Panel({
  title,
  cannotRead,
  willHold,
  children,
}: {
  title: string;
  cannotRead: string;
  willHold: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="max-w-2xl space-y-3 rounded-xl border border-line bg-card-muted/40 px-5 py-5">
      <h3 className="text-[14px] font-semibold tracking-[-0.1px] text-navy">{title}</h3>
      <p className="text-[13.5px] font-medium leading-[1.5] text-ink">{cannotRead}</p>
      <div className="space-y-2 text-[12.5px] leading-[1.5] text-muted">{willHold}</div>
      {children}
    </section>
  );
}
