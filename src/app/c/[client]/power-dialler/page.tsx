import { ModulePlaceholder } from "@/components/client/module-placeholder";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

// NO "use client" HERE ANY MORE. It used to be a client component, which is why it
// was one of the pages with no server-side module guard: `requireModuleAccess` is
// server-only and cannot be called from one. ModulePlaceholder carries its own
// "use client", so this page is free to be a server component and render it —
// unbuilt is not a reason to leave a module reachable by a role that may not have it.
export default async function PowerDiallerPage() {
  await requireModuleAccess("power-dialler");
  return <ModulePlaceholder slug="power-dialler" />;
}
