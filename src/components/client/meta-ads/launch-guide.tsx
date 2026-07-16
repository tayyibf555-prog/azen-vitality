import { CheckCircle2, ShieldCheck, ShieldAlert, Info, Wand2 } from "lucide-react";
import { SectionCard } from "@/components/primitives";
import { cn } from "@/lib/utils";
import type { ComplianceRule } from "@/lib/meta-ads/types";
import { GUIDE_STEPS, UK_COMPLIANCE, CREATIVE_PATTERNS } from "@/lib/meta-ads/knowledge";

// Visual treatment for each compliance severity. "must" reads as authoritative
// (blue/ink), "avoid" as a warning (amber), "note" as quiet guidance.
const SEVERITY: Record<
  ComplianceRule["severity"],
  { label: string; icon: typeof ShieldCheck; wrap: string; chip: string; iconClass: string }
> = {
  must: {
    label: "Must",
    icon: ShieldCheck,
    wrap: "border-blue-dark/20 bg-blue-dark/[0.05]",
    chip: "bg-blue-dark/10 text-blue-deep border-blue-dark/20",
    iconClass: "text-blue-deep",
  },
  avoid: {
    label: "Avoid",
    icon: ShieldAlert,
    wrap: "border-warning/25 bg-warning/10",
    chip: "bg-warning/15 text-[#9a6700] border-warning/25",
    iconClass: "text-[#9a6700]",
  },
  note: {
    label: "Note",
    icon: Info,
    wrap: "border-line bg-card-muted/60",
    chip: "bg-card-muted text-ink border-line-strong",
    iconClass: "text-muted",
  },
};

export function LaunchGuide() {
  return (
    <div className="space-y-6">
      {/* The numbered stepper */}
      <SectionCard
        title="How to launch, step by step"
        description="Everything from setting up your Meta foundations to reading the numbers, in the order to do it."
      >
        <ol className="space-y-5">
          {GUIDE_STEPS.map((step, i) => {
            const last = i === GUIDE_STEPS.length - 1;
            return (
              <li key={step.n} className="relative flex gap-4">
                {/* Number + connector line */}
                <div className="flex flex-col items-center">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-dark text-sm font-semibold text-white">
                    {step.n}
                  </span>
                  {!last ? <span className="mt-1 w-px flex-1 bg-line" aria-hidden="true" /> : null}
                </div>

                <div className={cn("min-w-0 flex-1", last ? "pb-0" : "pb-1")}>
                  <h4 className="text-sm font-semibold text-navy">{step.title}</h4>
                  <p className="mt-1 text-sm leading-relaxed text-ink">{step.body}</p>
                  {step.tips.length > 0 ? (
                    <ul className="mt-2.5 space-y-1.5">
                      {step.tips.map((tip, ti) => (
                        <li key={ti} className="flex gap-2 text-xs leading-relaxed text-muted">
                          <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />
                          {tip}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </SectionCard>

      {/* UK advertising rules */}
      <SectionCard
        title="UK advertising rules"
        description="The rules every Vitality Dental ad must follow (GDC and ASA / CAP). Built into the AI copy, but worth knowing."
      >
        <ul className="space-y-3">
          {UK_COMPLIANCE.map((rule, i) => {
            const s = SEVERITY[rule.severity];
            const Icon = s.icon;
            return (
              <li key={i} className={cn("rounded-xl border px-4 py-3", s.wrap)}>
                <div className="flex items-start gap-3">
                  <Icon size={18} className={cn("mt-0.5 shrink-0", s.iconClass)} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-navy">{rule.title}</span>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                          s.chip,
                        )}
                      >
                        {s.label}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-ink">{rule.detail}</p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      {/* Winning creative patterns */}
      <SectionCard
        title="Winning creative patterns"
        description="Proven ways to structure a hook or offer, each with a compliant example line you can adapt."
      >
        <ul className="grid gap-3 sm:grid-cols-2">
          {CREATIVE_PATTERNS.map((pattern, i) => (
            <li key={i} className="rounded-xl border border-line bg-card-muted/40 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-navy">
                <Wand2 size={15} className="text-blue-dark" />
                {pattern.name}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-ink">{pattern.whatItIs}</p>
              <p className="mt-2 rounded-lg border border-line bg-card px-3 py-2 text-xs italic leading-relaxed text-muted">
                &ldquo;{pattern.example}&rdquo;
              </p>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
