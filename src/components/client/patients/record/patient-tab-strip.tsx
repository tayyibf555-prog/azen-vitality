"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { PATIENT_TABS, patientTabHref } from "@/lib/patient/tabs";
import { cn } from "@/lib/utils";

/**
 * The record's eleven tabs, in Dentally's order.
 *
 * A horizontal UNDERLINE strip, which is Dentally's own convention and is
 * deliberately distinct from the segmented pills this app uses for filters: a
 * Dentally user should read this as "sections of this record", not as "a filter on
 * one list". Copying the convention is the whole point of the exercise.
 *
 * Every tab is a real <Link> to its own URL, so browser Back works between tabs,
 * a tab can be bookmarked, and cmd-click opens it in a new tab.
 *
 * ALL ELEVEN ARE ALWAYS SHOWN, and none of them is marked. Hiding a tab reads to a
 * Dentally user as a lost capability; marking four of eleven is the amber-chip
 * failure PRODUCT.md names. Each panel states what it can and cannot do once you
 * are in it.
 */
export function PatientTabStrip({ basePath }: { basePath: string }) {
  const pathname = usePathname();
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  // On a narrow viewport the strip scrolls; bring the active tab into view so the
  // reader is never looking at a strip whose selected item is off-screen.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return (
    <nav aria-label="Patient record sections" className="border-b border-line">
      <ul className="-mb-px flex gap-0.5 overflow-x-auto">
        {PATIENT_TABS.map((tab) => {
          const href = patientTabHref(basePath, tab.slug);
          const active = tab.slug === "details" ? pathname === basePath : pathname === href;
          return (
            <li key={tab.slug} className="shrink-0">
              <Link
                ref={active ? activeRef : undefined}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-block border-b-2 px-3.5 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                  active
                    ? "border-navy font-semibold text-navy"
                    : "border-transparent text-muted hover:border-line-strong hover:text-navy",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
