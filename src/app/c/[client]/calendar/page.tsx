import { CalendarView } from "@/components/client/calendar/calendar-view";

export const dynamic = "force-dynamic";

export default async function CalendarPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <CalendarView clientSlug={clientSlug} />;
}
