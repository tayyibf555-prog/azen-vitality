"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  validateEntryInput,
  ENTRY_BODY_MAX,
  ENTRY_TITLE_MAX,
  type DiaryEntryKind,
} from "@/lib/calendar/entries";
import { labelMinutes } from "./diary-grid";

// ---------------------------------------------------------------------------
// Add or edit a break or a note.
//
// A modal in the middle of the screen, with the full accessibility contract a
// blocking dialog owes: role="dialog", aria-modal, a focus trap, focus moved in
// on open and RESTORED on close, Escape as cancel, and a heading that labels it.
//
// Delete is SOFT (the route sets deleted_at), so a break someone removed on a
// Monday stays recoverable and auditable rather than vanishing.
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** "HH:MM" -> minutes past midnight, or null when it is not a usable time. */
function minutesOfTimeInput(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return Number.isFinite(mins) && mins >= 0 && mins <= 1440 ? mins : null;
}

export interface EntryDraft {
  /** Present when editing an existing entry; absent when creating one. */
  id?: string;
  kind: DiaryEntryKind;
  title: string;
  body: string;
  startMin: number;
  endMin: number;
  practitionerId: string | null;
}

export interface EntryClinicianOption {
  /** null is the "all clinicians at this site" option. */
  id: string | null;
  name: string;
}

const ALL_CLINICIANS = "__all__";

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

const INPUT_CLASS =
  "w-full rounded-md border border-line-strong bg-card px-2 py-[5px] text-[12.5px] text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25";

export function EntryDialog({
  draft,
  day,
  clinicians,
  busy = false,
  error = null,
  onSave,
  onDelete,
  onCancel,
}: {
  draft: EntryDraft;
  /** The London day this entry belongs to, shown so the reader knows what they are editing. */
  day: string;
  clinicians: EntryClinicianOption[];
  busy?: boolean;
  /** A failure from the route, shown verbatim rather than replaced with a shrug. */
  error?: string | null;
  onSave: (value: EntryDraft) => void;
  onDelete?: (id: string) => void;
  onCancel: () => void;
}) {
  const headingId = useId();
  const fieldId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  const [kind, setKind] = useState<DiaryEntryKind>(draft.kind);
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const [start, setStart] = useState(labelMinutes(draft.startMin));
  const [end, setEnd] = useState(labelMinutes(draft.endMin));
  const [practitioner, setPractitioner] = useState(draft.practitionerId ?? ALL_CLINICIANS);
  const [localError, setLocalError] = useState<string | null>(null);

  const editing = typeof draft.id === "string";

  // Focus moves IN on open and is RESTORED to whatever opened the dialog on close,
  // by any route: Save, Delete, Cancel, Escape or the scrim.
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
        // stopPropagation so Escape never reaches the grid's own handler behind us.
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      // The focusable set is recollected on EVERY Tab, so a validation message
      // revealed mid-edit cannot let focus escape the trap.
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

  const shown = localError ?? error;

  const submit = () => {
    const startMin = minutesOfTimeInput(start);
    const endMin = minutesOfTimeInput(end);
    // Validated with the SAME pure function the route uses, so the message a
    // reader sees here is the message the server would have given.
    const check = validateEntryInput({
      kind,
      title,
      body,
      day,
      startMin: startMin ?? Number.NaN,
      endMin: endMin ?? Number.NaN,
      practitionerId: practitioner === ALL_CLINICIANS ? null : practitioner,
    });
    if (!check.ok) {
      setLocalError(check.error);
      return;
    }
    setLocalError(null);
    onSave({
      id: draft.id,
      kind: check.value.kind,
      title: check.value.title,
      body: check.value.body ?? "",
      startMin: check.value.startMin,
      endMin: check.value.endMin,
      practitionerId: check.value.practitionerId,
    });
  };

  const kinds = useMemo(
    () =>
      [
        { value: "break" as const, label: "Break" },
        { value: "note" as const, label: "Note" },
      ] satisfies { value: DiaryEntryKind; label: string }[],
    [],
  );

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
        className="shadow-chip relative w-full max-w-[420px] rounded-[10px] border border-line-strong bg-card px-5 py-[18px]"
      >
        <h2 id={headingId} className="text-[15px] font-semibold text-navy">
          {editing ? "Edit this entry" : "Add a break or a note"}
        </h2>

        <div className="mt-3 space-y-3">
          <div role="group" aria-label="Kind" className="inline-flex gap-0.5 rounded-lg border border-line-strong bg-card p-[2px]">
            {kinds.map((k, i) => (
              <button
                key={k.value}
                ref={i === 0 ? firstRef : undefined}
                type="button"
                aria-pressed={kind === k.value}
                onClick={() => setKind(k.value)}
                className={cn(
                  "rounded-md px-2.5 py-[3px] text-[11px] font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                  kind === k.value ? "bg-navy font-semibold text-white" : "text-muted hover:text-navy",
                )}
              >
                {k.label}
              </button>
            ))}
          </div>

          <Field label="Title" htmlFor={`${fieldId}-title`}>
            <input
              id={`${fieldId}-title`}
              type="text"
              value={title}
              maxLength={ENTRY_TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              className={INPUT_CLASS}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Start" htmlFor={`${fieldId}-start`}>
              <input
                id={`${fieldId}-start`}
                type="time"
                step={300}
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className={cn(INPUT_CLASS, "tabular-nums")}
              />
            </Field>
            <Field label="End" htmlFor={`${fieldId}-end`}>
              <input
                id={`${fieldId}-end`}
                type="time"
                step={300}
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className={cn(INPUT_CLASS, "tabular-nums")}
              />
            </Field>
          </div>

          <Field label="Clinician" htmlFor={`${fieldId}-prac`}>
            <select
              id={`${fieldId}-prac`}
              value={practitioner}
              onChange={(e) => setPractitioner(e.target.value)}
              className={INPUT_CLASS}
            >
              <option value={ALL_CLINICIANS}>All clinicians at this site</option>
              {clinicians
                .filter((c) => c.id !== null)
                .map((c) => (
                  <option key={c.id as string} value={c.id as string}>
                    {c.name}
                  </option>
                ))}
            </select>
          </Field>

          <Field label="Detail (optional)" htmlFor={`${fieldId}-body`}>
            <textarea
              id={`${fieldId}-body`}
              rows={2}
              value={body}
              maxLength={ENTRY_BODY_MAX}
              onChange={(e) => setBody(e.target.value)}
              className={cn(INPUT_CLASS, "resize-none")}
            />
          </Field>
        </div>

        {shown ? (
          <p role="alert" className="mt-3 text-[11.5px] leading-[1.45] text-ink">
            {shown}
          </p>
        ) : null}

        <div className="mt-4 flex items-center justify-between gap-2">
          {editing && onDelete ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onDelete(draft.id as string)}
              className="rounded-md border border-line-strong bg-card px-3 py-[6px] text-[12px] font-medium text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 disabled:opacity-40"
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-line-strong bg-card px-3 py-[6px] text-[12px] font-medium text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={submit}
              className="rounded-md bg-navy px-3 py-[6px] text-[12px] font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 disabled:opacity-40"
            >
              {busy ? "Saving" : "Save"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
