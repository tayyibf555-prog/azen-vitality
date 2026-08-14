"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { validateShiftEdit, type EditIssue, type ShiftEditInput } from "@/lib/rota/edit";
import type { Absence } from "@/lib/absence/types";
import type { RotaShift, RotaStaff } from "@/lib/rota/types";
import { ROTA_ROLES, dayLabel, siteName } from "./shared";

// ---------------------------------------------------------------------------
// Add, move or delete one shift.
//
// A DUMB COMPONENT over a tested rule. Every judgement it makes -- is this a double
// booking, is that person on agreed leave, is the finish time after the start -- is
// `validateShiftEdit` from `@/lib/rota/edit`, the SAME function the route calls. So
// the message a manager reads here is the message the server would have given, and
// neither can drift into being more permissive than the other.
//
// The full accessibility contract a blocking dialog owes, copied from
// `calendar/entry-dialog.tsx` rather than re-invented: role="dialog", aria-modal, a
// focus trap that recollects on every Tab, focus moved in on open and RESTORED on
// close by any route, and Escape as cancel.
//
// DELETE IS A TOMBSTONE, and the copy says so. "Removed" and "never existed" are
// different states here, and the difference is whether the generator puts the shift
// back tonight.
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const INPUT_CLASS =
  "w-full rounded-md border border-line-strong bg-card px-2 py-[6px] text-[12.5px] text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25";

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.04em] text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

export interface ShiftDraft extends ShiftEditInput {
  /** True when the row being edited is a tombstone the manager is bringing back. */
  removed?: boolean;
}

export function RotaShiftDialog({
  draft,
  clientSlug,
  staff,
  siteIds,
  dayShifts,
  absences,
  busy = false,
  error = null,
  onSave,
  onDelete,
  onCancel,
}: {
  draft: ShiftDraft;
  clientSlug: string;
  staff: RotaStaff[];
  /** The sites the current view covers; a shift can only be placed at one of them. */
  siteIds: string[];
  /** Every stored shift on the draft's day, so the double-booking check sees the day. */
  dayShifts: RotaShift[];
  absences: Absence[];
  busy?: boolean;
  /** A failure from the route, shown verbatim rather than replaced with a shrug. */
  error?: string | null;
  onSave: (value: ShiftEditInput) => void;
  onDelete?: (id: string) => void;
  onCancel: () => void;
}) {
  const headingId = useId();
  const fieldId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const firstRef = useRef<HTMLSelectElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  const [staffId, setStaffId] = useState(draft.staffId);
  const [siteId, setSiteId] = useState(draft.siteId);
  const [role, setRole] = useState(draft.role);
  const [startTime, setStartTime] = useState(draft.startTime);
  const [endTime, setEndTime] = useState(draft.endTime);
  const [pairedStaffId, setPairedStaffId] = useState(draft.pairedStaffId ?? "");
  const [note, setNote] = useState(draft.note ?? "");
  const [issues, setIssues] = useState<EditIssue[]>([]);

  const editing = typeof draft.id === "string";

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    firstRef.current?.focus();
    const node = restoreTo.current;
    return () => {
      if (node && document.contains(node)) requestAnimationFrame(() => node.focus());
    };
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onCancel],
  );

  function submit() {
    const value: ShiftEditInput = {
      id: draft.id,
      staffId,
      siteId,
      role,
      shiftDate: draft.shiftDate,
      startTime,
      endTime,
      pairedStaffId: pairedStaffId || null,
      note: note.trim() ? note.trim() : null,
    };
    // The SAME pure rule the route runs. Warnings do not block: the manager is
    // allowed to roster somebody who booked the day off, and needs telling that
    // they are doing it.
    const check = validateShiftEdit(value, dayShifts, absences, new Date());
    setIssues(check.issues);
    if (!check.ok) return;
    onSave(value);
  }

  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const shownError = error ?? errors[0]?.message ?? null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Cancel"
        onClick={onCancel}
        className="absolute inset-0"
        style={{ background: "rgba(11, 32, 73, 0.35)" }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={onKeyDown}
        className="shadow-chip relative w-full max-w-[440px] rounded-[10px] border border-line-strong bg-card px-5 py-[18px]"
      >
        <h2 id={headingId} className="text-[15px] font-semibold text-navy">
          {editing ? "Edit shift" : "Add shift"}
        </h2>
        <p className="mt-0.5 text-xs text-muted">{dayLabel(draft.shiftDate)}</p>

        {draft.removed ? (
          <p className="mt-3 rounded-lg border border-line bg-card-muted/50 px-3 py-2 text-xs text-ink">
            This shift was removed. Saving it puts it back on the rota.
          </p>
        ) : null}

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Field label="Who" htmlFor={`${fieldId}-staff`}>
              <select
                ref={firstRef}
                id={`${fieldId}-staff`}
                className={INPUT_CLASS}
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
              >
                <option value="">Choose someone</option>
                {staff
                  .filter((s) => s.active)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>

          <Field label="Working as" htmlFor={`${fieldId}-role`}>
            <select
              id={`${fieldId}-role`}
              className={INPUT_CLASS}
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {ROTA_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.charAt(0).toUpperCase() + r.slice(1)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Site" htmlFor={`${fieldId}-site`}>
            <select
              id={`${fieldId}-site`}
              className={INPUT_CLASS}
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
            >
              {siteIds.map((id) => (
                <option key={id} value={id}>
                  {siteName(clientSlug, id)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Starts" htmlFor={`${fieldId}-start`}>
            <input
              id={`${fieldId}-start`}
              type="time"
              className={INPUT_CLASS}
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </Field>

          <Field label="Finishes" htmlFor={`${fieldId}-end`}>
            <input
              id={`${fieldId}-end`}
              type="time"
              className={INPUT_CLASS}
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
            />
          </Field>

          <div className="col-span-2">
            <Field label="Working with (optional)" htmlFor={`${fieldId}-pair`}>
              <select
                id={`${fieldId}-pair`}
                className={INPUT_CLASS}
                value={pairedStaffId}
                onChange={(e) => setPairedStaffId(e.target.value)}
              >
                <option value="">Nobody yet</option>
                {staff
                  .filter((s) => s.active && s.id !== staffId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>

          <div className="col-span-2">
            <Field label="Note (optional)" htmlFor={`${fieldId}-note`}>
              <input
                id={`${fieldId}-note`}
                className={INPUT_CLASS}
                value={note}
                maxLength={500}
                placeholder="Covering reception until 2"
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          </div>
        </div>

        {shownError ? (
          <p className="mt-3 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
            {shownError}
          </p>
        ) : null}
        {warnings.length > 0 && errors.length === 0 ? (
          <ul className="mt-3 space-y-1">
            {warnings.map((w) => (
              <li
                key={w.code}
                className="rounded-lg border border-amber-500/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-800"
              >
                {w.message}
              </li>
            ))}
          </ul>
        ) : null}

        <div className={cn("mt-4 flex items-center gap-2", editing ? "justify-between" : "justify-end")}>
          {editing && onDelete ? (
            <button
              type="button"
              onClick={() => onDelete(draft.id!)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-danger/25 px-3 py-1.5 text-xs font-semibold text-danger transition-colors hover:bg-danger/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/30 disabled:opacity-50"
            >
              <Trash2 size={14} />
              Remove shift
            </button>
          ) : null}
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}
              {editing ? "Save changes" : "Add shift"}
            </Button>
          </div>
        </div>

        {editing ? (
          <p className="mt-3 text-[11px] leading-snug text-muted">
            Removing a shift leaves the slot empty. The rota will not fill it again on its own, so add
            somebody else if the day needs covering.
          </p>
        ) : null}
      </div>
    </div>
  );
}
