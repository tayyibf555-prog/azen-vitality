import { PeopleLogins } from "@/components/client/permissions/people-logins";
import { PermissionsView } from "@/components/client/permissions/permissions-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

// People & permissions. OWNER-ONLY, and gated in three places that are all
// necessary: the nav item's `roles` array hides it, `requireModuleAccess` below
// 404s a direct URL, and /api/permissions and /api/people each repeat the role
// guard themselves. The page guard does NOT protect an API route — that is the
// lesson the API coverage sweep exists to pin.
//
// TWO PANELS, in the order the work happens: first WHO can log in (invite a
// colleague, set their level, link them to their staff record, remove access),
// then WHAT each of them may do. They are separate features with separate APIs
// and separate tests; they share this page because "People & logins" is one job
// to the practice, and sending somebody to two screens to finish it is how a
// half-provisioned login happens.
//
// NO loading.tsx in this directory, ever: a streamed loading boundary left authed
// pages unhydrated and their buttons dead (fixed in feb8677), and every control
// on this screen is a button.
export default async function PermissionsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("permissions");
  return (
    <>
      <PeopleLogins clientSlug={clientSlug} />
      <PermissionsView clientSlug={clientSlug} />
    </>
  );
}
