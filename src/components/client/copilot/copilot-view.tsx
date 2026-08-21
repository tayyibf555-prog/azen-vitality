import { getClient } from "@/lib/mock";
import { authEnforced } from "@/lib/auth/guard";
import { getSessionUser } from "@/lib/auth/session";
import { copilotAccessForRole } from "@/lib/copilot/scope";
import { CopilotPageChat } from "@/components/platform/copilot-page-chat";

/**
 * The co-pilot module, in BOTH trees.
 *
 * Rendered by /c/[client]/co-pilot (behind requireModuleAccess("co-pilot"),
 * which is owner + agency + the practice manager) and by the owner tree's
 * [module] if-chain. Anything added here therefore has to hold on both, which is
 * why the page's height hatch is opened in both shells rather than only in /c.
 *
 * A SERVER COMPONENT WRAPPING A CLIENT ONE. The client boundary starts at
 * CopilotPageChat; this half stays on the server so the practice name comes from
 * the same getClient the rest of the module tree reads, and the chat receives
 * three plain strings. No function crosses the boundary.
 *
 * WHY THE ACCESS LEVEL IS RESOLVED HERE AND WHAT IT IS FOR. The manager's
 * co-pilot answers fewer questions than the owner's, and an interface that
 * offers what the server will refuse is a defect in its own right: two of the
 * four starter buttons run tools she does not have, and the page's own copy
 * promises money and sending. So the access level decides the COPY and the
 * STARTERS.
 *
 * IT IS NOT A LOCK, AND NOTHING DOWNSTREAM TRUSTS IT. /api/copilot derives the
 * same answer again, from the session, on every single turn, and the tool
 * dispatch checks it a third time per call. If this line were deleted the
 * manager would see four buttons instead of two and get a polite refusal from
 * two of them; she would not get the owner's data.
 *
 * `getSessionUser` is React-cached per request and the shell's `guardPage` has
 * already called it, so this costs no extra round-trip. It is skipped entirely
 * where sign-in is not configured — `guardPage` early-returns there without
 * resolving a session, so calling it would be the one round-trip nobody else
 * pays — and that environment is open to everything anyway, which is the same
 * posture every guard in this codebase takes.
 */
export async function CopilotView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <p className="text-sm text-muted">This client could not be found.</p>;
  }

  const access = authEnforced() ? copilotAccessForRole((await getSessionUser())?.role) : "full";

  return <CopilotPageChat clientSlug={clientSlug} practiceName={client.name} access={access} />;
}
