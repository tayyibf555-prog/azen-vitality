"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth/mock-auth";
import { shellAreas, shellBase } from "@/lib/nav-shell";
import { groupKeyForActive, isModuleActive, moduleHref } from "@/lib/sidebar-prefs";

// ---------------------------------------------------------------------------
// THE SECTION BAR: the second level of the navigation.
//
// The rail on the left carries the five AREAS and never expands. Choosing one
// opens that area's first page and this bar appears underneath the top bar
// carrying everything else in that area: pick Patients and you land on the
// patient database with Payments, Onboarding, Recall, Reactivation and the rest
// laid out across the top.
//
// It replaced a sidebar whose areas expanded downward into a long list of every
// module at once. Two things are better about this shape. The vertical axis
// stops competing: a diary or a patient table gets the full height rather than
// sharing it with thirty links. And the bar states where you are, which the old
// column could only do with a highlight some way down a scrolled list.
//
// The items come from shellAreas (@/lib/nav-shell), which already drops anything
// the role may not see AND anything the owner has switched off, so a system that
// is off simply is not in the bar, and switching it on puts it there with no
// further wiring. That is the whole reason this reads from the same source the
// rail does rather than keeping a list of its own.
//
// IT SERVES BOTH TREES. /owner used to render a sidebar of its own and no bar at
// all; both trees now render this one, and shellAreas decides from the pathname
// which entries the tree carries.
//
// AN AREA WITH ONE MODULE RENDERS NOTHING. A bar carrying a single tab that is
// always selected is decoration, and it would cost 40px on every page in that
// area for no information at all.
// ---------------------------------------------------------------------------

export interface SectionTabItem {
  slug: string;
  label: string;
  icon: LucideIcon;
  /** Rendered as a quiet suffix, e.g. a module that is not built yet. */
  note?: string;
}

/**
 * The bar for whichever area the current page belongs to.
 *
 * Resolved from the SAME shellAreas call the rail uses, so the two can never
 * disagree about what is in an area or what has been switched off. Reading
 * the role from useAuth matches the sidebar's existing behaviour; the real gate
 * is server side in guardPage and requireModuleAccess, and this only decides what
 * is drawn.
 */
export function ClientSectionBar({ disabledSlugs = [] }: { disabledSlugs?: string[] }) {
  const params = useParams<{ client: string }>();
  const pathname = usePathname();
  const { user } = useAuth();
  // Both the tree and its areas come from the SAME pure rule the rail uses
  // (@/lib/nav-shell), rather than an inline prefix test and a second
  // categoriesForRole call. The owner shell carries an entry the staff shell does
  // not (the Practice brain), and the rail only draws AREAS: if this bar computed
  // its own list, that module would have no clickable entry on desktop at all.
  const base = shellBase(pathname, params.client);

  const disabled = useMemo(() => new Set(disabledSlugs), [disabledSlugs]);
  const areas = useMemo(
    () => shellAreas({ pathname, role: user?.role ?? null, disabledSlugs: disabled }),
    [pathname, user?.role, disabled],
  );

  const activeKey = groupKeyForActive(areas, (slug) => isModuleActive(pathname, base, slug));
  const area = areas.find((a) => a.key === activeKey) ?? null;
  if (!area) return null;

  return (
    <SectionTabs
      base={base}
      areaLabel={area.label}
      items={area.items.map((i) => ({
        slug: i.slug,
        label: i.label,
        icon: i.icon,
        note: i.status === "placeholder" ? "Soon" : undefined,
      }))}
    />
  );
}

export function SectionTabs({
  base,
  items,
  areaLabel,
}: {
  base: string;
  items: SectionTabItem[];
  /** Named for screen readers, so the bar is not just "navigation". */
  areaLabel: string;
}) {
  const pathname = usePathname();
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the selected tab in view. With eight or nine modules in an area the bar
  // scrolls on a laptop, and landing on a module whose tab sits off the right
  // edge reads as "this page is not in the bar at all".
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  if (items.length < 2) return null;

  return (
    <nav
      aria-label={`${areaLabel} sections`}
      className="border-b border-line bg-card"
    >
      <div
        ref={listRef}
        // Scrolls horizontally rather than wrapping to a second row: a nav whose
        // height changes with the window moves the page content under the reader.
        className="scrollbar-thin flex items-stretch gap-0.5 overflow-x-auto px-2 lg:px-4"
      >
        {items.map((item) => {
          const active = isModuleActive(pathname, base, item.slug);
          const Icon = item.icon;
          return (
            <Link
              key={item.slug || "index"}
              href={moduleHref(base, item.slug)}
              data-active={active}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group relative flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 py-2 text-[12.5px] transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                active ? "font-semibold text-navy" : "font-medium text-muted hover:text-navy",
              )}
            >
              <Icon
                size={14}
                className={cn(
                  "shrink-0 transition-colors",
                  active ? "text-blue-royal" : "text-faint group-hover:text-muted",
                )}
              />
              {item.label}
              {item.note ? (
                <span className="rounded bg-card-muted px-1 py-[1px] text-[9.5px] font-semibold uppercase tracking-[0.04em] text-faint">
                  {item.note}
                </span>
              ) : null}
              {/* The underline is the selected state. Drawn as its own element
                  rather than a border so the tab's height never changes between
                  selected and not, which would jog the row by a pixel. */}
              <span
                aria-hidden
                className={cn(
                  "absolute inset-x-1 bottom-0 h-[2px] rounded-t",
                  active ? "bg-blue-royal" : "bg-transparent",
                )}
              />
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
