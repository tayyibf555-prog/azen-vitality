export { PageHeader } from "./page-header";
export { SectionCard } from "./section-card";
export { StatCard } from "./stat-card";
export { StatusPill, type Tone } from "./status-pill";
export { SampleBadge, SampleNote } from "./sample-badge";
export { EmptyState } from "./empty-state";
export { DataTable, type Column } from "./data-table";
export { Tabs, type TabItem } from "./tabs";
export { Sparkline, BarChart, ProgressMeter } from "./charts";
// CLIENT COMPONENT. Takes an onChange callback, so it may only be rendered from
// inside another client component — a server component cannot pass it a function.
// (See the DataTable/Tabs lesson: a shared primitive that crosses the RSC
// boundary with function props builds fine and crashes at render.)
export { Toggle, type ToggleSize, type ToggleTone } from "./toggle";
