import { BookingView } from "@/components/client/booking/booking-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function BookingPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("booking");
  return <BookingView clientSlug={clientSlug} />;
}
