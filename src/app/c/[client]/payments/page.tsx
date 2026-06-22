import { PaymentsView } from "@/components/client/payments/payments-view";

export const dynamic = "force-dynamic";

export default async function PaymentsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <PaymentsView clientSlug={clientSlug} />;
}
