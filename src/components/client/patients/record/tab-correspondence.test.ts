import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { CORRESPONDENCE_COPY, EMPTY_COPY, FAILED_COPY } from "@/lib/patient/tabs";
import type { InboxMessage } from "@/lib/inbox/types";
import { TabCorrespondence } from "./tab-correspondence";

// ===========================================================================
// THE CORRESPONDENCE TAB, PROVEN BY RENDERING IT.
//
// vitest collects only src/**/*.test.ts, so a .tsx file cannot BE a test — but a
// .ts test can import one and react-dom/server will render it. That distinction
// matters here more than anywhere on the record: the copy constants were all
// individually correct and TESTED, and the screen still made a false claim,
// because the honest sentences were only wired into the branch that had messages
// in it. `messages.length > 0` gated every caveat on this tab, so the emptiest
// screen — the one a coordinator reads as "nobody has contacted her" — carried
// none of them. A constant nothing renders is not copy.
//
// WHY THE EMPTY STATE IS THE DANGEROUS ONE. A message we sent to a number
// identifyByPhone could not match is filed under `lead:<number>`, and the record
// read (loadAgentMessagesForPatient) only looks under the Dentally id. That is not
// exotic: identification matches on `mobile_phone` alone, so a landline, a work
// number or a shared family number misses, and the missed-call lookup is capped at
// 3 seconds so a slow Dentally demotes a patient we could have named. The panel
// then says "no messages" about a patient texted minutes ago.
// ===========================================================================

function render(props: Parameters<typeof TabCorrespondence>[0]): string {
  return renderToStaticMarkup(createElement(TabCorrespondence, props));
}

/** Markup carries HTML entities; compare on the text a reader actually sees. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const MESSAGE: InboxMessage = {
  id: "agent:1",
  contactRef: "patient:pat-1",
  contactName: "Sarah Ahmed",
  channel: "sms",
  direction: "outbound",
  body: "Thanks for confirming, we look forward to seeing you.",
  at: "2026-08-20T09:00:00.000Z",
  source: "agent",
  status: "sent",
  actionedBy: null,
};

describe("the empty state does not claim more than it knows", () => {
  it("points at the Conversations inbox, the way the failed state already did", () => {
    const out = text(render({ messages: [], failedSources: [], totalSources: 3 }));
    // The constant is what is wired...
    expect(out).toContain(EMPTY_COPY.correspondence);
    // ...and these are the WORDS, spelled out rather than read back from the same
    // constant. Asserting only `toContain(EMPTY_COPY.correspondence)` would pass
    // against any sentence at all, including the bare "No messages have been sent
    // to this patient from this platform." that made the false claim.
    expect(out).toContain("No messages to this patient have been recorded from this platform.");
    expect(out).toContain("check there before assuming this patient has not been contacted");
    expect(out).toContain("could not be matched to this record is held in the Conversations inbox");
  });

  it("carries the pointer in the WITH-Dentally empty state too", () => {
    const out = text(
      render({ messages: [], failedSources: [], totalSources: 3, dentally: "ok" }),
    );
    expect(out).toContain(EMPTY_COPY.correspondenceWithDentally);
    expect(out).toContain("Dentally holds no SMS for them either.");
    expect(out).toContain("check there before assuming this patient has not been contacted");
  });

  it("names the inbound gaps on an empty screen, not only beside a list", () => {
    // "No messages" is a claim about what came back as well as what went out, and a
    // reply to a waitlist slot offer cannot reach this list at all.
    const out = text(render({ messages: [], failedSources: [], totalSources: 3 }));
    expect(out).toContain(CORRESPONDENCE_COPY.inboundGaps);
  });

  it("does not print the empty sentence when the read FAILED", () => {
    // The older rule, re-checked from the markup: an outage must never be able to
    // make a positive claim about a patient.
    const out = text(render({ messages: [], failedSources: ["Message history"], totalSources: 1 }));
    expect(out).toContain(FAILED_COPY.correspondence);
    expect(out).not.toContain(EMPTY_COPY.correspondence);
    // And the empty-state caveats do not appear either: there is nothing to caveat.
    expect(out).not.toContain(CORRESPONDENCE_COPY.inboundGaps);
  });
});

describe("a screen with messages says what can still be missing", () => {
  it("names the unmatched-number exception beside the list", () => {
    const out = text(render({ messages: [MESSAGE], failedSources: [], totalSources: 3 }));
    expect(out).toContain(MESSAGE.body);
    expect(out).toContain(CORRESPONDENCE_COPY.unmatchedNumbers);
    expect(out).toContain(CORRESPONDENCE_COPY.inboundGaps);
    expect(out).toContain(CORRESPONDENCE_COPY.boundedRows);
  });

  it("states the exception in the scope band, which is on screen in EVERY state", () => {
    for (const messages of [[], [MESSAGE]]) {
      const out = text(render({ messages, failedSources: [], totalSources: 3 }));
      expect(out).toContain(
        "The one exception is a message sent to a number that could not be matched to this record",
      );
    }
  });
});
