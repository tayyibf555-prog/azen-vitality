"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Save, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/primitives";
import type { RotaConfig } from "@/lib/rota/types";
import { COVERAGE_ROLES, roleLabel } from "./shared";

// The "Settings" tab: the rota_config.
//
// rolesNeeded: how many people of each role to schedule per open day per site.
// notifyLeadDays: only text shifts starting within this many days.
// generateWeeksAhead: how many weeks ahead to keep the rota generated.
// Loaded from GET /api/rota/config and saved via PUT. The form holds strings while
// editing; they are coerced to positive integers on save (the API normalises anyway).

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-sm font-semibold text-navy";

interface FormState {
  rolesNeeded: Record<string, string>;
  notifyLeadDays: string;
  generateWeeksAhead: string;
}

function configToForm(config: RotaConfig): FormState {
  const rolesNeeded: Record<string, string> = {};
  for (const role of COVERAGE_ROLES) {
    rolesNeeded[role] = String(config.rolesNeeded[role] ?? 0);
  }
  return {
    rolesNeeded,
    notifyLeadDays: String(config.notifyLeadDays),
    generateWeeksAhead: String(config.generateWeeksAhead),
  };
}

/** Coerce a form string to a non-negative integer, defaulting to 0 on junk. */
function toInt(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export function RotaSettingsPanel({ clientSlug }: { clientSlug: string }) {
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/rota/config?client=${encodeURIComponent(clientSlug)}`);
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; config?: RotaConfig; error?: string };
      if (!res.ok || !data.ok || !data.config) {
        throw new Error(data.error || `Could not load the settings (${res.status}).`);
      }
      setForm(configToForm(data.config));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the settings.");
      setForm(null);
    } finally {
      setLoading(false);
    }
  }, [clientSlug]);

  useEffect(() => {
    setSaved(false);
    setSaveError(null);
    void load();
  }, [load]);

  function setRole(role: string, value: string) {
    setForm((f) => (f ? { ...f, rolesNeeded: { ...f.rolesNeeded, [role]: value } } : f));
    setSaved(false);
  }

  function setField<K extends "notifyLeadDays" | "generateWeeksAhead">(key: K, value: string) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    setSaved(false);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !form) return;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const rolesNeeded: Record<string, number> = {};
      for (const [role, v] of Object.entries(form.rolesNeeded)) {
        const n = toInt(v);
        if (n > 0) rolesNeeded[role] = n;
      }
      const res = await fetch("/api/rota/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          config: {
            rolesNeeded,
            notifyLeadDays: toInt(form.notifyLeadDays),
            generateWeeksAhead: toInt(form.generateWeeksAhead),
          },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; config?: RotaConfig; error?: string };
      if (!res.ok || !data.ok || !data.config) throw new Error(data.error || `Could not save (${res.status}).`);
      // Reflect the server's normalised config exactly.
      setForm(configToForm(data.config));
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save the settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="Settings"
      description="The staffing rules the rota is built from. Save to apply them the next time the rota is generated."
    >
      {loadError ? (
        <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{loadError}</p>
      ) : loading || !form ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" />
          Loading the settings...
        </div>
      ) : (
        <form onSubmit={save} className="space-y-6">
          <div>
            <h4 className="text-sm font-semibold text-navy">Cover per open day, per site</h4>
            <p className="mt-0.5 text-xs text-muted">
              How many people of each role to schedule for every open day at each site. Set 0 to skip a role.
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {COVERAGE_ROLES.map((role) => (
                <div key={role}>
                  <label htmlFor={`cover-${role}`} className={labelClass}>
                    {roleLabel(role)}
                  </label>
                  <input
                    id={`cover-${role}`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={form.rolesNeeded[role] ?? "0"}
                    onChange={(e) => setRole(role, e.target.value)}
                    className={inputClass}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="notify-lead" className={labelClass}>
                Text shifts within
              </label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  id="notify-lead"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={form.notifyLeadDays}
                  onChange={(e) => setField("notifyLeadDays", e.target.value)}
                  className={inputClass + " mt-0"}
                />
                <span className="text-sm text-muted">days</span>
              </div>
              <p className="mt-1 text-xs text-muted">Only shifts starting within this window are texted to staff.</p>
            </div>
            <div>
              <label htmlFor="weeks-ahead" className={labelClass}>
                Generate ahead
              </label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  id="weeks-ahead"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={form.generateWeeksAhead}
                  onChange={(e) => setField("generateWeeksAhead", e.target.value)}
                  className={inputClass + " mt-0"}
                />
                <span className="text-sm text-muted">weeks</span>
              </div>
              <p className="mt-1 text-xs text-muted">How many weeks of shifts to keep generated in advance.</p>
            </div>
          </div>

          {saveError ? (
            <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
              {saveError}
            </p>
          ) : null}
          {saved ? (
            <p className="flex items-center gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm text-success">
              <CheckCircle2 size={16} className="shrink-0" />
              Settings saved.
            </p>
          ) : null}

          <div>
            <Button type="submit" variant="primary" size="sm" disabled={saving}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              Save settings
            </Button>
          </div>
        </form>
      )}
    </SectionCard>
  );
}
