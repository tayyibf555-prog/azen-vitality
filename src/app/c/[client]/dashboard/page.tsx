import { redirect } from "next/navigation";

// The practice dashboard now IS the Overview, which is what the sidebar's Home
// opens. This route survives only so that anything already pointing here still
// lands somewhere sensible: it had no nav entry and nothing linked to it, which
// is precisely why it went unnoticed that the practice manager was comparing us
// against the old Home page rather than against this dashboard.
//
// Kept as a redirect rather than deleted so two copies of the same screen cannot
// drift apart, which is how a figure ends up correct on one page and stale on
// the other.

export default async function PracticeDashboardPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  redirect(`/c/${clientSlug}`);
}
