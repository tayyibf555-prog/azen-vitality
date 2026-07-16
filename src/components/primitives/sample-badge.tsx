import { Info } from "lucide-react";
import { StatusPill } from "./status-pill";
import { cn } from "@/lib/utils";

// Client-handover safety element. Every MOCK figure in the dashboard carries one of
// these so the practice can never mistake a pilot number for their real live data.
// Two forms, one message:
//   <SampleBadge />      a small "Sample" pill for beside a heading or in a card
//   <SampleNote />       a one-line banner for the top of a mock section
// Purely a label: it changes no data, calculation or logic.

const DEFAULT_NOTE = "Sample data, not yet from your live sources.";

/** A small "Sample" pill. Amber by default (a gentle caution), matching the
 *  warning tone of the existing "Pilot figure" hints. */
export function SampleBadge({
  label = "Sample",
  tone = "warning",
  className,
}: {
  label?: string;
  tone?: "warning" | "neutral";
  className?: string;
}) {
  return (
    <StatusPill tone={tone} className={className}>
      <Info size={12} className="shrink-0" />
      {label}
    </StatusPill>
  );
}

/** A one-line banner reading "Sample data, not yet from your live sources." Placed
 *  at the top of a section whose figures are all mock, so a single note covers the
 *  cards, charts and tables beneath it. */
export function SampleNote({
  children = DEFAULT_NOTE,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-full border border-tint-amber-line bg-tint-amber px-4 py-2.5",
        className,
      )}
    >
      <Info size={16} className="shrink-0 text-status-amber" />
      <p className="text-xs font-medium leading-relaxed text-status-amber">{children}</p>
    </div>
  );
}
