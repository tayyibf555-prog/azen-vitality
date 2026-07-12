"use client";

// Slim indeterminate progress bar for in-flight navigations. The authed pages
// render server-side with no loading.tsx (deliberate: streamed loading.tsx broke
// hydration, feb8677), so without this the screen sits still until the server
// responds. Rendered by the sidebars, gated on their existing pendingHref state.
//
// The 150ms animation-delay means an instant navigation (client-cache hit,
// prefetched) never flashes the bar; position:fixed means zero layout shift.
// prefers-reduced-motion swaps the sweep for a calm static bar.
export function NavProgressBar({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[80] h-0.5">
      <style>{`
        @keyframes navSweep {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(250%); }
        }
        @keyframes navFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
      <div
        className="h-full w-2/5 rounded-r-full bg-blue-royal opacity-0 [animation:navFadeIn_120ms_ease-out_150ms_forwards,navSweep_900ms_ease-in-out_150ms_infinite] motion-reduce:w-full motion-reduce:[animation:navFadeIn_120ms_ease-out_150ms_forwards]"
      />
    </div>
  );
}
