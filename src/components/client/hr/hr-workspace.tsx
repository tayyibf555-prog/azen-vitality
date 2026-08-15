"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Lock, Plus, ShieldAlert, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, EmptyState, SectionCard, StatCard, StatusPill, type Column } from "@/components/primitives";
import { formatPenceGbp } from "@/lib/dashboard/money";
import type { HrPerson, HrProfileResponse } from "@/lib/hr/types";

// The Staff HR screen.
//
// It renders what the server decided and holds no rule of its own: the holiday
// entitlement, its basis and its working all arrive computed
// (src/lib/hr/entitlement.ts), and the pay fields are ABSENT from the payload
// entirely for a login without pay access, so there is nothing here to hide.

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-xs font-semibold text-navy";

const BASIS_LABEL: Record<string, string> = {
  override: "Set by the practice",
  "pro-rata": "Pro rata",
  statutory: "Statutory",
  "not-employed": "Not employed this leave year",
};

interface EditForm {
  dateOfBirth: string;
  personalEmail: string;
  personalPhone: string;
  addressLine1: string;
  addressTown: string;
  addressPostcode: string;
  emergencyName: string;
  emergencyRelationship: string;
  emergencyPhone: string;
  employmentStart: string;
  employmentEnd: string;
  contractedDaysPerWeek: string;
  entitlementDaysOverride: string;
  gdcNumber: string;
  niNumberLast4: string;
}

function formFor(person: HrPerson | null): EditForm {
  const p = person?.profile ?? null;
  return {
    dateOfBirth: p?.dateOfBirth ?? "",
    personalEmail: p?.personalEmail ?? "",
    personalPhone: p?.personalPhone ?? "",
    addressLine1: p?.address?.line1 ?? "",
    addressTown: p?.address?.town ?? "",
    addressPostcode: p?.address?.postcode ?? "",
    emergencyName: p?.emergencyContact?.name ?? "",
    emergencyRelationship: p?.emergencyContact?.relationship ?? "",
    emergencyPhone: p?.emergencyContact?.phone ?? "",
    employmentStart: p?.employmentStart ?? "",
    employmentEnd: p?.employmentEnd ?? "",
    contractedDaysPerWeek: p?.contractedDaysPerWeek === null || p?.contractedDaysPerWeek === undefined ? "" : String(p.contractedDaysPerWeek),
    entitlementDaysOverride:
      p?.entitlementDaysOverride === null || p?.entitlementDaysOverride === undefined ? "" : String(p.entitlementDaysOverride),
    gdcNumber: p?.gdcNumber ?? "",
    niNumberLast4: p?.niNumberLast4 ?? "",
  };
}

/** The network half on its own: it either resolves with a good payload or throws. */
async function readPeople(clientSlug: string): Promise<HrProfileResponse> {
  const res = await fetch(`/api/hr/profile?client=${encodeURIComponent(clientSlug)}`);
  const data = (await res.json().catch(() => ({}))) as HrProfileResponse & { error?: string };
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `The employee file could not be read (${res.status}).`);
  }
  return data;
}

export function HrWorkspace({ clientSlug }: { clientSlug: string }) {
  const [data, setData] = useState<HrProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditForm>(formFor(null));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [rateForm, setRateForm] = useState({ hourlyPounds: "", effectiveFrom: "", note: "" });
  const [rateError, setRateError] = useState<string | null>(null);
  const [savingRate, setSavingRate] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // THE FETCH IS IN THE EFFECT, EVERY setState IS IN ITS CALLBACK. A synchronous
  // setState in an effect body causes a cascading render (and the lint rule that
  // guards it), so the "loading" flag is raised by whatever TRIGGERS a reload
  // rather than by the effect that performs it. Same shape as useDiaryDay and
  // the check-in workspace.
  useEffect(() => {
    let live = true;
    readPeople(clientSlug)
      .then((payload) => {
        if (!live) return;
        setData(payload);
        setLoadError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!live) return;
        // LOUD: a failed read says so. An empty employee file would read as a
        // practice that has recorded nothing about anybody.
        setLoadError(err instanceof Error ? err.message : "The employee file could not be read.");
        setData(null);
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [clientSlug, reloadKey]);

  const people = useMemo(() => data?.people ?? [], [data]);
  const selected = people.find((p) => p.staffId === selectedId) ?? null;

  const startEditing = useCallback((person: HrPerson) => {
    setForm(formFor(person));
    setSaveError(null);
    setEditing(true);
  }, []);

  const save = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/hr/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          staffId: selected.staffId,
          dateOfBirth: form.dateOfBirth || null,
          personalEmail: form.personalEmail || null,
          personalPhone: form.personalPhone || null,
          address: { line1: form.addressLine1, town: form.addressTown, postcode: form.addressPostcode },
          emergencyContact: {
            name: form.emergencyName,
            relationship: form.emergencyRelationship,
            phone: form.emergencyPhone,
          },
          employmentStart: form.employmentStart || null,
          employmentEnd: form.employmentEnd || null,
          contractedDaysPerWeek: form.contractedDaysPerWeek === "" ? null : form.contractedDaysPerWeek,
          entitlementDaysOverride: form.entitlementDaysOverride === "" ? null : form.entitlementDaysOverride,
          gdcNumber: form.gdcNumber || null,
          niNumberLast4: form.niNumberLast4 || null,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || `Could not save (${res.status}).`);
      setEditing(false);
      setLoading(true);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }, [clientSlug, form, selected]);

  const saveRate = useCallback(async () => {
    if (!selected) return;
    setSavingRate(true);
    setRateError(null);
    try {
      const res = await fetch("/api/hr/profile/pay-rate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          staffId: selected.staffId,
          hourlyPounds: rateForm.hourlyPounds,
          effectiveFrom: rateForm.effectiveFrom,
          note: rateForm.note || null,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || `Could not record the rate (${res.status}).`);
      setRateForm({ hourlyPounds: "", effectiveFrom: "", note: "" });
      setLoading(true);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setRateError(err instanceof Error ? err.message : "Could not record the rate.");
    } finally {
      setSavingRate(false);
    }
  }, [clientSlug, rateForm, selected]);

  const columns: Column<HrPerson>[] = useMemo(() => {
    const base: Column<HrPerson>[] = [
      {
        key: "name",
        header: "Name",
        cell: (p) => (
          <span className="font-medium text-navy">
            {p.name}
            {!p.active ? <span className="ml-2 text-xs font-normal text-muted">(inactive)</span> : null}
          </span>
        ),
      },
      { key: "role", header: "Role", cell: (p) => <span className="capitalize">{p.role}</span> },
      { key: "site", header: "Site", cell: (p) => p.siteId ?? "Any site" },
      {
        key: "week",
        header: "Days a week",
        align: "right",
        cell: (p) => (
          <>
            {p.entitlement.daysPerWeek}
            {p.entitlement.daysPerWeekFromProfile ? (
              <span className="ml-1 text-xs text-muted">set</span>
            ) : null}
          </>
        ),
      },
      {
        key: "holiday",
        header: "Holiday (days)",
        align: "right",
        cell: (p) => (
          <span title={p.entitlement.note}>
            {p.entitlement.days}
            <span className="ml-2 text-xs text-muted">{BASIS_LABEL[p.entitlement.basis] ?? p.entitlement.basis}</span>
          </span>
        ),
      },
      {
        key: "start",
        header: "Started",
        cell: (p) => p.profile?.employmentStart ?? <span className="text-muted">Not recorded</span>,
      },
      {
        key: "file",
        header: "File",
        cell: (p) =>
          p.profile ? (
            <StatusPill tone="success">Recorded</StatusPill>
          ) : (
            <StatusPill tone="neutral">Empty</StatusPill>
          ),
      },
    ];

    // The column only EXISTS when the payload carried pay. There is no hidden
    // column and no blanked cell.
    if (data?.includesPay) {
      base.push({
        key: "rate",
        header: "Rate",
        align: "right",
        cell: (p) =>
          p.pay?.currentPence === null || p.pay?.currentPence === undefined ? (
            <span className="text-muted">No rate</span>
          ) : (
            formatPenceGbp(p.pay.currentPence)
          ),
      });
    }
    return base;
  }, [data?.includesPay]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" />
        Reading the employee file...
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="mt-6 rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
        <span className="flex items-center gap-2 font-semibold">
          <ShieldAlert size={15} /> The employee file could not be read
        </span>
        <p className="mt-1 font-normal">{loadError}</p>
      </div>
    );
  }

  const withFile = people.filter((p) => p.profile).length;

  return (
    <div className="mt-6 space-y-7">
      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <StatCard label="People" value={people.length} emphasis />
        <StatCard label="With a file" value={withFile} />
        <StatCard label="Leave year from" value={people[0]?.entitlement.leaveYear.start ?? "Not set"} />
      </div>

      {!data.includesPay ? (
        <p className="flex items-start gap-2 rounded-lg border border-line bg-card-muted px-3 py-2 text-[13px] text-muted">
          <Lock size={14} className="mt-0.5 shrink-0" />
          Pay is a separate permission and is not part of this view for your login. The figures are not
          hidden here: they are never sent.
        </p>
      ) : null}

      <SectionCard
        title="The team"
        description="Holiday entitlement is the statutory starting point for each person's working pattern. It is decision support, not legal advice, and the practice can set its own figure."
      >
        {people.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nobody on the rota yet"
            description="Add your team on the Staff rota first. The employee file is kept against the same people, so the two cannot disagree about who works here."
          />
        ) : (
          <DataTable
            columns={columns}
            rows={people}
            getRowKey={(p) => p.staffId}
            onRowClick={(p) => {
              setSelectedId(p.staffId);
              setEditing(false);
              setSaveError(null);
              setRateError(null);
            }}
          />
        )}
      </SectionCard>

      {selected ? (
        <SectionCard
          title={selected.name}
          description={selected.entitlement.note}
          actions={
            data.canEdit && !editing ? (
              <Button variant="secondary" size="sm" onClick={() => startEditing(selected)}>
                Edit file
              </Button>
            ) : null
          }
        >
          {editing ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Date of birth" type="date" value={form.dateOfBirth} onChange={(v) => setForm((f) => ({ ...f, dateOfBirth: v }))} />
                <Field label="Personal email" type="email" value={form.personalEmail} onChange={(v) => setForm((f) => ({ ...f, personalEmail: v }))} />
                <Field label="Personal phone" value={form.personalPhone} onChange={(v) => setForm((f) => ({ ...f, personalPhone: v }))} />
                <Field label="Address" value={form.addressLine1} onChange={(v) => setForm((f) => ({ ...f, addressLine1: v }))} />
                <Field label="Town" value={form.addressTown} onChange={(v) => setForm((f) => ({ ...f, addressTown: v }))} />
                <Field label="Postcode" value={form.addressPostcode} onChange={(v) => setForm((f) => ({ ...f, addressPostcode: v }))} />
                <Field label="Emergency contact" value={form.emergencyName} onChange={(v) => setForm((f) => ({ ...f, emergencyName: v }))} />
                <Field label="Relationship" value={form.emergencyRelationship} onChange={(v) => setForm((f) => ({ ...f, emergencyRelationship: v }))} />
                <Field label="Emergency phone" value={form.emergencyPhone} onChange={(v) => setForm((f) => ({ ...f, emergencyPhone: v }))} />
                <Field label="Employment start" type="date" value={form.employmentStart} onChange={(v) => setForm((f) => ({ ...f, employmentStart: v }))} />
                <Field label="Employment end" type="date" value={form.employmentEnd} onChange={(v) => setForm((f) => ({ ...f, employmentEnd: v }))} />
                <Field
                  label="Contracted days a week"
                  value={form.contractedDaysPerWeek}
                  onChange={(v) => setForm((f) => ({ ...f, contractedDaysPerWeek: v }))}
                  hint="Overrides the days marked on the rota."
                />
                <Field
                  label="Holiday days (override)"
                  value={form.entitlementDaysOverride}
                  onChange={(v) => setForm((f) => ({ ...f, entitlementDaysOverride: v }))}
                  hint="The practice's final word. Leave blank to use the statutory figure."
                />
                <Field label="GDC number" value={form.gdcNumber} onChange={(v) => setForm((f) => ({ ...f, gdcNumber: v }))} />
                <Field
                  label="NI number (last 4)"
                  value={form.niNumberLast4}
                  onChange={(v) => setForm((f) => ({ ...f, niNumberLast4: v.slice(0, 4) }))}
                  hint="Only the last four characters are stored."
                />
              </div>

              {saveError ? (
                <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{saveError}</p>
              ) : null}

              <div className="flex items-center gap-2">
                <Button variant="primary" size="sm" disabled={saving} onClick={save}>
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save file
                </Button>
                <Button variant="ghost" size="sm" disabled={saving} onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <dl className="grid gap-x-8 gap-y-3 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
              <Detail label="Date of birth" value={selected.profile?.dateOfBirth} />
              <Detail label="Personal email" value={selected.profile?.personalEmail} />
              <Detail label="Personal phone" value={selected.profile?.personalPhone} />
              <Detail
                label="Address"
                value={[selected.profile?.address?.line1, selected.profile?.address?.town, selected.profile?.address?.postcode]
                  .filter(Boolean)
                  .join(", ")}
              />
              <Detail
                label="Emergency contact"
                value={[selected.profile?.emergencyContact?.name, selected.profile?.emergencyContact?.relationship, selected.profile?.emergencyContact?.phone]
                  .filter(Boolean)
                  .join(" - ")}
              />
              <Detail label="Employment start" value={selected.profile?.employmentStart} />
              <Detail label="Employment end" value={selected.profile?.employmentEnd} />
              <Detail label="GDC number" value={selected.profile?.gdcNumber} />
              <Detail
                label="NI number"
                value={selected.profile?.niNumberLast4 ? `ending ${selected.profile.niNumberLast4}` : null}
              />
              <Detail
                label="Holiday this leave year"
                value={`${selected.entitlement.days} days (${BASIS_LABEL[selected.entitlement.basis] ?? selected.entitlement.basis})`}
              />
              <Detail
                label="Leave year"
                value={`${selected.entitlement.leaveYear.start} to ${selected.entitlement.leaveYear.end}`}
              />
            </dl>
          )}

          {data.includesPay && selected.pay ? (
            <div className="mt-7 border-t border-line pt-5">
              <h4 className="text-title text-navy">Pay</h4>
              <p className="mt-1 text-caption font-normal text-muted">
                Rates are effective dated and appended, never edited: a rise is recorded from a date, so the
                hours already worked keep the rate they were worked at.
              </p>

              {selected.pay.history.length === 0 ? (
                <p className="mt-3 text-[13px] text-muted">No rate recorded for this person.</p>
              ) : (
                <ul className="mt-3 space-y-1.5 text-[13px]">
                  {selected.pay.history.map((rate) => (
                    <li key={rate.id} className="flex flex-wrap items-baseline gap-x-3">
                      <span className="font-medium text-navy">{formatPenceGbp(rate.hourlyPence)} an hour</span>
                      <span className="text-muted">
                        from {rate.effectiveFrom}
                        {rate.effectiveTo ? ` to ${rate.effectiveTo}` : ""}
                      </span>
                      {rate.note ? <span className="text-muted">{rate.note}</span> : null}
                    </li>
                  ))}
                </ul>
              )}

              {data.canEdit ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <Field
                    label="Hourly rate (£)"
                    value={rateForm.hourlyPounds}
                    onChange={(v) => setRateForm((f) => ({ ...f, hourlyPounds: v }))}
                    hint="For example 12.50"
                  />
                  <Field
                    label="From"
                    type="date"
                    value={rateForm.effectiveFrom}
                    onChange={(v) => setRateForm((f) => ({ ...f, effectiveFrom: v }))}
                  />
                  <Field label="Note" value={rateForm.note} onChange={(v) => setRateForm((f) => ({ ...f, note: v }))} />
                  <div className="sm:col-span-3">
                    {rateError ? (
                      <p className="mb-2 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
                        {rateError}
                      </p>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={savingRate || rateForm.hourlyPounds.trim() === "" || rateForm.effectiveFrom === ""}
                      onClick={saveRate}
                    >
                      {savingRate ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Record this rate
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      <p className="text-[12px] text-faint">
        Employee personal data under UK GDPR. Access is limited to the practice owner, the agency and the
        practice manager; pay is narrower still. The practice is responsible for its own retention period and
        for recording this processing.
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} />
      {hint ? <span className="mt-1 block text-[11px] text-faint">{hint}</span> : null}
    </label>
  );
}

function Detail({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-[0.04em] text-faint">{label}</dt>
      <dd className="mt-0.5 text-ink">{value && value !== "" ? value : <span className="text-muted">Not recorded</span>}</dd>
    </div>
  );
}
