"use client";

import { useCallback, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  PoundSterling,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

// ---------------------------------------------------------------------------
// ONE TRANSPORT, TWO SURFACES.
//
// The co-pilot is reachable from two places that must not drift apart: the
// bottom-docked pop-up the keyboard shortcut opens (copilot-conversation.tsx)
// and the full page under Operations (copilot-page-chat.tsx). They look nothing
// alike on purpose — the owner's complaint was precisely that the page had
// inherited the pop-up's cramped docked styling — but there is only ever one
// answer to "what does sending a message do", and it lives here.
//
// WHAT IS SHARED: the message shape, the request, the error sentences, the
// busy-lock, and the starter prompts (each of which maps to a real co-pilot
// tool, so a click returns live data rather than a dead end).
// WHAT IS NOT SHARED: a single pixel of layout. Each surface owns its own.
// ---------------------------------------------------------------------------

export interface CopilotMessage {
  role: "user" | "assistant";
  content: string;
}

/** Shown when the co-pilot answered, but with nothing usable in it. */
export const COPILOT_FAILED_REPLY = "Sorry, something went wrong.";
/** Shown when the request never completed (offline, dropped connection). */
export const COPILOT_UNREACHABLE_REPLY = "Sorry, I could not reach the co-pilot just now.";

export interface CopilotStarter {
  id: string;
  /** What the button says. */
  label: string;
  /** A second line, on the page's larger cards only. */
  hint: string;
  /** What is actually sent, which may be longer than the label. */
  prompt: string;
  icon: LucideIcon;
  /** Icon tile classes for the pop-up (its existing palette, unchanged). */
  popupTint: string;
  /** Icon tile classes for the page, on the app's status tokens. */
  pageTint: string;
}

export const COPILOT_STARTERS: CopilotStarter[] = [
  {
    id: "diary",
    label: "What's in today's diary?",
    hint: "Every appointment today, clinician by clinician",
    prompt: "What's in today's diary?",
    icon: CalendarDays,
    popupTint: "bg-blue-dark/10 text-blue-dark",
    pageTint: "bg-tint-blue text-status-blue ring-1 ring-tint-blue-line",
  },
  {
    id: "outstanding",
    label: "Who has an outstanding balance?",
    hint: "Treatment plans with money owed, and the total",
    prompt: "Which patients have an outstanding balance?",
    icon: PoundSterling,
    popupTint: "bg-emerald-500/10 text-emerald-600",
    pageTint: "bg-tint-green text-status-green ring-1 ring-tint-green-line",
  },
  {
    id: "noshow",
    label: "Any high no-show risks today?",
    hint: "Who is most likely not to turn up, and why",
    prompt: "Are there any high no-show risks in today's diary?",
    icon: AlertTriangle,
    popupTint: "bg-amber-500/10 text-amber-600",
    pageTint: "bg-tint-amber text-status-amber ring-1 ring-tint-amber-line",
  },
  {
    id: "overview",
    label: "How is the practice doing this week?",
    hint: "Patients, diary, money owed and recovery in one read",
    prompt: "How is the practice doing this week?",
    icon: TrendingUp,
    popupTint: "bg-violet-500/10 text-violet-600",
    pageTint: "bg-tint-royal text-status-royal ring-1 ring-tint-royal-line",
  },
];

/**
 * Post one turn and return the text to show as the assistant's reply.
 *
 * NEVER REJECTS AND NEVER RETURNS EMPTY. Every failure path resolves to a
 * sentence a person can read, because the only place this string goes is into a
 * chat bubble: a thrown error there would leave the thread stuck on "working"
 * with the user's own message the last thing on screen.
 *
 * `fetchImpl` exists so the contract can be tested against every response shape
 * the route really produces (200, 403, 500, malformed body, network throw)
 * without a browser.
 */
export async function postCopilotTurn(
  clientSlug: string,
  messages: CopilotMessage[],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  try {
    const response = await fetchImpl("/api/copilot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, client: clientSlug }),
    });
    // `?? {}` because Response.json(null) is a legal body and reading .reply
    // off it throws — which would be reported to the owner as "I could not
    // reach the co-pilot", when in fact it answered.
    const data = ((await response.json()) ?? {}) as { reply?: unknown; error?: unknown };
    if (typeof data.reply === "string" && data.reply.trim().length > 0) return data.reply;
    // A 403 from this route is the ONE error whose body is a sentence written
    // for the owner to read ("The co-pilot is available to the practice owner"),
    // and swallowing it into the generic apology is how a permissions problem
    // gets mistaken for a broken feature. Every other status keeps the generic
    // sentence: "copilot unavailable" is a log line, not an answer.
    if (response.status === 403 && typeof data.error === "string" && data.error.trim().length > 0) {
      return data.error;
    }
    return COPILOT_FAILED_REPLY;
  } catch {
    return COPILOT_UNREACHABLE_REPLY;
  }
}

export interface CopilotThread {
  messages: CopilotMessage[];
  /** True from the moment a turn is sent until its reply is on screen. */
  busy: boolean;
  send: (text: string) => Promise<void>;
  /** Drop the thread. Refuses while a turn is in flight. */
  reset: () => void;
}

/**
 * The in-memory conversation.
 *
 * IN MEMORY IS THE WHOLE STORY: there is no persistence behind this hook, no
 * thread id and no history endpoint, and a refresh loses everything. Both
 * surfaces say so in the UI rather than implying a history that does not exist.
 *
 * The thread is mirrored in a ref as well as in state because a turn reads the
 * conversation AFTER an await, and reading it from the closure would send the
 * history as it stood when the handler was created.
 */
export function useCopilotThread(clientSlug: string): CopilotThread {
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const threadRef = useRef<CopilotMessage[]>([]);
  const busyRef = useRef(false);

  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      // The busy lock is a REF, not the state, so two Enter presses in the same
      // tick cannot both pass the check and double-charge a turn.
      if (!body || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      const next: CopilotMessage[] = [...threadRef.current, { role: "user", content: body }];
      threadRef.current = next;
      setMessages(next);
      const reply = await postCopilotTurn(clientSlug, next);
      const settled: CopilotMessage[] = [...threadRef.current, { role: "assistant", content: reply }];
      threadRef.current = settled;
      setMessages(settled);
      busyRef.current = false;
      setBusy(false);
    },
    [clientSlug],
  );

  const reset = useCallback(() => {
    if (busyRef.current) return;
    threadRef.current = [];
    setMessages([]);
  }, []);

  return { messages, busy, send, reset };
}
