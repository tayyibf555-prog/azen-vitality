"use client";

import { RECALL_CADENCE } from "@/lib/recall/cadence";
import { cn, relativeTime } from "@/lib/utils";
import { Check, Clock, Circle } from "lucide-react";
import type { RecallCadence } from "@/lib/recall/types";

export function CadenceTimeline({
  cadence,
  nowIso,
}: {
  cadence: RecallCadence | null;
  nowIso: string;
}) {
  const now = new Date(nowIso);
  const current = cadence?.currentStep ?? 0;

  return (
    <ol className="space-y-2">
      {RECALL_CADENCE.map((s) => {
        const done = current >= s.step;
        const isNext = current + 1 === s.step;
        const Icon = done ? Check : isNext ? Clock : Circle;
        return (
          <li key={s.step} className="flex items-center gap-3">
            <span
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                done
                  ? "bg-success/10 text-success"
                  : isNext
                    ? "bg-blue-dark/10 text-blue-dark"
                    : "bg-card-muted text-muted",
              )}
            >
              <Icon size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-navy capitalize">
                Step {s.step}: {s.purpose}
                <span className="ml-2 font-normal text-muted">{s.channel.toUpperCase()}</span>
              </p>
              {isNext && cadence?.nextDueAt ? (
                <p className="text-xs text-muted">Due {relativeTime(cadence.nextDueAt, now)}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
