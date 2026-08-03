import { PaymentsView } from "@/components/client/payments/payments-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function PaymentsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("payments");
  return <PaymentsView clientSlug={clientSlug} />;
}
