"use client";

import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RotaStaff } from "@/lib/rota/types";
import type { AbsenceKind } from "@/lib/absence/types";
import { ABSENCE_KINDS, KIND_LABEL } from "./shared";

// The request form. It collects the fields and hands them up; it does NOT decide
// whether the request is valid. `validateRequest` in @/lib/absence/rules is the one
// judge of that, on the server, so a rule can never be enforced in the browser and
// forgotten at the API (or vice versa). The server's refusal is shown here verbatim.

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-xs font-semibold text-navy";

export interface AbsenceFormValues {
  staffId: string;
  kind: AbsenceKind;
  startDate: string;
  endDate: string;
  note: string;
}

function emptyForm(): AbsenceFormValues {
  return { staffId: "", kind: "holiday", startDate: "", endDate: "", note: "" };
}

export function AbsenceRequestForm({
  staff,
  submitting,
  error,
  onSubmit,
  onCancel,
}: {
  staff: RotaStaff[];
  submitting: boolean;
  error: string | null;
  onSubmit: (values: AbsenceFormValues) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<AbsenceFormValues>(emptyForm());

  function set<K extends keyof AbsenceFormValues>(key: K, value: AbsenceFormValues[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!submitting) onSubmit(form);
      }}
      className="rounded-xl border border-line-strong bg-card-muted/40 p-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="absence-staff" className={labelClass}>
            Who is away <span className="text-danger">*</span>
          </label>
          <select
            id="absence-staff"
            required
            value={form.staffId}
            onChange={(e) => set("staffId", e.target.value)}
            className={inputClass}
          >
            <option value="">Choose a staff member</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="absence-kind" className={labelClass}>
            Type <span className="text-danger">*</span>
          </label>
          <select
            id="absence-kind"
            value={form.kind}
            onChange={(e) => set("kind", e.target.value as AbsenceKind)}
            className={inputClass}
          >
            {ABSENCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="absence-start" className={labelClass}>
            First day away <span className="text-danger">*</span>
          </label>
          <input
            id="absence-start"
            type="date"
            required
            value={form.startDate}
            onChange={(e) => set("startDate", e.target.value)}
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="absence-end" className={labelClass}>
            Last day away <span className="text-danger">*</span>
          </label>
          <input
            id="absence-end"
            type="date"
            required
            value={form.endDate}
            onChange={(e) => set("endDate", e.target.value)}
            className={inputClass}
          />
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="absence-note" className={labelClass}>
            Note
          </label>
          <input
            id="absence-note"
            type="text"
            value={form.note}
            onChange={(e) => set("note", e.target.value)}
            placeholder="Anything the person deciding should know"
            className={inputClass}
          />
        </div>
      </div>

      {error ? (
        <p className="mt-4 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={submitting}>
          {submitting ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          Add the request
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
