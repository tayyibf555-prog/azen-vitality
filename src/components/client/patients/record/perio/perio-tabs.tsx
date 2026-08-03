"use client";

import { useState, type ReactNode } from "react";

// ===========================================================================
// THE PERIO EXAM'S TWO TABS — the six-point chart, and plaque & bleeding.
//
// WHY A TAB STRIP AT ALL. Dentally's perio exam has exactly this division:
// the pocket chart on one tab, a separate "Plaque & Bleeding" tab on another.
// They are two different examinations, taken at different times, often by
// different people, and neither is derived from the other. Stacking them on one
// page would read as one long examination, which is precisely the thing they are
// not — and the whole point of this module is that staff do not relearn a screen
// they already use every day.
//
// WHY IT IS AN ISLAND, AND THE ONLY THING IN IT. This is the third "use client"
// file in perio/ and it holds ONE piece of state: which tab is showing. Both
// panels are rendered on the SERVER and arrive here as ReactNode slots, so
// nothing below this boundary re-renders a chart, recomputes a percentage or
// reaches a repository. That is the legal direction: a server parent may pass
// elements to a client child; what it may not pass is a function, and this
// component's props contain none.
//
// WHY ANCHORS AND NOT BUTTONS, which is not a style choice.
// perio-shell.test.ts asserts that with the gate SHUT the rendered markup
// contains no input, no button, no textarea and no select anywhere — "a screen
// with nothing to type into is a fact, read-only enforced by an attribute is a
// claim". A tab control authors nothing, but weakening that assertion to carve
// out an exception would weaken the one test standing between a switched-off
// feature and a typeable one. So the tabs are anchor elements with real fragment
// hrefs, exactly as the record's own tab strip is a strip of links, and the
// absolute assertion survives untouched.
//
// BOTH PANELS ARE ALWAYS IN THE MARKUP, one of them `hidden`. Rendering only the
// active one would mean a tab switch could show a panel the server never
// produced. `hidden` is honoured by assistive technology as well as by the eye,
// so a screen reader is not read the inactive tab either.
// ===========================================================================

export interface PerioTabsProps {
  /** The six-point chart, its gum line and the comparison. Rendered by the
   *  server; this component only decides whether it is showing. */
  chartPanel: ReactNode;
  /** The plaque and bleeding examination. */
  plaqueBleedingPanel: ReactNode;
  /**
   * Which tab opens first.
   *
   * Defaults to the chart, deliberately: the six-point chart is what a BPE code
   * 3 or 4 demands and is the reason a clinician opens this tab at all. A screen
   * that opened on a secondary examination would bury the one the protocol asks
   * for.
   */
  initial?: "chart" | "plaque-bleeding";
}

type TabId = NonNullable<PerioTabsProps["initial"]>;

const TABS: { id: TabId; label: string; hint: string }[] = [
  {
    id: "chart",
    label: "Six-point chart",
    hint: "Probing depths, recession, attachment loss, bleeding and suppuration, per site",
  },
  {
    id: "plaque-bleeding",
    label: "Plaque & bleeding",
    hint: "Plaque and bleeding marked per tooth surface, with the percentages of the surfaces examined",
  },
];

export function PerioTabs({ chartPanel, plaqueBleedingPanel, initial = "chart" }: PerioTabsProps) {
  const [active, setActive] = useState<TabId>(initial);

  const panelFor: Record<TabId, ReactNode> = {
    chart: chartPanel,
    "plaque-bleeding": plaqueBleedingPanel,
  };

  return (
    <div className="space-y-3">
      <nav aria-label="Periodontal examinations" className="border-b border-line">
        <ul role="tablist" className="-mb-px flex gap-0.5 overflow-x-auto">
          {TABS.map((tab) => {
            const selected = tab.id === active;
            return (
              <li key={tab.id} className="shrink-0">
                <a
                  role="tab"
                  id={`perio-tab-${tab.id}`}
                  href={`#perio-panel-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={`perio-panel-${tab.id}`}
                  title={tab.hint}
                  onClick={(event) => {
                    // The href is a real in-page target, so the anchor is
                    // meaningful with or without this handler; preventing the
                    // default only stops the browser adding a fragment to the
                    // URL and jumping the scroll position on every switch.
                    event.preventDefault();
                    setActive(tab.id);
                  }}
                  className={
                    selected
                      ? "inline-block cursor-pointer border-b-2 border-navy px-3.5 py-2 text-[13px] font-semibold text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
                      : "inline-block cursor-pointer border-b-2 border-transparent px-3.5 py-2 text-[13px] font-medium text-muted transition-colors hover:border-line-strong hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
                  }
                >
                  {tab.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      {TABS.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`perio-panel-${tab.id}`}
          aria-labelledby={`perio-tab-${tab.id}`}
          hidden={tab.id !== active}
        >
          {panelFor[tab.id]}
        </div>
      ))}
    </div>
  );
}
