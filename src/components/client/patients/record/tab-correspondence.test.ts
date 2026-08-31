import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { CORRESPONDENCE_COPY, EMPTY_COPY, FAILED_COPY } from "@/lib/patient/tabs";
import { buildCorrespondenceTimeline } from "@/lib/inbox/correspondence-timeline";
import type { InboxMessage } from "@/lib/inbox/types";
import type { DentallyDocumentRecord } from "@/lib/dentally/documents-shape";
import type { DentallyEmailRecord } from "@/lib/dentally/emails-shape";
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
//
// NOTE ON renderToStaticMarkup AND THE CLIENT HALF. The timeline list is a client
// component, which renderToStaticMarkup renders exactly like any other component —
// it just never hydrates. So the ROWS and the Pages/List switch ARE in the markup
// these tests read, and the interactive behaviour (which page you are on) is
// proven separately and purely in correspondence-view.test.ts. That split is
// deliberate: the assertions here are about what a reader is TOLD, and those must
// hold whether or not JavaScript ever ran.
// ===========================================================================

type Props = Parameters<typeof TabCorrespondence>[0];

/**
 * Render with a timeline built from whatever kinds the case needs.
 *
 * The ROW arrays are named `*Rows` and the HEALTH props keep their own names
 * (`documents`, `emails`), because those two are genuinely different things and the tab
 * takes the health ones. Letting `documents` mean an array here and a health value
 * there is exactly the collision that invites a cast to silence it, and a cast in a
 * test is a test that has stopped checking the type it was written to check.
 */
function render(
  props: Omit<Props, "timeline"> & {
    messageRows?: InboxMessage[];
    documentRows?: DentallyDocumentRecord[];
    emailRows?: DentallyEmailRecord[];
  },
): string {
  const { messageRows = [], documentRows = [], emailRows = [], ...rest } = props;
  return renderToStaticMarkup(
    createElement(TabCorrespondence, {
      ...rest,
      timeline: buildCorrespondenceTimeline(messageRows, documentRows, emailRows),
    }),
  );
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

/** A signed iPad form, shaped exactly as live Dentally returned one on 2026-08-31. */
const FORM: DentallyDocumentRecord = {
  id: "108698849",
  description: "NHS PR",
  formId: "nhs_pr_en",
  at: "2026-08-04T12:25:20.813+01:00",
  signed: true,
  signedAt: "2026-08-04T12:25:20.813+01:00",
  requiresSigning: false,
  url: "https://dentally-assets.s3.eu-west-1.amazonaws.com/uploads/practice_57/patient_15/x",
  appointmentIds: [],
};

/**
 * An UPLOAD: no form_id. Never observed on live — every one of the eight real rows was
 * a form — which is precisely why it is pinned here. The first scanned letter to arrive
 * must not be described to a clinician as something the patient signed.
 */
const UPLOAD: DentallyDocumentRecord = {
  ...FORM,
  id: "999",
  description: "MH scan",
  formId: null,
  signed: false,
  signedAt: null,
  at: "2026-08-05T09:00:00.000Z",
};

describe("the empty state does not claim more than it knows", () => {
  it("points at the Conversations inbox, the way the failed state already did", () => {
    const out = text(render({ failedSources: [], totalSources: 3 }));
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
    const out = text(render({ failedSources: [], totalSources: 3, dentally: "ok" }));
    expect(out).toContain(EMPTY_COPY.correspondenceWithDentally);
    expect(out).toContain("Dentally holds no SMS for them either.");
    expect(out).toContain("check there before assuming this patient has not been contacted");
  });

  it("names the inbound gaps on an empty screen, not only beside a list", () => {
    // "No messages" is a claim about what came back as well as what went out, and a
    // reply to a waitlist slot offer cannot reach this list at all.
    const out = text(render({ failedSources: [], totalSources: 3 }));
    expect(out).toContain(CORRESPONDENCE_COPY.inboundGaps);
  });

  it("does not print the empty sentence when the read FAILED", () => {
    // The older rule, re-checked from the markup: an outage must never be able to
    // make a positive claim about a patient.
    const out = text(render({ failedSources: ["Message history"], totalSources: 1 }));
    expect(out).toContain(FAILED_COPY.correspondence);
    expect(out).not.toContain(EMPTY_COPY.correspondence);
    // And the empty-state caveats do not appear either: there is nothing to caveat.
    expect(out).not.toContain(CORRESPONDENCE_COPY.inboundGaps);
  });
});

describe("a screen with messages says what can still be missing", () => {
  it("names the unmatched-number exception beside the list", () => {
    const out = text(render({ messageRows: [MESSAGE], failedSources: [], totalSources: 3 }));
    expect(out).toContain(MESSAGE.body);
    expect(out).toContain(CORRESPONDENCE_COPY.unmatchedNumbers);
    expect(out).toContain(CORRESPONDENCE_COPY.inboundGaps);
    expect(out).toContain(CORRESPONDENCE_COPY.boundedRows);
  });

  it("states the exception in the scope band, which is on screen in EVERY state", () => {
    for (const messages of [[], [MESSAGE]]) {
      const out = text(render({ messageRows: messages, failedSources: [], totalSources: 3 }));
      expect(out).toContain(
        "The one exception is a message sent to a number that could not be matched to this record",
      );
    }
  });
});

// ===========================================================================
// WHAT THE 2026-08-31 PROBES CHANGED. The tab asserted that Dentally's "letters,
// email and scanned documents are not [shown], because Dentally does not return
// them". Two thirds of that was false. These tests hold the correction in place —
// including the third that is still TRUE, which must keep being said.
// ===========================================================================

describe("the tab no longer claims Dentally withholds emails and documents", () => {
  it("the scope band never says Dentally does not return them", () => {
    // THE EXACT DEAD SENTENCE, in every state the band can render in. Asserting on the
    // new copy alone would pass while the old clause sat somewhere else on the screen.
    for (const dentally of ["off", "ok", "failed"] as const) {
      for (const documents of ["off", "ok", "failed"] as const) {
        const out = text(render({ messageRows: [MESSAGE], dentally, documents, totalSources: 3 }));
        expect(out).not.toContain("because Dentally does not return them");
        expect(out).not.toContain("its letters, email and scanned documents are not");
      }
    }
  });

  it("says documents are included ONLY when the documents read actually ran", () => {
    // A scope sentence promising documents while the read is off is the same failure as
    // the sentence it replaced, pointing the other way.
    const on = text(render({ messageRows: [MESSAGE], documents: "ok", totalSources: 3 }));
    expect(on).toContain(CORRESPONDENCE_COPY.scopeDocuments);
    for (const documents of ["off", "failed"] as const) {
      const out = text(render({ messageRows: [MESSAGE], documents, totalSources: 3 }));
      expect(out).not.toContain(CORRESPONDENCE_COPY.scopeDocuments);
    }
  });

  it("still says scanned paper is unreachable, because that third is still true", () => {
    // Every one of the eight live documents was a signed form; /v1/documents and
    // /v1/patient_files both 404. Dropping this caveat along with the false ones would
    // let the document list read as the whole of Dentally's correspondence page.
    const out = text(render({ messageRows: [MESSAGE], documents: "ok", totalSources: 3 }));
    expect(out).toContain(CORRESPONDENCE_COPY.scannedUploadsUnreadable);
    expect(out).toContain("Open this patient in Dentally to see anything that was scanned in.");
  });

  it("reports an EMPTY email read as a fact about the connection, never about the patient", () => {
    const out = text(render({ messageRows: [MESSAGE], emails: "ok", totalSources: 3 }));
    expect(out).toContain(CORRESPONDENCE_COPY.emailsEmpty);
    // The forbidden phrasing: the connection returned none on every patient checked,
    // which is not the same claim as this patient having none.
    expect(out).not.toContain("This patient has no emails");
    expect(out).not.toContain("no emails have been sent to this patient");
  });
});

describe("the timeline carries every kind, each labelled", () => {
  it("renders messages, documents and emails together on one list", () => {
    const email: DentallyEmailRecord = {
      id: "e1",
      subject: "Your treatment plan",
      body: "Please find your plan attached.",
      direction: "outbound",
      at: "2026-08-06T10:00:00.000Z",
      externalProvider: false,
      unreadable: false,
    };
    const out = text(
      render({
        messageRows: [MESSAGE],
        documentRows: [FORM],
        emailRows: [email],
        dentally: "ok",
      }),
    );
    expect(out).toContain(MESSAGE.body);
    expect(out).toContain("NHS PR");
    expect(out).toContain("Your treatment plan");
    // The KIND is named on the row rather than left to be inferred from its shape.
    expect(out).toContain("Document");
    expect(out).toContain("Email");
  });

  it("labels an upload with the owner's own word, and a form with its description", () => {
    // The owner asked, on the call, that uploads be labelled "Upload". A form carries
    // its Dentally description and its signed state instead — the two must never be
    // rendered alike, because one is something the patient signed and one is not.
    const out = text(render({ documentRows: [FORM, UPLOAD], totalSources: 3 }));
    expect(out).toContain("NHS PR · signed");
    expect(out).toContain("Upload");
    // And the upload is NOT described as signed.
    expect(out).not.toContain("MH scan · signed");
  });

  it("links a document at OUR route, never at the expiring S3 url", () => {
    // The S3 link carries X-Amz-Expires of ~11.5 hours. Baking it into the page gives a
    // link that is dead by the next morning, and a dead link on a consent record reads
    // as "the document is gone".
    const markup = render({
      documentRows: [FORM],
      documentHrefBase: "/api/patient-documents?client=vitality&siteId=s1&patientId=p1",
    });
    expect(markup).toContain("/api/patient-documents?client=vitality&amp;siteId=s1");
    expect(markup).toContain(`documentId=${FORM.id}`);
    expect(markup).not.toContain("dentally-assets.s3");
    // A new tab onto an external host must not keep a live opener handle back to an
    // authed clinical record.
    expect(markup).toContain('rel="noopener noreferrer"');
  });
});

describe("an unreadable kind degrades honestly rather than silently", () => {
  it("names the failing Dentally read, one sentence per kind", () => {
    // One combined "part of Dentally could not be read" would leave a reader unable to
    // tell whether they are missing a text message or a signed consent form.
    const docs = text(render({ messageRows: [MESSAGE], documents: "failed", totalSources: 3 }));
    expect(docs).toContain(CORRESPONDENCE_COPY.documentsFailed);
    const mail = text(render({ messageRows: [MESSAGE], emails: "failed", totalSources: 3 }));
    expect(mail).toContain(CORRESPONDENCE_COPY.emailsFailed);
    const sms = text(render({ messageRows: [MESSAGE], dentally: "failed", totalSources: 3 }));
    expect(sms).toContain(CORRESPONDENCE_COPY.dentallyFailed);
  });

  it("distinguishes a HALF-read of email from a whole one and from a failure", () => {
    // Dentally keeps email in two buckets and they fail independently. "ok" would
    // overstate; "failed" would discard the half that worked.
    const out = text(render({ messageRows: [MESSAGE], emails: "partial", totalSources: 3 }));
    expect(out).toContain(CORRESPONDENCE_COPY.emailsPartial);
    expect(out).not.toContain(CORRESPONDENCE_COPY.emailsFailed);
  });

  it("counts email rows it could not parse instead of dropping or blanking them", () => {
    const unreadable: DentallyEmailRecord = {
      id: "unreadable:own:0",
      subject: "",
      body: "",
      direction: "outbound",
      at: "",
      externalProvider: false,
      unreadable: true,
    };
    const out = text(render({ emailRows: [unreadable] }));
    expect(out).toContain("This email could not be read.");
  });

  it("says an unreadable-email COUNT out loud when the read reports one", () => {
    const out = text(render({ messageRows: [MESSAGE], emails: "ok", unreadableEmails: 2, totalSources: 3 }));
    expect(out).toContain(CORRESPONDENCE_COPY.emailsUnreadable);
  });
});

describe("an incomplete history SAYS it is incomplete", () => {
  it("prints the cut-short sentence when a Dentally read could not reach the end", () => {
    // THE OWNER'S COMPLAINT: "it only goes back to a certain date, which is only to
    // May". A history quietly missing everything before May tells a reader, by saying
    // nothing, that nothing was said before May.
    const out = text(
      render({ messageRows: [MESSAGE], dentally: "ok", dentallyComplete: false, totalSources: 3 }),
    );
    expect(out).toContain(CORRESPONDENCE_COPY.dentallyHistoryIncomplete);
    expect(out).toContain("This is not the whole of Dentally's history for this patient.");
  });

  it("says nothing about completeness when the read DID reach the end", () => {
    // A caveat that is always on is a caveat nobody reads.
    const out = text(
      render({ messageRows: [MESSAGE], dentally: "ok", dentallyComplete: true, totalSources: 3 }),
    );
    expect(out).not.toContain(CORRESPONDENCE_COPY.dentallyHistoryIncomplete);
  });

  it("keeps an undated entry on the screen, in its own group, rather than dropping it", () => {
    // An empty timestamp sorts before every real one, so sorting it in would render an
    // undated document at the TOP of the record as the oldest thing on it.
    const undated: DentallyDocumentRecord = { ...FORM, id: "777", at: "" };
    const out = text(render({ messageRows: [MESSAGE], documentRows: [undated], totalSources: 3 }));
    expect(out).toContain("Could not be placed in time");
    expect(out).toContain(CORRESPONDENCE_COPY.undatedEntries);
  });
});

describe("the Pages/List switch is on the screen", () => {
  it("offers both layouts, with the owner's default of Pages pressed", () => {
    const markup = render({ messageRows: [MESSAGE], view: "pages", totalSources: 3 });
    const out = text(markup);
    expect(out).toContain("Pages");
    expect(out).toContain("List");
    // aria-pressed is what carries "which one am I looking at" to a screen reader, and
    // it is also the only machine-readable proof the server-read cookie reached the
    // first paint rather than being corrected after hydration.
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Pages/);
  });

  it("honours a remembered List choice in the FIRST paint", () => {
    const markup = render({ messageRows: [MESSAGE], view: "list", totalSources: 3 });
    expect(markup).toMatch(/aria-pressed="true"[^>]*>List/);
  });
});
