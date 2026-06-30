import { getClient, getSites } from "@/lib/mock";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";
import { listPatients } from "@/lib/dentally/read";
import { sendMessage } from "@/lib/messaging/send";
import { isSuppressed } from "@/lib/messaging/suppression";
import type { MessageChannel } from "@/lib/messaging/types";
import { findOrCreateConversation, appendMessage } from "@/lib/agent/repository";
import { logCopilotAction } from "@/lib/copilot/actions";

export const dynamic = "force-dynamic";

// Channels a human can reply on. WhatsApp and SMS both go via Twilio; email via
// Resend. "after-hours" is a capture label, not a send channel, so a reply to one
// of those threads goes out as SMS (the channel the contact reached us on).
function toSendChannel(channel: string): MessageChannel {
  if (channel === "whatsapp") return "whatsapp";
  if (channel === "email") return "email";
  return "sms"; // sms + after-hours
}

interface ReplyBody {
  clientSlug?: string;
  contactRef?: string;
  channel?: string;
  body?: string;
}

// POST /api/inbox/reply { clientSlug, contactRef, channel, body }
// HUMAN TAKEOVER. Resolves the contact, checks consent + suppression, sends via
// the shared sendMessage (so MESSAGING_DRY_RUN, consent and suppression are all
// honoured, never a raw provider send), and records the outbound into the agent
// conversation store so it appears in the thread. Mirrors the co-pilot send tool:
// consent -> destination -> suppression -> send -> record.
export async function POST(request: Request): Promise<Response> {
  let payload: ReplyBody;
  try {
    payload = (await request.json()) as ReplyBody;
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const contactRef = (payload.contactRef ?? "").trim();
  const body = (payload.body ?? "").trim();
  const channel = toSendChannel(payload.channel ?? "sms");
  const client = payload.clientSlug ? getClient(payload.clientSlug) : null;

  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 400 });
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  if (!contactRef || !body) {
    return Response.json({ ok: false, error: "contactRef and body are required" }, { status: 400 });
  }

  const clientSiteIds = getSites(client.id).map((s) => s.id);
  const siteIds = auth ? clientSiteIds.filter((id) => auth.siteIds.includes(id)) : clientSiteIds;
  if (siteIds.length === 0) return Response.json({ ok: false, error: "no accessible sites" }, { status: 403 });

  // Resolve the contact into a deliverable destination + the ref consent is keyed
  // on. Two shapes: a known patient (patient:<id>) or an unidentified lead/address.
  let to: string | null = null;
  let suppressionRef = contactRef;
  let siteId = siteIds[0];
  let contactName = contactRef;
  let dentallyPatientId = contactRef;

  if (contactRef.startsWith("patient:")) {
    const id = contactRef.slice("patient:".length);
    dentallyPatientId = id;
    const patients = await listPatients(siteIds).catch(() => []);
    const patient = patients.find((p) => p.id === id);
    if (!patient) {
      return Response.json({ ok: false, error: "Patient not found in your sites." }, { status: 404 });
    }
    siteId = patient.siteId || siteId;
    contactName = patient.name;
    suppressionRef = `patient:${patient.id}`;

    // Consent gate: never message a patient who has not consented on this channel.
    const consented = channel === "email" ? patient.emailConsent : patient.smsConsent;
    if (!consented) {
      return Response.json({
        ok: true,
        sent: false,
        reason: "no_consent",
        message: `${patient.name} has not consented to ${channel}, so nothing was sent.`,
      });
    }

    // Destination gate: a deliverable address on this channel.
    to = channel === "email" ? patient.email : patient.phone;
    if (!to) {
      return Response.json({
        ok: true,
        sent: false,
        reason: "no_destination",
        message: `${patient.name} has no ${channel === "email" ? "email" : "mobile number"} on file.`,
      });
    }
  } else if (contactRef.startsWith("lead:")) {
    // An unidentified enquiry that reached us on this number: reply to the number.
    to = contactRef.slice("lead:".length);
    suppressionRef = to;
    contactName = `Lead ${to.slice(-4)}`;
    dentallyPatientId = contactRef; // keep the lead key so the reply threads correctly
  } else if (contactRef.startsWith("address:")) {
    to = contactRef.slice("address:".length);
    suppressionRef = to;
    contactName = to;
    dentallyPatientId = contactRef;
  } else {
    return Response.json({ ok: false, error: "Unrecognised contact." }, { status: 400 });
  }

  if (!to) return Response.json({ ok: false, error: "No deliverable destination." }, { status: 400 });

  // Suppression gate: honour an opt-out recorded against the ref OR the address.
  if (
    (await isSuppressed(siteId, channel, suppressionRef)) ||
    (await isSuppressed(siteId, channel, to))
  ) {
    return Response.json({
      ok: true,
      sent: false,
      reason: "opted_out",
      message: `${contactName} has opted out of ${channel}, so nothing was sent.`,
    });
  }

  // Send via the shared pipeline (MESSAGING_DRY_RUN honoured inside the providers).
  let result;
  try {
    result = await sendMessage({ channel, to, body });
  } catch {
    return Response.json({ ok: false, error: "Sending failed, please try again." }, { status: 502 });
  }
  const dryRun = result.provider === "dry-run";

  // Record the outbound so it shows in the thread. Reuse the agent conversation
  // store (no new table): a human takeover reply lives alongside the agent's own
  // turns, exactly where the inbox reads from.
  const nowIso = new Date().toISOString();
  let recorded = false;
  try {
    const conversation = await findOrCreateConversation({
      siteId,
      dentallyPatientId,
      patientName: contactName,
      channel,
      treatment: null,
      fundingType: null,
    });
    await appendMessage({ conversationId: conversation.id, role: "agent", body });
    recorded = true;
  } catch {
    // The message was sent (or dry-run recorded by the provider); a thread-write
    // failure must not present as a failed send. The audit row below still lands.
  }

  // Audit trail, mirroring the co-pilot send tool.
  await logCopilotAction({
    clientId: client.id,
    siteId,
    actor: auth?.id ?? "human",
    action: "inbox_reply",
    targetRef: suppressionRef,
    targetName: contactName,
    channel,
    body,
    status: dryRun ? "dry_run" : result.status,
  });

  return Response.json({
    ok: true,
    sent: true,
    dryRun,
    recorded,
    status: result.status,
    at: nowIso,
    message: dryRun
      ? "Recorded in test mode (dry run); it was not delivered. It will go out for real once messaging is switched live."
      : "Sent.",
  });
}
