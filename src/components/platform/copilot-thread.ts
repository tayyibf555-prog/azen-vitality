"use client";

import { useCallback, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  PoundSterling,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import type { CopilotAccess, CopilotToolName } from "@/lib/copilot/scope";
import { catalogAllows } from "@/lib/copilot/clearance";

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
/**
 * Shown when the route refused this person and its 403 carried no sentence.
 *
 * Not a generic apology, because a refusal is not a fault: the one thing the
 * person needs to know is that this is about their access, and who can change
 * it. It says no more than that — no role, no capability, no tool name — which
 * is the same posture the route's own refusal takes.
 */
export const COPILOT_FORBIDDEN_REPLY =
  "You do not have access to the co-pilot. Ask the practice owner to check your permissions.";

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
  /**
   * The narrowest co-pilot that can actually ANSWER this one.
   *
   * Every starter maps to a real tool, which is what makes a click return live
   * data rather than a dead end — and that promise breaks the moment a role
   * exists whose tool set is smaller. The practice manager has no
   * `outstanding_balances` and no `practice_overview`, so two of these four would
   * have rendered for her as buttons that fetch a refusal. Worse than useless: a
   * dead button is also an advertisement for what she cannot have.
   */
  needsTool: CopilotToolName;
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
    needsTool: "appointments",
  },
  {
    id: "outstanding",
    label: "Who has an outstanding balance?",
    hint: "Treatment plans with money owed, and the total",
    prompt: "Which patients have an outstanding balance?",
    icon: PoundSterling,
    popupTint: "bg-emerald-500/10 text-emerald-600",
    pageTint: "bg-tint-green text-status-green ring-1 ring-tint-green-line",
    needsTool: "outstanding_balances",
  },
  {
    id: "noshow",
    label: "Any high no-show risks today?",
    hint: "Who is most likely not to turn up, and why",
    prompt: "Are there any high no-show risks in today's diary?",
    icon: AlertTriangle,
    popupTint: "bg-amber-500/10 text-amber-600",
    pageTint: "bg-tint-amber text-status-amber ring-1 ring-tint-amber-line",
    needsTool: "appointments",
  },
  {
    id: "overview",
    label: "How is the practice doing this week?",
    hint: "Patients, diary, money owed and recovery in one read",
    prompt: "How is the practice doing this week?",
    icon: TrendingUp,
    popupTint: "bg-violet-500/10 text-violet-600",
    pageTint: "bg-tint-royal text-status-royal ring-1 ring-tint-royal-line",
    needsTool: "practice_overview",
  },
];

/**
 * The starters a given co-pilot can actually answer.
 *
 * DERIVED FROM THE CLEARANCE MODEL, not from a hand-kept `minAccess` rank. Each
 * starter names the TOOL it runs and is offered only when that access level may
 * actually run it, so the buttons and the server cannot drift: a starter whose
 * tool is later moved to a narrower domain stops being offered on the same
 * commit, with no second list to remember.
 *
 * The rank it replaces was not merely tidier-in-the-abstract. "Everything except
 * full" was the right answer for exactly two levels, and it silently became the
 * WRONG one the day the model grew a `staff` level: a receptionist would have
 * been shown "What's in today's diary?", a button whose tool she does not hold,
 * on the one surface she can reach (the Cmd-J panel, which the shell mounts for
 * every role). Now she is shown none, because she holds none.
 *
 * Defaults to the owner's, so every existing caller renders the four it always
 * did — `catalogAllows("full", ...)` is true by construction.
 */
export function copilotStartersFor(access: CopilotAccess = "full"): CopilotStarter[] {
  return COPILOT_STARTERS.filter((s) => catalogAllows(access, s.needsTool));
}

/**
 * Does this 403 body read as a refusal somebody wrote for a person?
 *
 * The guards in this codebase answer with lowercase machine tokens —
 * `forbidden`, `unauthorized`, and on other statuses `bad json`, `no messages`,
 * `unknown client`, `copilot unavailable`. Several of those contain a space, so
 * "more than one word" alone does not separate them from prose; none of them
 * closes a sentence. The test is therefore both: whitespace AND terminal
 * punctuation. A token fails it, and the caller falls back to a sentence.
 */
function readsAsWrittenRefusal(text: string): boolean {
  return /\s/.test(text) && /[.!?]$/.test(text);
}

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
    // A 403 FROM THIS ROUTE IS NOT ALWAYS A SENTENCE, AND THAT IS THE WHOLE
    // REASON THIS BRANCH IS NOT ONE LINE. /api/copilot refuses in four places
    // and only one of them writes for a person:
    //
    //   - the clearance refusal (`access === "none"`, src/app/api/copilot/route.ts)
    //     — "Your account's role is not one the co-pilot serves. Ask the practice
    //     owner to check your access.";
    //   - `requireClientAccess` and `requireModuleApiAccess`
    //     (src/lib/auth/guard.ts) and `requireCapability(auth,
    //     "system.copilot.ask")` (src/lib/auth/capability-guard.ts) — all three
    //     answer this codebase's standing machine token, `{ error: "forbidden" }`.
    //
    // The capability one is neither hypothetical nor hostile: taking
    // `system.copilot.ask` off a named login is the documented way an owner
    // removes the co-pilot from ONE person (src/lib/copilot/clearance.ts), and
    // nothing hides the ask-bar from her afterwards — the page gates on module
    // access, which a revoked capability does not touch, and the Cmd-J panel is
    // mounted by the shell layout for every role. Rendering the word
    // "forbidden" as the assistant's entire answer tells her nothing, least of
    // all that her access was changed rather than the feature broken.
    //
    // So the body is surfaced only when it READS as a refusal written for a
    // person, and the standing permissions sentence is shown when it does not.
    // Either way the reply is a sentence and never a token, so if the route's
    // wording is later edited past this shape the reader still gets the right
    // KIND of answer. Every other status keeps the generic apology: "copilot
    // unavailable" is a log line, not an answer.
    if (response.status === 403) {
      const refusal = typeof data.error === "string" ? data.error.trim() : "";
      return readsAsWrittenRefusal(refusal) ? refusal : COPILOT_FORBIDDEN_REPLY;
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
