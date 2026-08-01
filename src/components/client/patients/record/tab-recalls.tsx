import { StatusPill, type Tone } from "@/components/primitives";
import { FactRow, PanelEmpty, PanelFailed, PanelNote, PanelSection } from "./panel";
import { EMPTY_COPY, FAILED_COPY, NOT_HELD_COPY } from "@/lib/patient/tabs";
import { londonDateLabel, londonDateTimeLabel } from "@/lib/time/london";
import { relativeLabel } from "@/lib/time/relative";
import type { PatientDerived } from "@/lib/patient/record-derive";
import type { RecallTarget } from "@/lib/recall/types";
import type { ReactivationTouch } from "@/lib/reactivation/types";

/**
 * Recalls: Dentally's two dates, then our own richer side of the same work.
 *
 * DENTALLY SHOWS DENTIST AND HYGIENIST SEPARATELY, so this does too. Both dates were
 * already on the raw payload and already read by the recall and reactivation syncs;
 * toPatient collapsed them into one `recallDueAt` for the list. That collapsed field
 * is left exactly as it was for every existing caller, and the two real dates are read
 * alongside it.
 *
 * Below them sits what the recall engine holds that Dentally does not: how overdue,
 * how many attempts have been made, what state the chase is in, and the actual
 * messages sent. That is the "show more than Dentally, never less" test.
 */

const STATUS_TONE: Record<string, Tone> = {
  due: "warning",
  in_cadence: "info",
  booked: "success",
  converted: "success",
  graduated: "success",
  exhausted: "neutral",
  suppressed: "neutral",
};

export function TabRecalls({
  derived,
  targets,
  touches,
  nowIso,
  failed = false,
}: {
  derived: PatientDerived;
  /** This patient's recall targets (dentist and/or hygienist), our own side. */
  targets: RecallTarget[];
  /** Every recall touch across those targets, oldest first, keyed by target id. */
  touches: Record<string, ReactivationTouch[]>;
  nowIso: string;
  /** The worklist read threw. "Not in the worklist" is a claim; an outage is not. */
  failed?: boolean;
}) {
  const now = new Date(nowIso);
  const hasDentallyDates = Boolean(derived.dentistRecallAt || derived.hygienistRecallAt);

  return (
    <div className="space-y-5">
      <PanelSection title="Recall dates in Dentally">
        {hasDentallyDates ? (
          <dl className="divide-y divide-line">
            <FactRow label="Dentist">
              {derived.dentistRecallAt ? (
                <span className="tabular-nums">
                  {londonDateLabel(derived.dentistRecallAt)}{" "}
                  <span className="text-muted">({relativeLabel(derived.dentistRecallAt, now)})</span>
                </span>
              ) : (
                "Not set"
              )}
            </FactRow>
            <FactRow label="Hygienist">
              {derived.hygienistRecallAt ? (
                <span className="tabular-nums">
                  {londonDateLabel(derived.hygienistRecallAt)}{" "}
                  <span className="text-muted">({relativeLabel(derived.hygienistRecallAt, now)})</span>
                </span>
              ) : (
                "Not set"
              )}
            </FactRow>
          </dl>
        ) : (
          <PanelEmpty>{EMPTY_COPY.recalls}</PanelEmpty>
        )}
        <PanelNote>{NOT_HELD_COPY.recallIntervals}</PanelNote>
      </PanelSection>

      <PanelSection title="Recall chase on this platform">
        {failed ? (
          <PanelFailed>{FAILED_COPY.recalls}</PanelFailed>
        ) : targets.length === 0 ? (
          <PanelEmpty>This patient is not in the recall worklist.</PanelEmpty>
        ) : (
          <ul className="space-y-3">
            {targets.map((t) => {
              const rows = touches[t.id] ?? [];
              return (
                <li key={t.id} className="rounded-lg border border-line px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[13px] font-semibold text-navy">
                      {t.recallType === "hygienist" ? "Hygienist" : "Dentist"} recall
                    </p>
                    <StatusPill tone={STATUS_TONE[t.status] ?? "neutral"}>
                      {t.status.replace(/_/g, " ")}
                    </StatusPill>
                  </div>
                  <dl className="mt-1 divide-y divide-line">
                    <FactRow label="Due">
                      <span className="tabular-nums">{londonDateLabel(t.dueAt)}</span>
                    </FactRow>
                    <FactRow label="Overdue by">
                      {t.overdueDays > 0 ? `${t.overdueDays} days` : t.overdueDays === 0 ? "Due today" : "Not yet due"}
                    </FactRow>
                    <FactRow label="Last visit">
                      {t.lastVisitAt ? londonDateLabel(t.lastVisitAt) : "No record"}
                    </FactRow>
                    <FactRow label="Attempts">{t.priorAttempts}</FactRow>
                  </dl>
                  {rows.length > 0 ? (
                    <ol className="mt-2 space-y-1.5 border-t border-line pt-2">
                      {rows.map((touch) => (
                        <li key={touch.id} className="text-[12px]">
                          <span className="font-medium text-navy">
                            {touch.direction === "inbound" ? "Reply" : "Sent"} · {touch.channel}
                          </span>{" "}
                          <span className="text-faint tabular-nums">
                            {londonDateTimeLabel(touch.sentAt ?? touch.createdAt)}
                          </span>
                          <p className="text-muted">{touch.body}</p>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </PanelSection>
    </div>
  );
}
