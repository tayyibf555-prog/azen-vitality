"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download, Loader2, Lock, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, EmptyState, SectionCard, StatCard, type Column } from "@/components/primitives";
import { durationLabel } from "@/lib/clock/pairing";
import { formatPenceGbp } from "@/lib/dashboard/money";
import { hoursExportFilename, toHoursCsv } from "@/lib/hours/csv";
import type { MonthReport, StaffMonthRow } from "@/lib/hours/types";

// The Hours screen.
//
// Every figure, every exception and every reason the month cannot be settled
// arrives already decided by src/lib/hours/report.ts. There is no rule in this
// file: it renders, it picks a month, it downloads a file.

const inputClass =
  "rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-xs font-semibold text-navy";

interface MonthResponse {
  ok?: boolean;
  report?: MonthReport;
  scope?: { label: string; isAllSites: boolean };
  asOf?: string;
  boundary?: string;
  error?: string;
}

async function readMonth(clientSlug: string, month: string): Promise<Required<Pick<MonthResponse, "report" | "asOf">> & MonthResponse> {
  const res = await fetch(
    `/api/hours/month?client=${encodeURIComponent(clientSlug)}&month=${encodeURIComponent(month)}`,
  );
  const data = (await res.json().catch(() => ({}))) as MonthResponse;
  if (!res.ok || !data.ok || !data.report) {
    throw new Error(data.error || `The month's hours could not be read (${res.status}).`);
  }
  return { ...data, report: data.report, asOf: data.asOf ?? new Date().toISOString() };
}

/** The London month of an instant, `YYYY-MM`, for the picker's starting value. */
function londonMonthNow(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit" })
    .format(new Date())
    .slice(0, 7);
}

export function HoursWorkspace({ clientSlug }: { clientSlug: string }) {
  const [month, setMonth] = useState(londonMonthNow);
  const [report, setReport] = useState<MonthReport | null>(null);
  const [asOf, setAsOf] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Correcting a missed clock-out.
  const [fixing, setFixing] = useState(false);
  const [fixForm, setFixForm] = useState({ staffId: "", kind: "out", localTime: "", reason: "" });
  const [fixError, setFixError] = useState<string | null>(null);
  const [savingFix, setSavingFix] = useState(false);

  // THE FETCH IS IN THE EFFECT, EVERY setState IS IN ITS CALLBACK. A synchronous
  // setState in an effect body causes a cascading render (and the lint rule that
  // guards it), so the "loading" flag is raised by whatever TRIGGERS a reload
  // (the month picker, a recorded correction) rather than by the effect itself.
  useEffect(() => {
    let live = true;
    readMonth(clientSlug, month)
      .then((data) => {
        if (!live) return;
        setReport(data.report);
        setAsOf(data.asOf);
        setLoadError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!live) return;
        // LOUD: a month that could not be read says so. A confident empty month
        // is a month somebody would pay from.
        setLoadError(err instanceof Error ? err.message : "The month's hours could not be read.");
        setReport(null);
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [clientSlug, month, reloadKey]);

  const download = useCallback(() => {
    if (!report) return;
    const csv = toHoursCsv(report, asOf);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = hoursExportFilename(clientSlug, report.month, asOf);
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, [asOf, clientSlug, report]);

  const submitFix = useCallback(async () => {
    if (!fixForm.staffId || !fixForm.localTime) return;
    setSavingFix(true);
    setFixError(null);
    try {
      // THE BROWSER converts the typed local time to an instant, because it is
      // the one clock that is in the practice's time zone. A bare
      // "2026-06-11T17:30" sent to a UTC server would land an hour out in summer,
      // and the server refuses a time with no zone for exactly that reason.
      const occurredAt = new Date(fixForm.localTime).toISOString();
      const res = await fetch("/api/staff-check-in/adjust", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          staffId: fixForm.staffId,
          kind: fixForm.kind,
          occurredAt,
          reason: fixForm.reason,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || `Could not record that (${res.status}).`);
      setFixForm({ staffId: "", kind: "out", localTime: "", reason: "" });
      setFixing(false);
      setLoading(true);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setFixError(err instanceof Error ? err.message : "Could not record that.");
    } finally {
      setSavingFix(false);
    }
  }, [clientSlug, fixForm]);

  const columns: Column<StaffMonthRow>[] = useMemo(() => {
    const base: Column<StaffMonthRow>[] = [
      { key: "name", header: "Name", cell: (r) => <span className="font-medium text-navy">{r.name}</span> },
      { key: "role", header: "Role", cell: (r) => <span className="capitalize">{r.role}</span> },
      { key: "site", header: "Site", cell: (r) => r.siteId ?? "Any site" },
      { key: "days", header: "Days", align: "right", cell: (r) => r.daysWorked },
      { key: "sessions", header: "Sessions", align: "right", cell: (r) => r.sessions },
      {
        key: "hours",
        header: "Hours",
        align: "right",
        cell: (r) => <span className="font-medium text-navy">{durationLabel(r.closedMinutes)}</span>,
      },
      {
        key: "open",
        header: "Needs a decision",
        align: "right",
        cell: (r) =>
          r.openOrUnresolvedCount === 0 ? (
            <span className="text-muted">None</span>
          ) : (
            <span className="font-medium text-status-amber">{r.openOrUnresolvedCount}</span>
          ),
      },
    ];

    // The cost columns EXIST only when the payload carried them.
    if (report?.includesCost) {
      base.push(
        {
          key: "rate",
          header: "Rate",
          align: "right",
          cell: (r) => (r.ratePence === null || r.ratePence === undefined ? <span className="text-muted">No rate</span> : formatPenceGbp(r.ratePence)),
        },
        {
          key: "cost",
          header: "Cost",
          align: "right",
          cell: (r) =>
            // NULL IS NOT ZERO. "No rate recorded" is what the practice needs to
            // read; "£0.00" would say the work cost nothing.
            r.costPence === null || r.costPence === undefined ? (
              <span className="text-muted">No rate recorded</span>
            ) : (
              <span className="font-medium text-navy">{formatPenceGbp(r.costPence)}</span>
            ),
        },
      );
    }
    return base;
  }, [report?.includesCost]);

  return (
    <div className="mt-6 space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <label className="block">
          <span className={labelClass}>Month</span>
          <input
            type="month"
            value={month}
            max={londonMonthNow()}
            onChange={(e) => {
              setLoading(true);
              setMonth(e.target.value);
            }}
            className={`mt-1 ${inputClass}`}
          />
        </label>

        <Button variant="secondary" size="sm" onClick={download} disabled={!report || loading}>
          <Download size={15} /> Export for payroll
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" />
          Reading the month...
        </div>
      ) : loadError || !report ? (
        <div className="rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
          <span className="flex items-center gap-2 font-semibold">
            <ShieldAlert size={15} /> The month could not be read
          </span>
          <p className="mt-1 font-normal">{loadError}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-7 gap-y-4">
            <StatCard label="Hours worked" value={durationLabel(report.totals.closedMinutes)} emphasis />
            <StatCard label="People" value={report.totals.staff} />
            <StatCard
              label="Needs a decision"
              value={report.totals.openOrUnresolvedCount}
              dot={report.totals.openOrUnresolvedCount > 0 ? "bg-status-amber" : undefined}
            />
            {report.includesCost ? (
              <StatCard
                label="Cost"
                value={
                  report.totals.costPence === null || report.totals.costPence === undefined
                    ? "Not priced"
                    : formatPenceGbp(report.totals.costPence)
                }
                hint={report.totals.costPence === null ? "Somebody has no rate recorded." : undefined}
              />
            ) : null}
          </div>

          {!report.includesCost ? (
            <p className="flex items-start gap-2 rounded-lg border border-line bg-card-muted px-3 py-2 text-[13px] text-muted">
              <Lock size={14} className="mt-0.5 shrink-0" />
              Pay is a separate permission and is not part of this view for your login. The cost figures are
              not hidden here: they are never sent.
            </p>
          ) : null}

          {report.blockers.length > 0 ? (
            <div className="rounded-lg border border-status-amber/30 bg-status-amber/10 px-4 py-3 text-[13px] text-ink">
              <span className="flex items-center gap-2 text-sm font-semibold text-navy">
                <AlertTriangle size={15} /> This month is not settled
              </span>
              <ul className="mt-2 space-y-1">
                {report.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
              <p className="mt-2 text-muted">
                The export stays available and says PROVISIONAL at the top of the file, so nothing is paid from a
                figure that looks settled and is not.
              </p>
              {report.unresolved.length > 0 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    setFixing((v) => !v);
                    setFixError(null);
                  }}
                >
                  {fixing ? "Close" : "Record a correction"}
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="rounded-lg border border-line bg-card-muted px-3 py-2 text-[13px] text-muted">
              Nothing outstanding. The export is marked complete as at the time you take it.
            </p>
          )}

          {fixing ? (
            <SectionCard
              title="Record a correction"
              description="This ADDS an entry; it never edits one away. The original and the correction both stay in the log, with your name and your reason on the correction."
            >
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="block">
                  <span className={labelClass}>Person</span>
                  <select
                    value={fixForm.staffId}
                    onChange={(e) => setFixForm((f) => ({ ...f, staffId: e.target.value }))}
                    className={`mt-1 w-full ${inputClass}`}
                  >
                    <option value="">Choose...</option>
                    {report.rows.map((r) => (
                      <option key={r.staffId} value={r.staffId}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className={labelClass}>Entry</span>
                  <select
                    value={fixForm.kind}
                    onChange={(e) => setFixForm((f) => ({ ...f, kind: e.target.value }))}
                    className={`mt-1 w-full ${inputClass}`}
                  >
                    <option value="out">Clocked out</option>
                    <option value="in">Clocked in</option>
                  </select>
                </label>
                <label className="block">
                  <span className={labelClass}>When</span>
                  <input
                    type="datetime-local"
                    value={fixForm.localTime}
                    onChange={(e) => setFixForm((f) => ({ ...f, localTime: e.target.value }))}
                    className={`mt-1 w-full ${inputClass}`}
                  />
                </label>
                <label className="block">
                  <span className={labelClass}>Reason</span>
                  <input
                    type="text"
                    value={fixForm.reason}
                    onChange={(e) => setFixForm((f) => ({ ...f, reason: e.target.value }))}
                    placeholder="Forgot to clock out; left at 17:30."
                    className={`mt-1 w-full ${inputClass}`}
                  />
                </label>
              </div>

              {fixError ? (
                <p className="mt-3 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {fixError}
                </p>
              ) : null}

              <div className="mt-3">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={savingFix || !fixForm.staffId || !fixForm.localTime || fixForm.reason.trim().length < 4}
                  onClick={submitFix}
                >
                  {savingFix ? <Loader2 size={14} className="animate-spin" /> : null} Record it
                </Button>
              </div>
            </SectionCard>
          ) : null}

          <SectionCard title="By person" description={`${report.from} to ${report.to}`}>
            {report.rows.length === 0 ? (
              <EmptyState
                title="Nobody to show for this month"
                description="Staff are kept on the Staff rota, and the hours here come from their clock-in and clock-out entries."
              />
            ) : (
              <DataTable columns={columns} rows={report.rows} getRowKey={(r) => r.staffId} />
            )}
          </SectionCard>

          {report.unresolved.length > 0 ? (
            <SectionCard
              title="Needs a decision"
              description="Raised for a human to explain, never enforced against anybody. An unresolved session contributes no hours at all, because its length is not known."
            >
              <ul className="space-y-1.5 text-[13px]">
                {report.unresolved.map((note, i) => (
                  <li key={`${note.kind}-${note.staffId}-${note.at ?? i}`} className="flex flex-wrap gap-x-2">
                    <span className="font-medium text-navy">
                      {report.rows.find((r) => r.staffId === note.staffId)?.name ?? "Someone"}
                    </span>
                    <span className="text-ink">{note.label}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
        </>
      )}

      <p className="text-[12px] text-faint">
        Hours and cost only. This is not payroll: nothing here is submitted to HMRC, and there are no payslips,
        deductions or pension figures. Hours are derived from clock entries and compared against the rota.
      </p>
    </div>
  );
}
