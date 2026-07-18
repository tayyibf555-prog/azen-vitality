import { LineChart, Layers, Repeat } from "lucide-react";
import { PageHeader, SectionCard, EmptyState } from "@/components/primitives";
import { getClient } from "@/lib/mock";

// ROI (growth) section: how patient-acquisition spend turns into leads, booked
// patients and treatment revenue across every channel, with cost per new patient
// and return on spend. There is no live source for these figures yet, so rather
// than invent them the page shows its structure and an honest awaiting state: the
// dashboard builds from live lead and booking data, and from Meta ad spend once the
// account is linked. The page and its navigation stay in place so it lights up the
// day the sources connect.
export function RoiView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="ROI" description="This client could not be found." />;
  }

  return (
    <>
      <PageHeader
        title="ROI"
        description="How your patient-acquisition spend turns into booked patients and treatment revenue across every channel."
      />

      <EmptyState
        icon={LineChart}
        title="Your ROI dashboard builds from live activity"
        description="Spend, new patients, cost per new patient and return on spend appear here as your live sources connect: lead and booking data from the platform, and ad spend once your Meta account is linked. No figures are shown until they are real."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="Acquisition funnel" description="What it will show">
          <div className="flex items-start gap-2.5">
            <Layers size={16} className="mt-0.5 shrink-0 text-muted" />
            <p className="text-sm leading-relaxed text-ink">
              Enquiries narrowing to consultations booked, then attended, then treatment accepted,
              then new patients, with the conversion at each step. It builds from your live lead and
              booking data.
            </p>
          </div>
        </SectionCard>

        <SectionCard title="Channel breakdown" description="What it will show">
          <div className="flex items-start gap-2.5">
            <LineChart size={16} className="mt-0.5 shrink-0 text-muted" />
            <p className="text-sm leading-relaxed text-ink">
              Spend, leads, new patients, cost per new patient and return on spend for every channel,
              so you can see which is working. Paid figures connect once your Meta account is linked.
            </p>
          </div>
        </SectionCard>

        <SectionCard title="Growth trend" description="What it will show">
          <div className="flex items-start gap-2.5">
            <Repeat size={16} className="mt-0.5 shrink-0 text-muted" />
            <p className="text-sm leading-relaxed text-ink">
              Spend against attributed revenue over time, with new patients per month, so you can see
              the growth curve as the months of live activity accrue.
            </p>
          </div>
        </SectionCard>
      </div>
    </>
  );
}
