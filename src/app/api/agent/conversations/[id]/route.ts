import { listMessages } from "@/lib/agent/repository";
import { requireUser } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

// GET /api/agent/conversations/[id]
// Returns the full message thread for one conversation, oldest first, so the
// dashboard can open a conversation and show the patient <-> agent exchange.
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  try {
    const messages = await listMessages(id);
    return Response.json({ ok: true, messages });
  } catch {
    return Response.json({ ok: false, messages: [] }, { status: 500 });
  }
}
