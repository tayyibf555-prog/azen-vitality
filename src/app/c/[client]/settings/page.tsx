import { SettingsView } from "@/components/client/settings/settings-view";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client } = await params;
  return <SettingsView clientSlug={client} />;
}
