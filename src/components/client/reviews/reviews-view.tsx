import { PageHeader, StatCard } from "@/components/primitives";
import { getClient, getSites } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { listAppointments } from "@/lib/dentally/read";
import { listByAppointments } from "@/lib/reviews/repository";
import type { ReviewRequest } from "@/lib/reviews/types";
import { ReviewsWorkspace, type SiteName } from "./reviews-workspace";

// Reviews & reputation section.
//
// After each appointment, staff mark who attended; a Google review request is then
// sent automatically a few hours later or the next morning through the consent-aware
// messaging layer. Consent and opt-outs are always respected. Requesting Google
// reviews is allowed and is kept separate from using testimonials in ads. Data is
// mock and messages are in test mode until go-live.
//
// The server view derives the headline numbers by mirroring the read the
// /api/reviews/today route does (today's appointments + their review requests), so
// the StatCards match what the workspace shows once it fetches on the client.
export async function ReviewsView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Reviews" description="This client could not be found." />;
  }

  const siteIds = await getViewSiteIds(client.id);
  const sites = getSites(client.id).filter((s) => siteIds.includes(s.id));
  const siteNames: SiteName[] = sites.map((s) => ({ id: s.id, name: s.name }));

  const today = new Date().toISOString().slice(0, 10);

  let requests: ReviewRequest[] = [];
  let attendedToday = 0;
  try {
    const appts = await listAppointments(siteIds, { from: today, to: today });
    requests = await listByAppointments(appts.map((a) => a.id));
    // "Attended today" = appointments with a review request raised today (a request
    // only exists once the appointment has been marked attended).
    attendedToday = requests.length;
  } catch {
    requests = [];
  }

  const scheduled = requests.filter((r) => r.status === "scheduled").length;
  const sent = requests.filter((r) => r.status === "sent").length;
  const optedOut = requests.filter(
    (r) => r.status === "skipped" || r.status === "suppressed",
  ).length;

  return (
    <>
      <PageHeader
        title="Reviews"
        description="After each appointment, mark who attended and a Google review request is sent automatically a few hours later or the next morning. Consent and opt-outs are always respected. Requesting Google reviews is allowed and is separate from using testimonials in ads. Data is mock and messages are in test mode until go-live."
      />

      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <StatCard
          label="Attended today"
          value={attendedToday}
          dot="bg-status-blue"
          hint="Marked seen so far"
        />
        <StatCard
          label="Requests scheduled"
          value={scheduled}
          dot="bg-status-amber"
          hint="Queued to send later"
        />
        <StatCard
          label="Sent"
          value={sent}
          dot="bg-status-green"
          hint="Review request delivered"
        />
        <StatCard
          label="Opted out / skipped"
          value={optedOut}
          dot="bg-line-strong"
          hint="No consent or opted out"
        />
      </div>

      <ReviewsWorkspace clientSlug={clientSlug} siteNames={siteNames} />
    </>
  );
}
