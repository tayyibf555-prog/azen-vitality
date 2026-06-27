"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Loader2, X, Pause, Play, Pencil, Trash2, BadgeCheck, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusPill, EmptyState } from "@/components/primitives";
import { USP_CATEGORIES, type Usp, type UspCategory } from "@/lib/usp/types";

// One selling point as returned by GET /api/usp. Mirrors the Usp type; kept local
// so this file owns its own contract against the API.
type UspRow = Usp;

interface FormState {
  text: string;
  category: string; // "" = no category
  priority: string; // text input, parsed on submit
}

const EMPTY_FORM: FormState = { text: "", category: "", priority: "" };

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-xs font-semibold text-navy";

function categoryLabel(c: UspCategory): string {
  return c.charAt(0).toUpperCase() + c.slice(1);
}

export function UspsPanel({ clientSlug }: { clientSlug: string }) {
  const [usps, setUsps] = useState<UspRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Per-row "write in flight" guard, keyed by USP id.
  const [busyId, setBusyId] = useState<string | null>(null);

  // Inline edit state, scoped to a single row at a time.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [editError, setEditError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/usp?client=${encodeURIComponent(clientSlug)}`);
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; usps?: UspRow[]; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not load selling points (${res.status}).`);
      setUsps(data.usps ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load selling points.");
      setUsps([]);
    } finally {
      setLoading(false);
    }
  }, [clientSlug]);

  // Reset + refetch whenever the client changes.
  useEffect(() => {
    setShowForm(false);
    setForm(EMPTY_FORM);
    setFormError(null);
    setEditingId(null);
    void load();
  }, [load]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setEdit<K extends keyof FormState>(key: K, value: FormState[K]) {
    setEditForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch("/api/usp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          text: form.text,
          category: form.category || undefined,
          priority: form.priority.trim() === "" ? undefined : Number(form.priority),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; usp?: UspRow; error?: string };
      if (!res.ok || !data.ok || !data.usp) {
        throw new Error(data.error || `Could not add the selling point (${res.status}).`);
      }
      // Reload so the server's priority ordering is reflected exactly.
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not add the selling point.");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(usp: UspRow) {
    if (busyId) return;
    const next = !usp.active;
    setBusyId(usp.id);
    // Optimistic flip; revert on failure.
    setUsps((prev) => prev.map((u) => (u.id === usp.id ? { ...u, active: next } : u)));
    try {
      const res = await fetch(`/api/usp/${encodeURIComponent(usp.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, active: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "status update failed");
    } catch {
      setUsps((prev) => prev.map((u) => (u.id === usp.id ? { ...u, active: usp.active } : u)));
    } finally {
      setBusyId(null);
    }
  }

  function startEdit(usp: UspRow) {
    setEditingId(usp.id);
    setEditError(null);
    setEditForm({
      text: usp.text,
      category: usp.category ?? "",
      priority: String(usp.priority),
    });
  }

  async function saveEdit(usp: UspRow) {
    if (busyId) return;
    setBusyId(usp.id);
    setEditError(null);
    try {
      const res = await fetch(`/api/usp/${encodeURIComponent(usp.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          text: editForm.text,
          category: editForm.category || null,
          priority: editForm.priority.trim() === "" ? undefined : Number(editForm.priority),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not save (${res.status}).`);
      setEditingId(null);
      await load();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Could not save the changes.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(usp: UspRow) {
    if (busyId) return;
    if (!window.confirm("Delete this selling point? The agents will stop mentioning it.")) return;
    setBusyId(usp.id);
    try {
      const res = await fetch(`/api/usp/${encodeURIComponent(usp.id)}?client=${encodeURIComponent(clientSlug)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "delete failed");
      setUsps((prev) => prev.filter((u) => u.id !== usp.id));
    } catch {
      // Leave the row in place on failure; a reload will reconcile.
    } finally {
      setBusyId(null);
    }
  }

  return (
    <SectionCard
      title="Selling points"
      description="Keep these short and truthful. The agents weave them in naturally and never present them as clinical guarantees."
      actions={
        <Button
          variant={showForm ? "secondary" : "primary"}
          size="sm"
          onClick={() => {
            setFormError(null);
            setShowForm((s) => !s);
          }}
        >
          {showForm ? <X size={15} /> : <Plus size={15} />}
          {showForm ? "Cancel" : "Add selling point"}
        </Button>
      }
    >
      <div className="space-y-5">
        {/* Create form */}
        {showForm ? (
          <form onSubmit={submit} className="rounded-xl border border-line-strong bg-card-muted/40 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label htmlFor="usp-text" className={labelClass}>
                  Selling point <span className="text-danger">*</span>
                </label>
                <input
                  id="usp-text"
                  type="text"
                  required
                  value={form.text}
                  onChange={(e) => set("text", e.target.value)}
                  placeholder="Flexible 0% finance on most treatments."
                  className={inputClass}
                />
              </div>

              <div>
                <label htmlFor="usp-category" className={labelClass}>
                  Category
                </label>
                <select
                  id="usp-category"
                  value={form.category}
                  onChange={(e) => set("category", e.target.value)}
                  className={inputClass}
                >
                  <option value="">None</option>
                  {USP_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {categoryLabel(c)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="usp-priority" className={labelClass}>
                  Priority
                </label>
                <input
                  id="usp-priority"
                  type="number"
                  inputMode="numeric"
                  value={form.priority}
                  onChange={(e) => set("priority", e.target.value)}
                  placeholder="0"
                  className={inputClass}
                />
                <p className="mt-1 text-xs text-muted">Higher numbers are mentioned first.</p>
              </div>
            </div>

            {formError ? (
              <p className="mt-4 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
                {formError}
              </p>
            ) : null}

            <div className="mt-4 flex items-center gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={submitting || form.text.trim().length === 0}>
                {submitting ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                Add selling point
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={submitting}
                onClick={() => {
                  setShowForm(false);
                  setFormError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}

        {/* List */}
        {loadError ? (
          <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{loadError}</p>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading selling points...
          </div>
        ) : usps.length === 0 ? (
          <EmptyState
            icon={BadgeCheck}
            title="No selling points yet"
            description="Add your first one. The AI agents weave active selling points into their conversion messages, so the same true reasons to choose you show up across every channel."
          >
            <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
              <Plus size={15} /> Add selling point
            </Button>
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {usps.map((u) => (
              <li
                key={u.id}
                className="rounded-xl border border-line bg-card px-4 py-3.5 shadow-[0_1px_2px_rgba(10,14,26,0.04)]"
              >
                {editingId === u.id ? (
                  // Inline edit
                  <div className="space-y-3">
                    <div>
                      <label htmlFor={`edit-text-${u.id}`} className={labelClass}>
                        Selling point <span className="text-danger">*</span>
                      </label>
                      <input
                        id={`edit-text-${u.id}`}
                        type="text"
                        value={editForm.text}
                        onChange={(e) => setEdit("text", e.target.value)}
                        className={inputClass}
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label htmlFor={`edit-cat-${u.id}`} className={labelClass}>
                          Category
                        </label>
                        <select
                          id={`edit-cat-${u.id}`}
                          value={editForm.category}
                          onChange={(e) => setEdit("category", e.target.value)}
                          className={inputClass}
                        >
                          <option value="">None</option>
                          {USP_CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {categoryLabel(c)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`edit-pri-${u.id}`} className={labelClass}>
                          Priority
                        </label>
                        <input
                          id={`edit-pri-${u.id}`}
                          type="number"
                          inputMode="numeric"
                          value={editForm.priority}
                          onChange={(e) => setEdit("priority", e.target.value)}
                          className={inputClass}
                        />
                      </div>
                    </div>

                    {editError ? (
                      <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
                        {editError}
                      </p>
                    ) : null}

                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busyId !== null || editForm.text.trim().length === 0}
                        onClick={() => saveEdit(u)}
                      >
                        {busyId === u.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                        Save
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId !== null}
                        onClick={() => {
                          setEditingId(null);
                          setEditError(null);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  // Read view
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm text-navy">{u.text}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <StatusPill tone={u.active ? "success" : "neutral"}>
                          {u.active ? "Active" : "Paused"}
                        </StatusPill>
                        {u.category ? <StatusPill tone="info">{categoryLabel(u.category)}</StatusPill> : null}
                        <span className="text-xs text-muted">
                          Priority <span className="font-semibold tabular-nums text-ink">{u.priority}</span>
                        </span>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <Button variant="secondary" size="sm" onClick={() => toggleActive(u)} disabled={busyId !== null}>
                        {busyId === u.id ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : u.active ? (
                          <Pause size={14} />
                        ) : (
                          <Play size={14} />
                        )}
                        {u.active ? "Pause" : "Activate"}
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => startEdit(u)} disabled={busyId !== null}>
                        <Pencil size={14} /> Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => remove(u)} disabled={busyId !== null}>
                        <Trash2 size={14} /> Delete
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  );
}
