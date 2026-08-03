import { cn } from "@/lib/utils";

/**
 * The record's shared panel furniture: one heading style, one note style, one empty
 * style, so eleven tabs cannot each invent their own.
 *
 * House rules applied here rather than eleven times over: sentence-case headings, no
 * uppercase micro-caps, and caveats rendered as ONE quiet line attached to the thing
 * they concern, never as a row of chips and never in amber. Amber is for warnings; an
 * explanation of a missing column is not a warning.
 */

export function PanelSection({
  title,
  actions,
  children,
  className,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-2.5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line pb-1.5">
        <h3 className="text-[13.5px] font-semibold tracking-[-0.1px] text-navy">{title}</h3>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * A caveat, a provenance note or a scope statement. Grey, small, one line of prose.
 * NEVER amber, and never a chip: PRODUCT.md names a screen of amber caveat chips as
 * the exact failure this project already shipped once.
 */
export function PanelNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("max-w-prose text-[11px] leading-[1.45] text-faint", className)}>{children}</p>;
}

/**
 * A prominent SCOPE statement: what a tab does and does not cover, read before the
 * content rather than as a footnote under it.
 *
 * DISTINCT FROM PanelNote on purpose. A scope sentence the reader's trust depends on -
 * "this audit only covers actions taken here, Dentally keeps its own" - must not be the
 * faintest text on the screen, or a manager scanning fast will assume the tab caught
 * something it never could. This is readable body ink in a bordered band, at the TOP.
 * It is NOT amber: amber is reserved for a failed read, and a true statement of scope is
 * not a warning.
 */
export function PanelScope({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="max-w-prose rounded-lg border border-line-strong bg-card-muted/60 px-3.5 py-3">
      <p className="text-[12px] font-semibold tracking-[-0.1px] text-navy">{title}</p>
      <p className="mt-1 text-[12.5px] leading-[1.5] text-ink">{children}</p>
    </div>
  );
}

/** A real read that returned nothing. Category A: "this patient has none." */
export function PanelEmpty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-line-strong bg-card-muted/40 px-3 py-3 text-center text-[12.5px] text-muted">
      {children}
    </p>
  );
}

/**
 * A read we DO have that threw. Category D, and deliberately NOT the same component
 * as PanelEmpty: on a clinical record "this patient has none" and "we could not read
 * it" must never look alike, or a reader will treat an outage as a fact.
 */
export function PanelFailed({ children }: { children: React.ReactNode }) {
  return (
    <p className="max-w-prose rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2.5 text-[12.5px] text-status-amber">
      {children}
    </p>
  );
}

/** A label/value row for the dense fact columns Dentally's Details screen uses. */
export function FactRow({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline gap-3 py-[5px]", className)}>
      <dt className="w-[132px] shrink-0 text-[11.5px] font-medium text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-[13px] text-ink">{children}</dd>
    </div>
  );
}

/**
 * The value for a fact we did not load in this view, as distinct from a fact the
 * patient does not have. A dash is not a claim; "None" is.
 */
export function NotLoaded({ title = "Not loaded in this view" }: { title?: string }) {
  return (
    <span className="text-faint" title={title}>
      -
    </span>
  );
}
