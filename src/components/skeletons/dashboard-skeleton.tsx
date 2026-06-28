// Instant route-level fallback for the dashboard content area. It mirrors the real
// page shape (header, then stat cards, then a list) so a tab switch reads as
// intentional loading rather than a blank flash. Rendered by each surface's
// loading.tsx, so it appears the moment a sidebar tab is clicked while the next
// page's server data resolves. The sidebar + topbar (in the layout) stay put.

function Bar({ className = "" }: { className?: string }) {
  return <div className={`rounded bg-line-strong/70 ${className}`} />;
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-6 motion-safe:animate-pulse" aria-hidden role="status" aria-label="Loading">
      {/* Page header */}
      <div className="space-y-2.5">
        <Bar className="h-7 w-52" />
        <Bar className="h-3.5 w-full max-w-2xl bg-line/80" />
        <Bar className="h-3.5 w-2/3 max-w-lg bg-line/80" />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-2xl border border-line bg-card p-5">
            <Bar className="h-3 w-16 bg-line/80" />
            <Bar className="h-7 w-14" />
            <Bar className="h-3 w-24 bg-line/70" />
          </div>
        ))}
      </div>

      {/* Content list / table */}
      <div className="space-y-4 rounded-2xl border border-line bg-card p-5">
        <Bar className="h-5 w-40" />
        <div className="space-y-3.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Bar className="h-9 w-9 shrink-0 rounded-full" />
              <Bar className="h-3.5 flex-1" />
              <Bar className="hidden h-3.5 w-28 sm:block bg-line/70" />
              <Bar className="h-6 w-16 rounded-full bg-line/70" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
