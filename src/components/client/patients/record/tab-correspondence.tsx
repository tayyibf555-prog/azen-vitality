import { StatusPill, type Tone } from "@/components/primitives";
import { PanelEmpty, PanelFailed, PanelNote, PanelScope, PanelSection } from "./panel";
import {
  CORRESPONDENCE_COPY,
  EMPTY_COPY,
  FAILED_COPY,
  partialCorrespondenceCopy,
} from "@/lib/patient/tabs";
import { DELIVERY_LABEL, sourceLabel } from "@/lib/inbox/delivery";
import { londonDateTimeLabel } from "@/lib/time/london";
import type { DeliveryStatus, InboxMessage } from "@/lib/inbox/types";
import type { DentallySmsHealth } from "@/lib/dentally/sms";

/**
 * Correspondence: what this platform has said to this patient, and what came back.
 *
 * NOT "every message", in either direction, and the copy no longer says so. Three
 * exceptions are real and named ON THE SCREEN: a message we sent to a number that
 * could not be matched to this record (filed under lead:<number>, which the record
 * read never looks at), a reply to a waitlist slot offer, and a STOP from a number
 * in no campaign. A heading claiming completeness over any of them is the defect
 * this file keeps re-learning.
 *
 * WHAT CHANGED AND WHY. This tab used to read five of the platform's message stores.
 * The platform has twelve. The treatment-plan closer, the balance reminder, the
 * aftercare check-in, segment campaigns, appointment-change notifications and every
 * first reply to a new enquiry were all absent — under a heading that says "Messages
 * sent from this platform" and an empty state that says none were. A coordinator
 * ringing a patient the balance agent had already texted three times had no way to
 * know from this screen.
 *
 * It also showed no delivery status at all, so a message the network REFUSED rendered
 * byte-for-byte like one that arrived. That is the more dangerous of the two: an
 * incomplete list understates, an undelivered message shown as delivered actively
 * tells a reader the patient was informed when they were not.
 *
 * FOUR OUTCOMES, NOT THREE. Each source is read independently, so the tab must
 * distinguish "none were sent" from "some sources could not be read" from "none could
 * be read" from "Dentally's own history is not switched on". The failed sources are
 * NAMED, because a count tells a reader something is missing without telling them
 * where to go and look.
 *
 * THE SCOPE BAND IS LOAD-BEARING. It says, in readable ink at the top, that this
 * history lives in the platform and is NOT written back into Dentally. Without that
 * sentence a colleague working in Dentally sees an empty correspondence page and
 * concludes the patient was never contacted.
 */

const CHANNEL_TONE: Record<string, Tone> = {
  sms: "info",
  whatsapp: "whatsapp",
  email: "neutral",
  "after-hours": "warning",
};

/**
 * Only a FAILED delivery is coloured. A row of green "Sent" tags on every message
 * turns the one red one into wallpaper, which is the caveat-chip failure this
 * project already shipped once; a delivered message is the expected case and needs
 * no decoration. Waiting and unknown are quiet neutral, because neither is a
 * problem — they are just not a delivery.
 */
const STATUS_TONE: Record<DeliveryStatus, Tone> = {
  sent: "neutral",
  failed: "danger",
  queued: "neutral",
  unknown: "neutral",
  draft: "neutral",
  discarded: "neutral",
};

export function TabCorrespondence({
  messages,
  failedSources = [],
  totalSources = 0,
  dentally = "off",
}: {
  /** Every message, oldest first. */
  messages: InboxMessage[];
  /** Human labels of the platform sources that threw. */
  failedSources?: string[];
  totalSources?: number;
  /** Whether Dentally's own SMS log was read, failed, or is switched off. */
  dentally?: DentallySmsHealth;
}) {
  const failedCount = failedSources.length;
  const allFailed = failedCount > 0 && failedCount >= totalSources;
  const someFailed = failedCount > 0 && !allFailed;
  const anyFailed = failedCount > 0 || dentally === "failed";

  return (
    <div className="space-y-5">
      {/* The practice manager's question was "does this link to the correspondence
          page on Dentally?". The honest answer is that it reads Dentally's SMS when
          that is switched on, and writes nothing back either way — stated up front in
          readable ink rather than as a footnote, because a reader who assumes
          otherwise draws a false conclusion about a patient in both directions. */}
      <PanelScope title="What this shows">
        {dentally === "ok" ? CORRESPONDENCE_COPY.scopeWithDentally : CORRESPONDENCE_COPY.scopePlatformOnly}
      </PanelScope>
      <PanelSection title="Message history">
        {someFailed ? <PanelFailed>{partialCorrespondenceCopy(failedSources)}</PanelFailed> : null}
        {/* Which total-failure sentence depends on whether ANYTHING is on screen.
            "We could not read this patient's message history" printed above a visible
            list of Dentally's messages reads as a contradiction, and a reader resolves
            a contradiction by believing the list. */}
        {allFailed ? (
          <PanelFailed>
            {dentally === "ok" && messages.length > 0
              ? CORRESPONDENCE_COPY.platformFailedDentallyOk
              : FAILED_COPY.correspondence}
          </PanelFailed>
        ) : null}
        {dentally === "failed" ? <PanelFailed>{CORRESPONDENCE_COPY.dentallyFailed}</PanelFailed> : null}
        {messages.length === 0 && !allFailed ? (
          <>
            <PanelEmpty>
              {/* The WIDER claim - that Dentally holds nothing either - may only be made
                  when Dentally was actually read. Switched off or failed, the narrower
                  platform-only sentence is the only true one.

                  BOTH now carry the Conversations-inbox pointer, because an empty panel
                  here is the tab's most dangerous state: a patient texted minutes ago on
                  a number identifyByPhone could not match is filed under lead:<number>,
                  which this read never looks at, and the bare sentence told the reader
                  in writing that nothing had been sent. */}
              {dentally === "ok" && !anyFailed
                ? EMPTY_COPY.correspondenceWithDentally
                : EMPTY_COPY.correspondence}
            </PanelEmpty>
            {/* The inbound exceptions belong here as much as beside a list: "no messages"
                is also a claim about what came back, and a reply to a waitlist offer
                cannot reach this screen at all. Previously these notes rendered ONLY when
                the list was non-empty, so the emptiest screen made the widest claim with
                the fewest caveats. */}
            <PanelNote>{CORRESPONDENCE_COPY.inboundGaps}</PanelNote>
          </>
        ) : null}
        {messages.length > 0 ? (
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
                  <span className="text-faint">{sourceLabel(m.source)}</span>
                  {/* An UNDELIVERED message is the one thing on this row a reader must
                      not miss, so it is the only status that carries colour. An
                      inbound message has no delivery status of ours to report. */}
                  {m.direction === "outbound" && m.status && m.status !== "sent" ? (
                    <StatusPill tone={STATUS_TONE[m.status]}>{DELIVERY_LABEL[m.status]}</StatusPill>
                  ) : null}
                  {m.actionedBy ? <span className="text-faint">Approved by {m.actionedBy}</span> : null}
                  {m.alsoInDentally ? <span className="text-faint">Also in Dentally</span> : null}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-[13px] leading-[1.45] text-ink">{m.body}</p>
              </li>
            ))}
          </ol>
        ) : null}
        {messages.length > 0 ? (
          <>
            <PanelNote>{CORRESPONDENCE_COPY.sentMeaning}</PanelNote>
            <PanelNote>{CORRESPONDENCE_COPY.draftsExcluded}</PanelNote>
            {/* THE OUTBOUND EXCEPTION, next to the list rather than inferred from an
                absence. Every send path records, but a record row keyed lead:<number> is
                on a conversation this patient's read never touches, and identification
                fails routinely: it matches mobile_phone only, and the missed-call lookup
                is capped at 3 seconds. */}
            <PanelNote>{CORRESPONDENCE_COPY.unmatchedNumbers}</PanelNote>
            {/* The scope paragraph above claims every message this platform SENT, with
                that one exception. It does not claim the same of what came back, so the
                two replies that cannot reach this list are named here too, next to the
                list a reader is scanning. */}
            <PanelNote>{CORRESPONDENCE_COPY.inboundGaps}</PanelNote>
            {/* Was a bare string in this JSX, which is the one thing this tab's copy rules
                forbid: an untested sentence making a claim about completeness. */}
            <PanelNote>{CORRESPONDENCE_COPY.boundedRows}</PanelNote>
          </>
        ) : null}
      </PanelSection>
    </div>
  );
}
