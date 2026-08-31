"use client";

import { useEffect, useMemo, useState } from "react";
import { StatusPill, type Tone } from "@/components/primitives";
import { PanelNote } from "./panel";
import { DELIVERY_LABEL, sourceLabel } from "@/lib/inbox/delivery";
import { londonDateTimeLabel } from "@/lib/time/london";
import { documentLabel } from "@/lib/dentally/documents-shape";
import {
  CORRESPONDENCE_PAGE_SIZE,
  CORRESPONDENCE_VIEW_COOKIE,
  pageCount,
  pageOf,
  pageRangeLabel,
  type CorrespondenceView,
} from "@/lib/patient/correspondence-view";
import { CORRESPONDENCE_COPY } from "@/lib/patient/tabs";
import type { CorrespondenceEntry } from "@/lib/inbox/correspondence-timeline";
import type { DeliveryStatus } from "@/lib/inbox/types";

/**
 * The correspondence timeline, and the Pages/List switch over it.
 *
 * A CLIENT COMPONENT, AND ONLY THIS PART OF THE TAB IS. TabCorrespondence stays a
 * server component: it holds the scope band, every health sentence and every caveat,
 * which are the parts a reader's trust depends on and the parts that must render even
 * if hydration never happens. Only the pager and the switch need state, so only they
 * cross the boundary.
 *
 * IT TAKES DATA AND NOTHING ELSE — no callbacks, no render props, no function of any
 * kind. That is the rule this repo learned the hard way: a component that crosses the
 * RSC boundary with function props builds clean and crashes at render (the DataTable /
 * Tabs regression). Everything here is a string, a number or a plain object.
 *
 * THE DOCUMENT LINK IS THE OTHER THING TO NOTICE. It points at a route of OURS, never
 * at the S3 URL Dentally returned, because that URL is presigned and expires in about
 * eleven and a half hours — see DentallyClient.getPatientDocuments. A record page
 * rendered this morning would otherwise carry links that are dead by tomorrow's clinic,
 * and a dead link on a consent record does not read as "expired", it reads as "gone".
 */

const CHANNEL_TONE: Record<string, Tone> = {
  sms: "info",
  whatsapp: "whatsapp",
  email: "neutral",
  "after-hours": "warning",
};

/**
 * Only a FAILED delivery is coloured. A row of green "Sent" tags on every message
 * turns the one red one into wallpaper, which is the caveat-chip failure this project
 * already shipped once; a delivered message is the expected case and needs no
 * decoration.
 */
const STATUS_TONE: Record<DeliveryStatus, Tone> = {
  sent: "neutral",
  failed: "danger",
  queued: "neutral",
  unknown: "neutral",
  draft: "neutral",
  discarded: "neutral",
};

/**
 * The word printed on every row saying WHAT IT IS.
 *
 * The owner's ask, from the call: every kind clearly labelled. A timeline that
 * interleaves four kinds of thing without naming them makes a reader infer the kind
 * from the shape of the card, which they will get wrong on the row that matters.
 */
function KindTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-[5px] border border-line bg-card-muted px-1.5 py-[1px] text-[10px] font-medium uppercase tracking-[0.3px] text-muted">
      {children}
    </span>
  );
}

function MessageRow({ entry }: { entry: Extract<CorrespondenceEntry, { kind: "message" }> }) {
  const m = entry.message;
  return (
    <li
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
        {/* An UNDELIVERED message is the one thing on this row a reader must not miss,
            so it is the only status that carries colour. An inbound message has no
            delivery status of ours to report. */}
        {m.direction === "outbound" && m.status && m.status !== "sent" ? (
          <StatusPill tone={STATUS_TONE[m.status]}>{DELIVERY_LABEL[m.status]}</StatusPill>
        ) : null}
        {m.actionedBy ? <span className="text-faint">Approved by {m.actionedBy}</span> : null}
        {m.alsoInDentally ? <span className="text-faint">Also in Dentally</span> : null}
      </p>
      <p className="mt-1 whitespace-pre-wrap text-[13px] leading-[1.45] text-ink">{m.body}</p>
    </li>
  );
}

function DocumentRow({
  entry,
  href,
}: {
  entry: Extract<CorrespondenceEntry, { kind: "document" }>;
  href: string | null;
}) {
  const d = entry.document;
  return (
    <li className="rounded-lg border border-line bg-card px-3 py-2.5">
      <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <KindTag>Document</KindTag>
        <span className="tabular-nums text-faint">{londonDateTimeLabel(d.at)}</span>
        <span className="text-faint">Dentally</span>
        {/* A document Dentally is still WAITING to have signed is the one state on this
            row that is an outstanding action, so it is the only one that carries
            colour — the same rule the message row applies to a failed delivery. */}
        {d.requiresSigning && !d.signed ? (
          <StatusPill tone="warning">Awaiting signature</StatusPill>
        ) : null}
      </p>
      <p className="mt-1 text-[13px] leading-[1.45] text-ink">{documentLabel(d)}</p>
      {href ? (
        <p className="mt-1">
          {/* rel="noopener" is not decoration here: the target is an attacker-uncontrolled
              but externally-hosted S3 object, and a new tab with a live window.opener
              handle back to an authed clinical record is not a handle worth giving away. */}
          <a
            className="text-[12px] font-medium text-status-blue underline underline-offset-2 hover:text-navy"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open document
          </a>
        </p>
      ) : (
        // NOT a broken link and NOT silence. A document with no reachable file is a
        // fact worth stating on a consent record; rendering the row with nothing to
        // click reads as an oversight.
        <p className="mt-1 text-[11px] text-faint">Dentally returned no file for this document.</p>
      )}
    </li>
  );
}

function EmailRow({ entry }: { entry: Extract<CorrespondenceEntry, { kind: "email" }> }) {
  const e = entry.email;
  return (
    <li className="rounded-lg border border-line bg-card px-3 py-2.5">
      <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <KindTag>Email</KindTag>
        <span className="font-medium text-navy">
          {e.direction === "inbound" ? "From patient" : "To patient"}
        </span>
        {e.at !== "" ? <span className="tabular-nums text-faint">{londonDateTimeLabel(e.at)}</span> : null}
        <span className="text-faint">Dentally</span>
      </p>
      {e.unreadable ? (
        // The row exists BECAUSE it could not be read. Drawing an empty card here would
        // read as an empty email, which is a different and wrong fact — see
        // ./emails-shape for why this row is kept at all.
        <p className="mt-1 text-[12.5px] italic leading-[1.45] text-muted">
          This email could not be read.
        </p>
      ) : (
        <>
          {e.subject !== "" ? (
            <p className="mt-1 text-[13px] font-medium leading-[1.45] text-navy">{e.subject}</p>
          ) : null}
          {e.body !== "" ? (
            <p className="mt-1 whitespace-pre-wrap text-[13px] leading-[1.45] text-ink">{e.body}</p>
          ) : null}
        </>
      )}
    </li>
  );
}

function EntryList({
  entries,
  documentHrefBase,
}: {
  entries: readonly CorrespondenceEntry[];
  documentHrefBase: string | null;
}) {
  return (
    <ol className="space-y-2">
      {entries.map((entry) => {
        if (entry.kind === "message") return <MessageRow key={entry.id} entry={entry} />;
        if (entry.kind === "email") return <EmailRow key={entry.id} entry={entry} />;
        return (
          <DocumentRow
            key={entry.id}
            entry={entry}
            href={
              documentHrefBase === null
                ? null
                : `${documentHrefBase}&documentId=${encodeURIComponent(entry.document.id)}`
            }
          />
        );
      })}
    </ol>
  );
}

export function CorrespondenceTimelineView({
  entries,
  undated,
  initialView,
  documentHrefBase,
}: {
  /** The dated timeline, OLDEST FIRST. */
  entries: CorrespondenceEntry[];
  /** Entries with no readable date. Rendered in their own group at the foot. */
  undated: CorrespondenceEntry[];
  /** The remembered layout, read from the cookie SERVER side so the first paint is right. */
  initialView: CorrespondenceView;
  /**
   * "/api/patient-documents?client=..&siteId=..&patientId=.." with the document id
   * appended per row, or null when the documents read is not switched on.
   *
   * A STRING, assembled by the server component. Passing a function that builds it
   * would put a callback across the RSC boundary, which is the crash this file's header
   * names.
   */
  documentHrefBase: string | null;
}) {
  const [view, setView] = useState<CorrespondenceView>(initialView);
  const [page, setPage] = useState(1);

  // THE SAME MECHANISM AS THE DIARY'S density and column toggles, deliberately: one
  // cookie, written here, read by the server component. Not localStorage — a layout
  // read after hydration renders the wrong shape first and corrects itself under the
  // reader, and a correspondence list that reshuffles as you start reading it makes
  // you doubt you read it.
  useEffect(() => {
    document.cookie = `${CORRESPONDENCE_VIEW_COOKIE}=${view}; path=/; max-age=31536000; samesite=lax`;
  }, [view]);

  const pages = pageCount(entries.length);
  // Switching to List and back must not leave the pager on a page that no longer
  // exists. pageOf clamps anyway, so this is belt to its braces: the RANGE LABEL is
  // computed from `page` and would otherwise print a range nobody is looking at.
  const current = Math.min(page, pages);
  const shown = useMemo(
    () => (view === "list" ? entries : pageOf(entries, current)),
    [view, entries, current],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {/* The switch the owner asked for: "I'll put a tab that they can switch between
            list and pages". Pages first, and default, because he leaned that way —
            "maybe do it the way dentally has it". */}
        <div
          className="inline-flex rounded-lg border border-line bg-card-muted p-0.5"
          role="group"
          aria-label="Correspondence layout"
        >
          {(["pages", "list"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => {
                setView(v);
                // Back to the newest page on every switch INTO pages. Returning to
                // page four of a history you were reading as a flat list is a
                // position you did not choose and cannot see the reason for.
                if (v === "pages") setPage(1);
              }}
              className={
                view === v
                  ? "rounded-[6px] bg-card px-3 py-1 text-[12px] font-semibold text-navy shadow-sm"
                  : "rounded-[6px] px-3 py-1 text-[12px] font-medium text-muted hover:text-navy"
              }
            >
              {v === "pages" ? "Pages" : "List"}
            </button>
          ))}
        </div>
        {view === "pages" && entries.length > CORRESPONDENCE_PAGE_SIZE ? (
          <p className="text-[11px] tabular-nums text-faint">{pageRangeLabel(entries.length, current)}</p>
        ) : null}
      </div>

      <EntryList entries={shown} documentHrefBase={documentHrefBase} />

      {view === "pages" && pages > 1 ? (
        <div className="flex items-center justify-between gap-3 border-t border-line pt-2.5">
          {/* "Newer" and "Older", not "Previous" and "Next". Page 1 is the newest
              slice, so "Next" would walk BACKWARDS through time and a reader has to
              stop and work out which way the arrow means. Directional words about the
              thing itself cannot be read the wrong way round. */}
          <button
            type="button"
            disabled={current <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded-lg border border-line px-3 py-1 text-[12px] font-medium text-navy disabled:cursor-not-allowed disabled:text-faint hover:enabled:bg-card-muted"
          >
            Newer
          </button>
          <span className="text-[11px] tabular-nums text-muted">
            Page {current} of {pages}
          </span>
          <button
            type="button"
            disabled={current >= pages}
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
            className="rounded-lg border border-line px-3 py-1 text-[12px] font-medium text-navy disabled:cursor-not-allowed disabled:text-faint hover:enabled:bg-card-muted"
          >
            Older
          </button>
        </div>
      ) : null}

      {undated.length > 0 ? (
        <div className="space-y-2 border-t border-line pt-3">
          <p className="text-[12px] font-semibold text-navy">Could not be placed in time</p>
          <PanelNote>{CORRESPONDENCE_COPY.undatedEntries}</PanelNote>
          <EntryList entries={undated} documentHrefBase={documentHrefBase} />
        </div>
      ) : null}
    </div>
  );
}
