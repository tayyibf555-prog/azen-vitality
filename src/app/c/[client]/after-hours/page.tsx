import { AfterHoursView } from "@/components/client/after-hours/after-hours-view";

export const dynamic = "force-dynamic";

export default async function AfterHoursPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <AfterHoursView clientSlug={clientSlug} />;
}
