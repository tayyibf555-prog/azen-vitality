export type ConversationStatus = "active" | "needs_human" | "booked" | "closed";
export type MessageRole = "patient" | "agent" | "system" | "tool";

export interface AgentConversation {
  id: string;
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  channel: string;
  status: ConversationStatus;
  treatment: string | null;
  fundingType: "nhs" | "private" | null;
  lastInboundAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessageRow {
  id: string;
  conversationId: string;
  role: MessageRole;
  body: string;
  toolName: string | null;
  createdAt: string;
}

/** Patient context handed to the agent for a turn. */
export interface AgentContext {
  patientId: string;
  siteId: string;
  patientName: string;
  treatment: string | null;
  fundingType: "nhs" | "private" | null;
}

export interface AgentTurnResult {
  replyText: string;
  toolCalls: { name: string; input: Record<string, unknown> }[];
  escalated: boolean;
}
