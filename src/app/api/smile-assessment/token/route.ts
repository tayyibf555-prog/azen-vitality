import { getClient } from "@/lib/mock/clients";
import { mintSubmitToken } from "@/lib/smile-assessment/embed-token";

export const dynamic = "force-dynamic";

// Public: the quiz (on our /assess pages AND embedded in the practice's own
// website via iframe) fetches a short-lived page token here just before
// submitting. See embed-token.ts for the threat model. Cheap and read-only; the
// heavy abuse defences live on the submit route itself.
export async function GET(request: Request): Promise<Response> {
  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  if (!clientSlug || !getClient(clientSlug)) {
    return Response.json({ token: null }, { status: 404 });
  }
  return Response.json({ token: mintSubmitToken(clientSlug) });
}
