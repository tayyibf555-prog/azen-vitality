import { StatusPill, type Tone } from "@/components/primitives";
import { PanelEmpty, PanelFailed, PanelNote, PanelScope, PanelSection } from "./panel";
import { CANNOT_READ_COPY, EMPTY_COPY, FAILED_COPY } from "@/lib/patient/tabs";
import { londonDateTimeLabel } from "@/lib/time/london";
import type { Thread } from "@/lib/inbox/types";

/**
 * Correspondence, scoped in its own heading: MESSAGES SENT FROM THIS PLATFORM.
 *
 * The scope is stated up front rather than in a footnote, because the failure mode
 * here is a reader concluding "this patient has never been contacted" from a screen
 * that only ever knew about our own sends. Dentally's own letters, SMS and email are
 * not exposed through the connection we have, and the tab says so plainly.
 *
 * The thread is the per-patient view of the same stores the Conversations inbox
 * aggregates: the agent conversation spine plus the five per-module touch tables,
 * across SMS, email and WhatsApp. It is read through getThreadForPatient, which
 * filters at the query level instead of loading the whole site's threads to find one.
 *
 * THREE OUTCOMES, NEVER TWO. Each of the seven sources is read independently, so the
 * tab must distinguish "none were sent" from "some sources could not be read" from
 * "none could be read". It used to collapse all three into the first, which is the
 * exact sentence this tab's copy was written to avoid.
 */

const CHANNEL_TONE: Record<string, Tone> = {
  sms: "info",
  whatsapp: "whatsapp",
  email: "neutral",
  "after-hours": "warning",
};

export function TabCorrespondence({
  thread,
  failedSources = 0,
  totalSources = 0,
}: {
  thread: Thread | null;
  /** How many of the message stores threw. */
  failedSources?: number;
  totalSources?: number;
}) {
  const messages = thread?.messages ?? [];
  const allFailed = failedSources > 0 && failedSources >= totalSources;
  const someFailed = failedSources > 0 && !allFailed;

  return (
    <div className="space-y-5">
      {/* Her question was "does this link to the correspondence page on Dentally?" The
          honest answer is no, and it is stated up front in readable ink rather than as a
          footnote, because a reader who assumes it does would wrongly conclude a patient
          had not been contacted when Dentally alone holds the letter or SMS. */}
      <PanelScope title="What this shows">{CANNOT_READ_COPY.dentallyCorrespondence}</PanelScope>
      <PanelSection title="Messages sent from this platform">
        {someFailed ? <PanelFailed>{FAILED_COPY.partialCorrespondence}</PanelFailed> : null}
        {allFailed ? (
          <PanelFailed>{FAILED_COPY.correspondence}</PanelFailed>
        ) : messages.length === 0 ? (
          <PanelEmpty>{EMPTY_COPY.correspondence}</PanelEmpty>
        ) : (
          <ol className="space-y-2">
            {messages.map((m) => (
              <li
                key={m.id}
                className={
                  m.direction === "inbound"
                    ? "rounded-lg border border-line bg-card-muted/60 px-3 py-2.5"
                    : "rounded-lg border border-line bg-card px-3 py-2.5"
                }
              >
                <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                  <StatusPill tone={CHANNEL_TONE[m.channel] ?? "neutral"}>{m.channel}</StatusPill>
                  <span className="font-medium text-navy">
                    {m.direction === "inbound" ? "From patient" : "To patient"}
                  </span>
                  <span className="tabular-nums text-faint">{londonDateTimeLabel(m.at)}</span>
                  <span className="text-faint">{m.source}</span>
                </p>
                <p className="mt-1 whitespace-pre-wrap text-[13px] leading-[1.45] text-ink">{m.body}</p>
              </li>
            ))}
          </ol>
        )}
        {messages.length > 0 ? (
          <PanelNote>Bounded at the 400 most recent rows per source.</PanelNote>
        ) : null}
      </PanelSection>
    </div>
  );
}
