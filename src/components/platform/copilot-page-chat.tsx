"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, Check, Copy, Loader2, Send, SquarePen } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopilotProse } from "@/components/platform/copilot-prose";
import {
  copilotStartersFor,
  useCopilotThread,
  type CopilotMessage,
} from "@/components/platform/copilot-thread";
import type { CopilotAccess } from "@/lib/copilot/scope";

// ===========================================================================
// THE CO-PILOT, AS A PAGE.
//
// THE DEFECT THIS REPLACES. The page was fifteen lines: a card with the SHARED
// CopilotConversation inside it. That component is the bottom-docked pop-up the
// keyboard shortcut opens, and it is built for a slim ask-bar floating above the
// fold — a 48vh message cap, a one-line input, a header sized for an overlay.
// Dropping it into a full-width page did not make it a page; it made a pop-up
// with a lot of space around it, which is exactly what the owner reported.
//
// SO THE TWO ARE NOW SEPARATE COMPONENTS THAT SHARE A TRANSPORT AND NOTHING
// ELSE. copilot-thread.ts owns the message shape, the request, the busy lock and
// the starter prompts. The pop-up keeps its docked layout byte for byte; this
// file owns the page's, and copilot-page-chat.test.ts pins both so that a future
// edit to one cannot quietly restyle the other.
//
// THE LAYOUT DECISIONS, AND WHY EACH ONE.
//
//   A READING COLUMN, NOT A FULL-WIDTH ONE. Everything inside the scroller is
//   capped at max-w-3xl (48rem) and centred. An answer set in a 1400px measure
//   is 200 characters a line, which is roughly three times the width prose is
//   legible at, and the co-pilot's answers are prose. The panel is still full
//   width because the panel is the surface; the TEXT is what is capped.
//
//   THE ASSISTANT IS NOT IN A BUBBLE. Its answer runs the full width of the
//   column with the practice's mark beside it, and only the OWNER's messages sit
//   in a tinted block. This asymmetry is the point: a bubble is right for a
//   short thing you said and wrong for a long structured answer you are reading,
//   and boxing a twelve-line patient record in a rounded rectangle costs it two
//   gutters and a border for nothing. It also makes the two turns tellable apart
//   at a glance without relying on which side they are on.
//
//   THE COMPOSER IS PART OF THE FRAME, NOT OF THE SCROLL. The root is a flex
//   column at the height of the working area, the messages are the only thing
//   that scrolls, and the composer is a fixed row at the bottom of it. It is not
//   `position: fixed` on purpose: fixed would put it over the sidebar and would
//   have to be told the sidebar's width, which is a number that would go stale.
//
//   HEIGHT COMES FROM THE SHELL, NOT FROM A GUESS. `data-chat` opens the
//   lg:h-full hatch both app layouts already carry for the diary, so this fills
//   the working area exactly rather than subtracting a hardcoded 10rem of chrome
//   that nobody re-measures when the top bar changes. Below lg there is no such
//   hatch in either shell, so the mobile height is the one explicit calc here.
//
// HONESTY ABOUT WHAT IS NOT BUILT. There is no persistence: no thread id, no
// history endpoint, no table. So there is no sidebar of past conversations, no
// "recent chats", and the composer says in as many words that a refresh clears
// the thread. A chat interface that LOOKS like it saves history and does not is
// worse than one that never offered.
// ===========================================================================

/** Every sentence the page says, in one place, so the tests assert the real copy. */
export const COPILOT_PAGE_COPY = {
  title: "Co-pilot",
  subtitle: "Full visibility of the site selected in the top bar.",
  newThread: "New conversation",
  emptyHeading: "What do you need to know?",
  emptyBody:
    "Ask about a patient, the diary, money owed, leads or how the practice does something. I read the practice's own records to answer, and I can draft and send a message once you have approved it.",
  starters: "Try asking",
  thinking: "Working on it",
  jump: "Jump to latest",
  copy: "Copy answer",
  copied: "Copied",
  placeholder: "Ask the co-pilot anything",
  send: "Send",
  /** The persistence claim. Nothing on this page may contradict it. */
  ephemeral: "Nothing here is saved. Refreshing the page clears the conversation.",
  keys: "Enter to send, Shift + Enter for a new line",
} as const;

/**
 * THE TWO SENTENCES THAT ARE NOT TRUE FOR EVERYBODY.
 *
 * The copy above is the owner's and stays exactly as it was. Two of its lines
 * are claims about what the co-pilot can do — "full visibility", and "money
 * owed ... I can draft and send a message" — and for the practice manager both
 * are false: her tool set has no money tool and no send tool at all
 * (src/lib/copilot/scope.ts). An interface that promises what the server will
 * refuse is the same defect as a dead starter button, so the promise moves with
 * the access level rather than the reader finding out by being told no.
 */
const COPILOT_MANAGER_COPY = {
  subtitle: "The operational view of the site selected in the top bar.",
  emptyBody:
    "Ask about a patient, the diary, new enquiries and leads, or how the practice does something. I read the practice's own records to answer. Financial figures, reports and marketing sit with the practice owner, and I cannot message anyone from here.",
} as const;

/** The copy for this access level: the owner's, with the two claims corrected. */
export function copilotPageCopyFor(access: CopilotAccess = "full") {
  return access === "full" ? COPILOT_PAGE_COPY : { ...COPILOT_PAGE_COPY, ...COPILOT_MANAGER_COPY };
}

/** How tall the composer may grow before it scrolls internally, in pixels. */
const COMPOSER_MAX_HEIGHT = 200;
/** Distance from the bottom, in pixels, still counted as "reading the latest". */
const PINNED_SLACK = 96;
/** Seconds a turn must run before the wait is given a number. */
const ELAPSED_AFTER = 4;

/**
 * The practice's mark. One asset (/copilot-logo.png), the same file the booking
 * page and the landing pages use, so the co-pilot is visibly the same product.
 */
function VitalityMark({ practiceName, size }: { practiceName: string; size: "turn" | "hero" }) {
  const box = size === "hero" ? "h-12 w-12 rounded-2xl p-2" : "h-7 w-7 rounded-lg p-1";
  const px = size === "hero" ? 32 : 20;
  return (
    <span
      aria-hidden={size === "turn" ? undefined : true}
      className={cn("flex shrink-0 items-center justify-center bg-card ring-1 ring-line", box)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/copilot-logo.png"
        alt={size === "turn" ? `${practiceName} co-pilot` : ""}
        width={px}
        height={px}
        className="h-full w-full object-contain"
      />
    </span>
  );
}

/**
 * THE OPENING SCREEN, and the only place the co-pilot introduces itself.
 *
 * Exported separately from the page because it is the half a test can render
 * with no thread and no transport: the mark, the four starters and the promise
 * about persistence are structure, and structure is checkable.
 */
export function CopilotEmptyState({
  practiceName,
  onStart,
  access = "full",
}: {
  practiceName: string;
  onStart: (prompt: string) => void;
  /** Defaults to the owner's, so every existing caller renders what it always did. */
  access?: CopilotAccess;
}) {
  const copy = copilotPageCopyFor(access);
  const starters = copilotStartersFor(access);
  return (
    <div className="flex flex-col items-center text-center">
      <VitalityMark practiceName={practiceName} size="hero" />
      <h2 className="mt-4 text-[20px] font-semibold tracking-[-0.02em] text-navy">
        {COPILOT_PAGE_COPY.emptyHeading}
      </h2>
      <p className="mt-2 max-w-lg text-[13.5px] leading-relaxed text-muted">
        {copy.emptyBody}
      </p>
      <p className="mt-7 w-full text-left text-[11px] font-semibold uppercase tracking-[0.05em] text-faint">
        {COPILOT_PAGE_COPY.starters}
      </p>
      {/* The starters are CARDS here and a compact row in the pop-up, from the
          same source. Each one maps to a real tool, so a first click returns
          the practice's own data rather than a general answer. */}
      <div className="mt-2 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        {starters.map((starter) => {
          const Icon = starter.icon;
          return (
            <button
              key={starter.id}
              type="button"
              onClick={() => onStart(starter.prompt)}
              className="pressable group flex items-start gap-3 rounded-xl border border-line bg-card px-3 py-3 text-left transition-colors hover:border-line-strong hover:bg-row-hover"
            >
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                  starter.pageTint,
                )}
              >
                <Icon size={16} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold leading-snug text-navy">
                  {starter.label}
                </span>
                <span className="mt-0.5 block text-[12px] leading-snug text-muted">{starter.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The conversation itself.
 *
 * Takes the thread as a prop rather than owning it, which is what makes the two
 * turn shapes renderable in a test: state that only a fetch can produce is state
 * a structure test can never see.
 */
export function CopilotThreadView({
  messages,
  busy,
  elapsed,
  practiceName,
  copiedIndex,
  onCopy,
}: {
  messages: CopilotMessage[];
  busy: boolean;
  /** Seconds the in-flight turn has been running. */
  elapsed: number;
  practiceName: string;
  copiedIndex: number | null;
  onCopy: (index: number, text: string) => void;
}) {
  return (
    <ol
      // Announced to a screen reader as it grows: the answer arrives in one
      // piece with no scroll of its own to follow, so without this a non-sighted
      // owner gets no signal that the turn finished.
      role="log"
      aria-live="polite"
      aria-busy={busy}
      className="space-y-6"
    >
      {messages.map((message, index) =>
        message.role === "user" ? (
          // THE OWNER'S TURN: a tinted block, right aligned, its own line breaks
          // preserved and NOTHING parsed. A person typing "**" means asterisks.
          <li key={index} data-turn="user" className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-card-muted px-4 py-2.5 text-[14.5px] leading-[1.6] text-ink ring-1 ring-line">
              {message.content}
            </div>
          </li>
        ) : (
          // THE CO-PILOT'S TURN: the mark, then the answer at the full width of
          // the reading column, typeset by CopilotProse.
          <li key={index} data-turn="assistant" className="flex gap-3">
            <VitalityMark practiceName={practiceName} size="turn" />
            <div className="min-w-0 flex-1">
              <CopilotProse text={message.content} />
              <div className="mt-1.5">
                <button
                  type="button"
                  onClick={() => onCopy(index, message.content)}
                  className="pressable inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11.5px] font-medium text-faint transition-colors hover:bg-row-hover hover:text-navy"
                >
                  {copiedIndex === index ? <Check size={13} /> : <Copy size={13} />}
                  {copiedIndex === index ? COPILOT_PAGE_COPY.copied : COPILOT_PAGE_COPY.copy}
                </button>
              </div>
            </div>
          </li>
        ),
      )}
      {busy ? (
        // AN HONEST WAIT. /api/copilot answers in one JSON blob, so there is no
        // stream to render and a fake one would be a lie about what is
        // happening. This says the turn is running, and once past a few seconds
        // how long for, because a six-round tool turn genuinely takes a while.
        <li data-turn="thinking" className="flex gap-3">
          <VitalityMark practiceName={practiceName} size="turn" />
          <p className="flex items-center gap-2 pt-1 text-[13.5px] text-muted">
            <Loader2 size={14} className="animate-spin" aria-hidden />
            {COPILOT_PAGE_COPY.thinking}
            {elapsed >= ELAPSED_AFTER ? (
              <span className="tabular-nums text-faint">{elapsed}s</span>
            ) : null}
          </p>
        </li>
      ) : null}
    </ol>
  );
}

export function CopilotPageChat({
  clientSlug,
  practiceName,
  access = "full",
}: {
  clientSlug: string;
  practiceName: string;
  /**
   * Which co-pilot this person has, resolved on the SERVER from their session
   * (see copilot-view.tsx). It changes copy and starters only — it is not a
   * lock, and nothing here is trusted by the route, which derives the same
   * answer again from the session before it dispatches a single tool.
   */
  access?: CopilotAccess;
}) {
  const { messages, busy, send, reset } = useCopilotThread(clientSlug);
  const [input, setInput] = useState("");
  const [pinned, setPinned] = useState(true);
  const [copied, setCopied] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const focusComposer = useCallback(() => {
    composerRef.current?.focus();
  }, []);

  // The caret starts in the composer, and comes back to it the moment an answer
  // lands, so a conversation is typed end to end without touching the mouse.
  useEffect(() => {
    focusComposer();
  }, [focusComposer]);
  useEffect(() => {
    if (!busy) focusComposer();
  }, [busy, focusComposer]);

  // The composer grows with what is in it. Reset to 0 first or the box can only
  // ever get taller: scrollHeight of an already-tall textarea is its own height.
  //
  // THE ZERO-WIDTH GUARD IS NOT DEFENSIVE PADDING, IT IS THE BUG THIS HAD.
  // Measured in the browser on first paint: the mount effect ran while the
  // composer still had clientWidth 0, a textarea with no width reflows its
  // content into a one-character column, and scrollHeight came back 544 against
  // a real 40. The box opened at the 200px ceiling and stayed there, so the
  // page's first impression was an empty chat with a quarter-screen input in it.
  // A measurement taken at zero width is not a measurement; skip that frame and
  // let the observer below re-run once the shell has resolved its width.
  const fitComposer = useCallback(() => {
    const el = composerRef.current;
    if (!el || el.clientWidth === 0) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, []);

  useEffect(() => {
    fitComposer();
  }, [input, fitComposer]);

  // Re-fit when the column's WIDTH changes: the window resizing, the sidebar
  // opening, and - the case that matters - width arriving for the first time
  // after hydration. Height is deliberately ignored, because the height that
  // just changed is the one fitComposer set, and reacting to it would be this
  // observer answering itself.
  useEffect(() => {
    const box = composerRef.current?.parentElement;
    if (!box || typeof ResizeObserver === "undefined") return;
    let lastWidth = box.clientWidth;
    const observer = new ResizeObserver(() => {
      if (box.clientWidth === lastWidth) return;
      lastWidth = box.clientWidth;
      fitComposer();
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [fitComposer]);

  // AUTO-SCROLL THAT LOSES AN ARGUMENT WITH THE READER. If they have scrolled up
  // — to re-read the record above, which is the whole reason to scroll up mid
  // answer — new content must not yank them back down. `pinned` is recomputed
  // from the scroll position itself rather than from a "did the user scroll"
  // flag, so returning to the bottom by any means resumes the follow.
  const syncPinned = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_SLACK);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinned) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy, pinned]);

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPinned(true);
  }, []);

  // An honest wait. The API does not stream, so there is no token to show and
  // faking one would be a lie about what is happening. What IS true is that the
  // turn is running and how long it has been running, and a turn that reads six
  // tool rounds of real records can take twenty seconds.
  //
  // THE CLOCK IS ZEROED WHERE THE TURN STARTS, NOT HERE. An `if (!busy)
  // setElapsed(0)` in this body is the obvious shape and it is a cascading
  // render (react-hooks/set-state-in-effect), so the reset lives in submit()
  // instead - which is also the only place a turn can begin, so the counter is
  // provably 0 before `busy` ever flips. Setting state from the interval
  // CALLBACK is fine: that is the subscription this effect exists to hold.
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const submit = useCallback(
    (text: string) => {
      if (!text.trim() || busy) return;
      setInput("");
      setPinned(true);
      setElapsed(0);
      void send(text);
    },
    [busy, send],
  );

  const copyAnswer = useCallback(async (index: number, text: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(index);
      setTimeout(() => setCopied((current) => (current === index ? null : current)), 1600);
    } catch {
      // A blocked clipboard is not worth an error state: the text is on screen
      // and selectable, which is the fallback every browser already provides.
    }
  }, []);

  const empty = messages.length === 0 && !busy;

  return (
    <div
      // data-chat opens the shell's lg:h-full hatch. See the header comment.
      data-chat
      className="flex h-full min-h-[calc(100dvh-11rem)] flex-col overflow-hidden rounded-card bg-card ring-1 ring-line lg:min-h-[30rem]"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-2.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <VitalityMark practiceName={practiceName} size="turn" />
          <div className="min-w-0 leading-tight">
            <h1 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-navy">
              {COPILOT_PAGE_COPY.title}
            </h1>
            <p className="truncate text-[11.5px] text-muted">{copilotPageCopyFor(access).subtitle}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            reset();
            setInput("");
            setPinned(true);
            focusComposer();
          }}
          disabled={busy || messages.length === 0}
          // Named for the assistive layer as well as the visual one: below sm
          // the label is hidden and the button would otherwise be an icon with
          // no name at all.
          aria-label={COPILOT_PAGE_COPY.newThread}
          className="pressable flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] font-medium text-muted transition-colors hover:bg-row-hover hover:text-navy disabled:cursor-not-allowed disabled:opacity-45"
        >
          <SquarePen size={14} aria-hidden />
          <span className="hidden sm:inline">{COPILOT_PAGE_COPY.newThread}</span>
        </button>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={syncPinned}
          tabIndex={0}
          aria-label="Conversation"
          className="h-full overflow-y-auto outline-none"
        >
          <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
            {empty ? (
              <CopilotEmptyState practiceName={practiceName} onStart={submit} access={access} />
            ) : (
              <CopilotThreadView
                messages={messages}
                busy={busy}
                elapsed={elapsed}
                practiceName={practiceName}
                copiedIndex={copied}
                onCopy={copyAnswer}
              />
            )}
          </div>
        </div>

        {!pinned && !empty ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className="pressable absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-card px-3 py-1.5 text-[12px] font-medium text-navy shadow-chip"
          >
            <ArrowDown size={13} />
            {COPILOT_PAGE_COPY.jump}
          </button>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-line bg-card">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit(input);
          }}
          className="mx-auto w-full max-w-3xl px-4 py-3 sm:px-6"
        >
          <div className="flex items-end gap-2 rounded-2xl border border-line-strong bg-card px-3 py-1.5 transition-colors focus-within:border-blue-dark">
            <textarea
              ref={composerRef}
              rows={1}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit(input);
                }
              }}
              placeholder={COPILOT_PAGE_COPY.placeholder}
              aria-label={COPILOT_PAGE_COPY.placeholder}
              className="w-full resize-none bg-transparent py-2 text-[14.5px] leading-6 text-ink outline-none placeholder:text-faint"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              aria-label={COPILOT_PAGE_COPY.send}
              className="pressable mb-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-dark text-white transition-opacity disabled:opacity-40"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1">
            <p className="text-[11px] text-faint">{COPILOT_PAGE_COPY.ephemeral}</p>
            <p className="hidden text-[11px] text-faint sm:block">{COPILOT_PAGE_COPY.keys}</p>
          </div>
        </form>
      </div>
    </div>
  );
}
