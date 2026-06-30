import { SettingsView } from "@/components/client/settings/settings-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client } = await params;
  await requireModuleAccess("settings");
  return <SettingsView clientSlug={client} />;
}
