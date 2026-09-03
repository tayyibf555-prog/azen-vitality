import { CopilotView } from "@/components/client/copilot/copilot-view";
import { AuthoritiesPanel } from "@/components/client/copilot/authorities-panel";
import { requireModuleAccess } from "@/lib/auth/page-guard";
import { authEnforced } from "@/lib/auth/guard";
import { getSessionUser } from "@/lib/auth/session";
import { OWNER_ROLES } from "@/lib/nav";

export const dynamic = "force-dynamic";

export default async function CopilotPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("co-pilot");

  // THE APPROVED-SOURCES PANEL IS THE OWNER'S, AND THE ROLE IS RESOLVED HERE, ON
  // THE SERVER.
  //
  // `requireModuleAccess("co-pilot")` above admits the practice manager as well as
  // the owner (see the slug's `roles` array in @/lib/nav), which is right for the
  // chat and wrong for this list: deciding which outside sources the co-pilot may
  // lean on puts words into every answer it gives the whole practice, and that is
  // the principal's decision. So the panel is not rendered at all for anybody else
  // — not hidden with a class, not disabled in the browser, simply absent from the
  // HTML, because a client-side check is a suggestion.
  //
  // IT IS NOT THE LOCK EITHER. /api/authorities/[action] carries the real one
  // (requireUser -> requireClientAccess -> requireModuleApiAccess -> requireOwnerRole)
  // and re-derives the role from the session on every call. This line decides what
  // is drawn; that route decides what is permitted.
  //
  // `getSessionUser` is React-cached per request and the shell's `guardPage` has
  // already resolved the same session, so this costs no extra round-trip. Where
  // sign-in is not configured there is no session to resolve and the environment is
  // open to everything anyway, which is the posture every guard here takes — the
  // same shape CopilotView uses one file over.
  const showAuthorities = authEnforced()
    ? OWNER_ROLES.includes((await getSessionUser())?.role ?? "client_staff")
    : true;

  return (
    // The chat owns the height (its `data-chat` opens the shell's lg:h-full hatch),
    // so it takes the flexible row and the panel — collapsed to a single header bar
    // until the owner opens it — sits under it at its natural size.
    <div className="flex flex-col gap-3 lg:h-full lg:min-h-0">
      <div className="min-h-0 flex-1">
        <CopilotView clientSlug={clientSlug} />
      </div>
      {showAuthorities ? (
        <div className="shrink-0">
          <AuthoritiesPanel clientSlug={clientSlug} />
        </div>
      ) : null}
    </div>
  );
}
