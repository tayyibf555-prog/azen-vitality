"use client";

import { useMemo } from "react";
import { CalendarClock, CalendarOff, Clock, FileSignature, FileText, Link2Off } from "lucide-react";
import { Tabs, type TabItem } from "@/components/primitives";
import type { AbsenceRow } from "@/lib/absence/types";
import { linkMissingCopy, selfRequestStaffId } from "@/lib/my-work/rules";
import { MyClockTab } from "./my-clock-tab";
import { MyDocumentsTab } from "./my-documents-tab";
import { MyHolidayTab } from "./my-holiday-tab";
import { MyRotaTab } from "./my-rota-tab";
import { MySignaturesTab } from "./my-signatures-tab";
import { useSelfServiceRead } from "./use-self-service";
import { myHolidayUrl } from "./shared";

// MY WORK — one slug, five tabs, every one of them scoped to the caller.
//
// IDENTITY IS RESOLVED ONCE, HERE. `GET /api/absence` returns the staff record
// the session maps to (`me`, from rota_staff.app_user_id) alongside the holiday
// rows, so a single read gives every tab the one fact they all depend on. That
// read's own state is passed down: while it is in flight every tab says
// "loading", and if it FAILS every tab says so — a tab that cheerfully rendered
// "you have no documents" because we could not work out who you are would be
// the worst version of this screen.
//
// A login with no staff link is a normal state, not an error: most logins (the
// owner, the agency) are not on the rota. Every tab says the same sentence and
// names the remedy, which is the wording the clocking route already uses.

interface AbsenceResponse {
  ok?: boolean;
  canManage?: boolean;
  linked?: boolean;
  me?: { id: string; name: string; role: string; siteId: string | null } | null;
  absences?: AbsenceRow[];
  error?: string;
}

export function MyWorkWorkspace({
  clientSlug,
  today,
}: {
  clientSlug: string;
  /** London day key, resolved on the server so SSR and the browser agree. */
  today: string;
}) {
  const { data, loading, failure, reload } = useSelfServiceRead<AbsenceResponse>(myHolidayUrl(clientSlug));

  const selfStaffId = selfRequestStaffId(data?.me ?? null);
  const rows = useMemo(() => data?.absences ?? [], [data]);

  // Only ever a badge when the read SUCCEEDED. A "0" drawn from a failed read
  // is a claim we cannot make; no badge at all makes no claim.
  const pendingBadge =
    !loading && !failure && selfStaffId ? rows.filter((r) => r.status === "pending").length : undefined;

  const tabs: TabItem[] = [
    {
      key: "rota",
      label: "My rota",
      icon: CalendarClock,
      content: <MyRotaTab clientSlug={clientSlug} today={today} selfStaffId={selfStaffId} />,
    },
    {
      key: "holiday",
      label: "My holiday",
      icon: CalendarOff,
      badge: pendingBadge && pendingBadge > 0 ? pendingBadge : undefined,
      content: (
        <MyHolidayTab
          clientSlug={clientSlug}
          selfStaffId={selfStaffId}
          rows={rows}
          loading={loading}
          failure={failure}
          onChanged={reload}
        />
      ),
    },
    {
      key: "clock",
      label: "My clock",
      icon: Clock,
      content: (
        <MyClockTab
          clientSlug={clientSlug}
          selfStaffId={selfStaffId}
          identityLoading={loading}
          identityFailure={failure}
        />
      ),
    },
    {
      key: "documents",
      label: "My documents",
      icon: FileText,
      content: (
        <MyDocumentsTab
          clientSlug={clientSlug}
          today={today}
          selfStaffId={selfStaffId}
          identityLoading={loading}
          identityFailure={failure}
        />
      ),
    },
    {
      key: "signatures",
      label: "My signatures",
      icon: FileSignature,
      content: (
        <MySignaturesTab
          clientSlug={clientSlug}
          today={today}
          selfStaffId={selfStaffId}
          identityLoading={loading}
          identityFailure={failure}
        />
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {/* The one banner that belongs above the tabs rather than inside one of
          them: without a staff link NOTHING on this page can be answered, and
          saying it once at the top beats saying it four times. Each tab still
          says it too, because a person who lands on a tab directly must not be
          shown a blank panel. */}
      {!loading && !failure && selfStaffId === null ? (
        <p className="flex items-start gap-2 rounded-xl border border-line bg-card-muted/20 px-4 py-3 text-[13px] text-muted">
          <Link2Off size={16} className="mt-0.5 shrink-0" />
          <span>{linkMissingCopy("this page has nothing to show you yet")}</span>
        </p>
      ) : null}

      <Tabs tabs={tabs} defaultKey="rota" />
    </div>
  );
}
