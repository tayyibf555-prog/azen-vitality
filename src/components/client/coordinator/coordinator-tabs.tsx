"use client";

import { HeartPulse, MailCheck } from "lucide-react";
import { Tabs, type TabItem } from "@/components/primitives";
import { Worklist } from "./worklist";
import { CloserDraftsPanel } from "./closer-drafts";
import type { TreatmentOpportunity } from "@/lib/coordinator/types";
import type { CloserDraftView } from "@/lib/closer/types";

/**
 * Client wrapper for the Treatment Coordinator's two panels.
 *
 * Tabs is a client primitive (it holds the active-tab state) and the tab
 * definitions carry icon COMPONENTS, which cannot cross the RSC boundary as
 * props. So the definitions are built here, on the client, and the server view
 * fetches the data and hands down plain serialisable arrays — the same
 * arrangement NoshowTabs uses, and the reason it exists.
 *
 * The closer's drafts live as a TAB of this page rather than as a module of their
 * own on purpose: they are follow-ups on the same plans, for the same patients, in
 * front of the same people. A separate page would mean a second worklist to
 * remember to open, and drafts nobody opens are drafts nobody approves.
 */
export function CoordinatorTabs({
  opportunities,
  drafts,
  counts,
  nowIso,
  defaultKey = "worklist",
}: {
  opportunities: TreatmentOpportunity[];
  drafts: CloserDraftView[];
  counts: { awaiting: number; sent: number; replies: number };
  nowIso: string;
  /** Which panel opens first. The worklist, unless something asks otherwise. */
  defaultKey?: "worklist" | "closer";
}) {
  const tabs: TabItem[] = [
    {
      key: "worklist",
      label: "Worklist",
      icon: HeartPulse,
      badge: opportunities.length || undefined,
      content: <Worklist opportunities={opportunities} nowIso={nowIso} />,
    },
    {
      key: "closer",
      label: "Closer drafts",
      icon: MailCheck,
      // The badge is the number waiting on a human. It is the whole point of the
      // tab: a queue nobody can see the size of is a queue nobody works.
      badge: counts.awaiting || undefined,
      content: <CloserDraftsPanel drafts={drafts} counts={counts} nowIso={nowIso} />,
    },
  ];

  return <Tabs tabs={tabs} defaultKey={defaultKey} />;
}
