"use client";

import Link from "next/link";
import { usePatientQuickView } from "./patient-quick-view-provider";

/**
 * A patient's name, anywhere in the app, as a REAL link to their record.
 *
 * Two behaviours in one element, and both matter:
 *
 *  1. It renders a genuine <a href> to /…/patients/<id>. That restores middle-click,
 *     cmd-click, "copy link address" and open-in-new-tab, none of which work today
 *     because the callers are either <tr onClick> handlers or links that navigate to
 *     a LIST page with ?patient=<id>.
 *
 *  2. A plain left click (no modifier, primary button) is intercepted and opens the
 *     QUICK OVERVIEW in place instead of navigating. You are mid-task in the diary or
 *     on the dashboard and usually only need to check one thing; leaving the page to
 *     do it is the trade this rebuild rejects. The overview carries a "View full
 *     patient profile" button whose href is exactly this anchor's href.
 *
 * WHEN siteId IS NULL it does not intercept and simply navigates to the record page.
 * Every patient read is site-scoped by design (the IDOR fix, non-negotiable), so the
 * overview cannot be fetched without a site; the record page resolves the site
 * server-side, so the link still works. Guessing a site here would be the one thing
 * this must never do.
 */
export function PatientLink({
  patientId,
  siteId,
  basePath,
  patientName,
  className,
  children,
}: {
  patientId: string;
  /** The patient's site. Null when the calling row genuinely does not carry one. */
  siteId: string | null;
  /** "/c/<client>" or "/owner/<client>", so the same component works in both trees. */
  basePath: string;
  /** Only used to label the overview while it loads. Never used to identify anyone. */
  patientName?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const quickView = usePatientQuickView();
  const href = `${basePath}/patients/${encodeURIComponent(patientId)}`;

  return (
    <Link
      href={href}
      className={className}
      onClick={(e) => {
        if (!quickView || !siteId) return; // navigate to the record page
        // Let the browser do its normal thing for every modified click, so
        // cmd/ctrl/shift/alt-click and middle-click still open a tab or a window.
        if (e.defaultPrevented) return;
        if (e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        quickView.open({ patientId, siteId, href, patientName });
      }}
    >
      {children}
    </Link>
  );
}
