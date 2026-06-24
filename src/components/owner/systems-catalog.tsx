import { BrainCircuit, type LucideIcon } from "lucide-react";
import { CLIENT_NAV } from "@/lib/nav";
import { SectionCard, StatusPill } from "@/components/primitives";

/** A status board of every AI system in the platform, grouped by layer. */

const SKIP = new Set(["Overview", "Account"]);

function SystemRow({ icon: Icon, name, live, note }: { icon: LucideIcon; name: string; live: boolean; note?: string }) {
  return (
    <div className="flex items-start gap-3 py-3.5 first:pt-0 last:pb-0">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-dark/10 text-blue-dark">
        <Icon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-navy">{name}</span>
          <StatusPill tone={live ? "success" : "neutral"}>{live ? "Live" : "Coming soon"}</StatusPill>
        </div>
        {note ? <p className="mt-1 text-xs leading-relaxed text-muted">{note}</p> : null}
      </div>
    </div>
  );
}

export function SystemsCatalog() {
  const groups = CLIENT_NAV.filter((g) => !SKIP.has(g.label));
  const items = groups.flatMap((g) => g.items);
  const liveCount = items.filter((i) => i.status === "live").length + 1; // + Practice brain
  const total = items.length + 1;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        {total} AI systems wired into the practice.{" "}
        <span className="font-semibold text-success">{liveCount} live</span>, the rest rolling out.
      </p>

      <SectionCard title="Intelligence" description="The knowledge brain every system and the co-pilot draw from.">
        <SystemRow
          icon={BrainCircuit}
          name="Practice brain"
          live
          note="Self-learning knowledge hub. Stores and auto-sorts every protocol, script and SOP, gated by staff clearance, and feeds the co-pilot that answers questions across the team."
        />
      </SectionCard>

      {groups.map((g) => (
        <SectionCard key={g.label} title={g.label}>
          <div className="divide-y divide-line">
            {g.items.map((it) => (
              <SystemRow key={it.slug || it.label} icon={it.icon} name={it.label} live={it.status === "live"} note={it.note} />
            ))}
          </div>
        </SectionCard>
      ))}
    </div>
  );
}
