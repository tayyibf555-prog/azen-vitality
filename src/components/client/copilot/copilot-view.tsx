import { getClient } from "@/lib/mock";
import { CopilotPageChat } from "@/components/platform/copilot-page-chat";

/**
 * The co-pilot module, in BOTH trees.
 *
 * Rendered by /c/[client]/co-pilot (behind requireModuleAccess("co-pilot"),
 * which is owner-only) and by the owner tree's [module] if-chain. Anything added
 * here therefore has to hold on both, which is why the page's height hatch is
 * opened in both shells rather than only in /c.
 *
 * A SERVER COMPONENT WRAPPING A CLIENT ONE. The client boundary starts at
 * CopilotPageChat; this half stays on the server so the practice name comes from
 * the same getClient the rest of the module tree reads, and the chat receives two
 * plain strings. No function crosses the boundary.
 */
export function CopilotView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <p className="text-sm text-muted">This client could not be found.</p>;
  }

  return <CopilotPageChat clientSlug={clientSlug} practiceName={client.name} />;
}
