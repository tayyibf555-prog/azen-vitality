import { serviceClient } from "@/lib/supabase/server";
import type { AgentConversation, AgentMessageRow, ConversationStatus, MessageRole } from "./types";

interface ConvRow {
  id: string; site_id: string; dentally_patient_id: string; patient_name: string; channel: string;
  status: string; treatment: string | null; funding_type: string | null;
  last_inbound_at: string | null; created_at: string; updated_at: string;
}
interface MsgRow {
  id: string; conversation_id: string; role: string; body: string; tool_name: string | null; created_at: string;
}

function toConv(r: ConvRow): AgentConversation {
  return {
    id: r.id, siteId: r.site_id, dentallyPatientId: r.dentally_patient_id, patientName: r.patient_name,
    channel: r.channel, status: r.status as ConversationStatus,
    treatment: r.treatment, fundingType: (r.funding_type as "nhs" | "private" | null) ?? null,
    lastInboundAt: r.last_inbound_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function toMsg(r: MsgRow): AgentMessageRow {
  return { id: r.id, conversationId: r.conversation_id, role: r.role as MessageRole, body: r.body, toolName: r.tool_name, createdAt: r.created_at };
}

export async function findOrCreateConversation(input: {
  siteId: string; dentallyPatientId: string; patientName: string; channel: string;
  treatment: string | null; fundingType: "nhs" | "private" | null;
}): Promise<AgentConversation> {
  const db = serviceClient();
  const { data: existing, error: selErr } = await db
    .from("agent_conversation")
    .select("*")
    .eq("site_id", input.siteId)
    .eq("dentally_patient_id", input.dentallyPatientId)
    .eq("channel", input.channel)
    .not("status", "in", "(closed)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return toConv(existing as ConvRow);

  const { data, error } = await db
    .from("agent_conversation")
    .insert({
      site_id: input.siteId, dentally_patient_id: input.dentallyPatientId, patient_name: input.patientName,
      channel: input.channel, treatment: input.treatment, funding_type: input.fundingType,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toConv(data as ConvRow);
}

export async function listMessages(conversationId: string): Promise<AgentMessageRow[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("agent_message").select("*").eq("conversation_id", conversationId).order("created_at", { ascending: true });
  if (error) throw error;
  return (data as MsgRow[]).map(toMsg);
}

export async function appendMessage(input: {
  conversationId: string; role: MessageRole; body: string; toolName?: string | null;
}): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("agent_message").insert({
    conversation_id: input.conversationId, role: input.role, body: input.body, tool_name: input.toolName ?? null,
  });
  if (error) throw error;
}

export async function setConversationStatus(id: string, status: ConversationStatus): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("agent_conversation")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function stampInbound(id: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("agent_conversation")
    .update({ last_inbound_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}
