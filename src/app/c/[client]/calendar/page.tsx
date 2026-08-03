import { CalendarView } from "@/components/client/calendar/calendar-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function CalendarPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("calendar");
  return <CalendarView clientSlug={clientSlug} />;
}
