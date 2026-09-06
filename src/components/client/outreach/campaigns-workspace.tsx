"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Plus,
  Loader2,
  X,
  Send,
  Pause,
  Play,
  Rocket,
  ShieldCheck,
  Users,
  ChevronRight,
  AlertTriangle,
  ShieldOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusPill, EmptyState, DataTable, type Column, type Tone } from "@/components/primitives";
import { cn } from "@/lib/utils";
// THE BUILD LOOP'S RULE, in a pure leaf rather than inside the callback below.
// It has no imports of its own, so a client bundle reading it drags nothing
// server-side with it, and its four outcomes (failure, finished, rate-limited,
// REFUSED) are driven by src/lib/outreach/build-progress.test.ts.
import { buildLoopStep, type BuildTickResponse } from "@/lib/outreach/build-progress";

// ---------------------------------------------------------------------------
// Contracts (kept local; mirror the API shapes returned by /api/outreach/*).
// ---------------------------------------------------------------------------

export interface SiteOption {
  id: string;
  name: string;
}
interface PractitionerOption {
  id: string;
  name: string;
}

type CampaignStatus = "draft" | "building" | "ready" | "running" | "paused" | "done";

interface CampaignFilters {
  lastVisitAfter?: string;
  lastVisitBefore?: string;
  treatmentContains?: string[];
  excludeSeenSinceDays?: number;
  requiresMobile?: boolean;
  ageMin?: number;
  ageMax?: number;
  gender?: "female" | "male";
}

interface VariantCounts {
  assigned: number;
  sent: number;
  replied: number;
  booked: number;
}

interface CampaignListItem {
  id: string;
  name: string;
  siteId: string;
  status: CampaignStatus;
  dailyCap: number;
  messageAngle: string | null;
  /** Second message angle when this is a two-message A/B campaign; null otherwise. */
  messageAngleB: string | null;
  practitionerName: string | null;
  filters: CampaignFilters;
  counts: { built: number; contacted: number; replied: number; booked: number; blocked: number };
  /** Per-message sent/replied/booked read-back; present only for a two-message campaign. */
  variants: { a: VariantCounts; b: VariantCounts } | null;
}

interface PreviewTarget {
  id: string;
  name: string;
  phoneMasked: string | null;
  matchedReason: string | null;
  status: string;
}

interface CampaignDetail {
  matched: number;
  /** Of the matched, how many have SMS consent (contactable). null when not yet computed. */
  contactable: number | null;
  previewLimit: number;
  excludedMissingData: number;
  targets: PreviewTarget[];
}

// ---------------------------------------------------------------------------
// Form.
// ---------------------------------------------------------------------------

interface FormState {
  name: string;
  siteId: string;
  treatments: string[];
  treatmentDraft: string;
  lastVisitAfter: string;
  lastVisitBefore: string;
  excludeSeenSinceDays: string;
  ageMin: string;
  ageMax: string;
  gender: "" | "female" | "male";
  practitionerId: string;
  messageAngle: string;
  dailyCap: string;
}

const HYGIENE_PRESET = ["hygiene", "scale", "polish"];

function emptyForm(siteId: string): FormState {
  return {
    name: "",
    siteId,
    treatments: [],
    treatmentDraft: "",
    lastVisitAfter: "",
    lastVisitBefore: "",
    excludeSeenSinceDays: "",
    ageMin: "",
    ageMax: "",
    gender: "",
    practitionerId: "",
    messageAngle: "",
    dailyCap: "25",
  };
}

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-xs font-semibold text-navy";

const STATUS_TONE: Record<CampaignStatus, Tone> = {
  draft: "neutral",
  building: "info",
  ready: "info",
  running: "success",
  paused: "warning",
  done: "neutral",
};
const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: "Draft",
  building: "Building",
  ready: "Ready",
  running: "Live",
  paused: "Paused",
  done: "Done",
};

// Defensive cap so the resumable build loop can never spin forever (each tick scans
// ~1,500 patients, so this covers a very large multi-site base with headroom).
const MAX_BUILD_TICKS = 500;

interface BuildProgress {
  pagesWalked: number;
  scanned: number;
  matched: number;
  done: boolean;
  note: string | null;
}

export function CampaignsWorkspace({
  clientSlug,
  sites,
  practitionersBySite,
  defaultSiteId,
  outreachEnabled,
  controlsHref,
}: {
  clientSlug: string;
  sites: SiteOption[];
  practitionersBySite: Record<string, PractitionerOption[]>;
  defaultSiteId: string;
  outreachEnabled: boolean;
  controlsHref: string;
}) {
  const [campaigns, setCampaigns] = useState<CampaignListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(() => emptyForm(defaultSiteId));
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // The campaign currently being built or previewed in the wizard region.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const siteName = useMemo(() => {
    const map = new Map(sites.map((s) => [s.id, s.name]));
    return (id: string) => map.get(id) ?? id;
  }, [sites]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/outreach/campaigns?client=${encodeURIComponent(clientSlug)}`);
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; campaigns?: CampaignListItem[]; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not load campaigns (${res.status}).`);
      setCampaigns(data.campaigns ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load campaigns.");
      setCampaigns([]);
    } finally {
      setLoading(false);
    }
  }, [clientSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const activeCampaign = campaigns.find((c) => c.id === activeId) ?? null;
  const practitioners = practitionersBySite[form.siteId] ?? [];

  // -- Chip input for treatment keywords ------------------------------------
  function addTreatment(raw: string) {
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length === 0) return;
    setForm((f) => {
      const next = new Set([...f.treatments.map((t) => t.toLowerCase()), ...parts.map((p) => p.toLowerCase())]);
      return { ...f, treatments: [...next], treatmentDraft: "" };
    });
  }
  function removeTreatment(t: string) {
    setForm((f) => ({ ...f, treatments: f.treatments.filter((x) => x !== t) }));
  }

  // -- Build loop (resumable; re-invokes until done) ------------------------
  const runBuild = useCallback(
    async (campaignId: string) => {
      setBuilding(true);
      setDetail(null);
      setProgress({ pagesWalked: 0, scanned: 0, matched: 0, done: false, note: null });
      try {
        for (let tick = 0; tick < MAX_BUILD_TICKS; tick += 1) {
          const res = await fetch("/api/outreach/build", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ campaignId }),
          });
          const data = (await res.json().catch(() => ({}))) as BuildTickResponse & {
            counts?: { scanned?: number; matched?: number };
            cursor?: { page?: number } | null;
          };
          // WHAT HAPPENS NEXT IS DECIDED IN ONE PLACE, and it is not here.
          // `buildLoopStep` (src/lib/outreach/build-progress.ts) holds the four
          // outcomes and their sentences, so the rule can be driven by a test
          // instead of living inside a React callback nothing can reach. In
          // particular it reads `skipped`: a tick that REFUSED because the
          // do-not-contact list could not be read comes back ok:true /
          // done:false / stopped:null, and without that check this loop span its
          // full MAX_BUILD_TICKS and left the owner on "scanned 0 / matched 0"
          // with no note at all.
          const step = buildLoopStep(res.ok, data);
          if (step.failed) {
            // The counts are NOT repainted: a failure body may carry nothing but
            // an error, and blanking the screen to zero would read as "the scan
            // found nobody" rather than "the scan did not run".
            setProgress((p) => ({ ...(p ?? { pagesWalked: 0, scanned: 0, matched: 0, done: false, note: null }), note: step.note }));
            break;
          }
          setProgress({
            pagesWalked: Math.max(0, (data.cursor?.page ?? 1) - 1),
            scanned: data.counts?.scanned ?? 0,
            matched: data.counts?.matched ?? 0,
            done: Boolean(data.done),
            note: step.note,
          });
          if (step.stop) break;
        }
      } finally {
        setBuilding(false);
        await load(); // refresh the list counts/status
        await loadDetail(campaignId);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load],
  );

  const loadDetail = useCallback(async (campaignId: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/outreach/campaigns/${encodeURIComponent(campaignId)}`);
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        matched?: number;
        previewLimit?: number;
        targets?: PreviewTarget[];
        campaign?: { counts?: { excludedMissingData?: number; contactable?: number } | null };
      };
      if (res.ok && data.ok) {
        const contactable = data.campaign?.counts?.contactable;
        setDetail({
          matched: data.matched ?? 0,
          contactable: typeof contactable === "number" ? contactable : null,
          previewLimit: data.previewLimit ?? 100,
          excludedMissingData: data.campaign?.counts?.excludedMissingData ?? 0,
          targets: data.targets ?? [],
        });
      }
    } finally {
      setDetailLoading(false);
    }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    setBanner(null);
    try {
      const filters: CampaignFilters = { requiresMobile: true };
      if (form.treatments.length > 0) filters.treatmentContains = form.treatments;
      if (form.lastVisitAfter) filters.lastVisitAfter = form.lastVisitAfter;
      if (form.lastVisitBefore) filters.lastVisitBefore = form.lastVisitBefore;
      if (form.excludeSeenSinceDays.trim()) filters.excludeSeenSinceDays = Number(form.excludeSeenSinceDays);
      if (form.ageMin.trim()) filters.ageMin = Number(form.ageMin);
      if (form.ageMax.trim()) filters.ageMax = Number(form.ageMax);
      if (form.gender) filters.gender = form.gender;

      const practitionerName = practitioners.find((p) => p.id === form.practitionerId)?.name ?? null;

      const res = await fetch("/api/outreach/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          name: form.name,
          siteId: form.siteId,
          filters,
          messageAngle: form.messageAngle || undefined,
          practitionerId: form.practitionerId || undefined,
          practitionerName: practitionerName || undefined,
          dailyCap: form.dailyCap.trim() ? Number(form.dailyCap) : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; campaign?: CampaignListItem; error?: string };
      if (!res.ok || !data.ok || !data.campaign) throw new Error(data.error || `Could not create the campaign (${res.status}).`);

      setCampaigns((prev) => [data.campaign as CampaignListItem, ...prev]);
      setShowForm(false);
      setForm(emptyForm(defaultSiteId));
      setActiveId(data.campaign.id);
      await runBuild(data.campaign.id);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not create the campaign.");
    } finally {
      setSubmitting(false);
    }
  }

  async function openCampaign(c: CampaignListItem) {
    setActiveId(c.id);
    setProgress(null);
    setBanner(null);
    if (c.status === "building" || c.status === "draft") {
      // Incomplete build: continue where it left off.
      await runBuild(c.id);
    } else {
      await loadDetail(c.id);
    }
  }

  async function act(c: CampaignListItem, action: "launch" | "pause" | "resume") {
    if (actionId) return;
    setActionId(c.id);
    setBanner(null);
    try {
      const res = await fetch(`/api/outreach/campaigns/${encodeURIComponent(c.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: CampaignStatus; error?: string; message?: string };
      if (!res.ok || !data.ok) {
        setBanner(data.message || data.error || "That action could not be completed.");
        return;
      }
      const nextStatus = data.status ?? c.status;
      setCampaigns((prev) => prev.map((x) => (x.id === c.id ? { ...x, status: nextStatus } : x)));
    } catch {
      setBanner("That action could not be completed just now.");
    } finally {
      setActionId(null);
    }
  }

  // -- Render ---------------------------------------------------------------

  const previewColumns: Column<PreviewTarget>[] = [
    { key: "name", header: "Patient", cell: (t) => <span className="font-medium text-navy">{t.name}</span> },
    { key: "phone", header: "Mobile", cell: (t) => <span className="tabular-nums text-muted">{t.phoneMasked ?? "None on file"}</span> },
    { key: "reason", header: "Last visit / reason", cell: (t) => <span className="text-ink">{t.matchedReason ?? "-"}</span> },
    { key: "status", header: "Stage", align: "right", cell: (t) => <span className="text-xs capitalize text-muted">{t.status}</span> },
  ];

  return (
    <div className="mt-5 space-y-5">
      {/* Safety rails: what launching actually does. */}
      <div className="flex flex-wrap items-start gap-3 rounded-[15px] border border-line bg-card-muted/50 px-4 py-3 text-sm">
        <ShieldCheck size={18} className="mt-0.5 shrink-0 text-blue-royal" />
        <div className="min-w-0 space-y-1">
          <p className="font-semibold text-navy">How campaigns stay safe</p>
          <p className="text-xs text-muted">
            A launched campaign texts at most its <span className="font-semibold text-ink">daily cap</span> patients per day.
            Every message is sent only to patients who have <span className="font-semibold text-ink">consented</span>, is checked
            against <span className="font-semibold text-ink">opt-outs</span> live, and no patient ever gets more than
            <span className="font-semibold text-ink"> one message per day</span> across the whole platform. Building a list and
            previewing it never sends anything.
          </p>
        </div>
      </div>

      {!outreachEnabled ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[15px] border border-warning/30 bg-warning/10 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-[#9a6700]" />
            <p className="text-sm text-[#7a5200]">
              Segment outreach is switched off, so campaigns can be built and previewed but not launched. Turn it on to go live.
            </p>
          </div>
          <Button asChild variant="secondary" size="sm">
            <Link href={controlsHref}>Open System controls</Link>
          </Button>
        </div>
      ) : null}

      <SectionCard
        title="Your campaigns"
        description="Each campaign builds a fresh list from the live patient base, then texts them on a gentle 3-message cadence."
        actions={
          <Button
            variant={showForm ? "secondary" : "primary"}
            size="sm"
            onClick={() => {
              setFormError(null);
              setShowForm((s) => !s);
              if (!showForm) {
                setActiveId(null);
                setDetail(null);
                setProgress(null);
              }
            }}
          >
            {showForm ? <X size={15} /> : <Plus size={15} />}
            {showForm ? "Cancel" : "New campaign"}
          </Button>
        }
      >
        <div className="space-y-5">
          {showForm ? (
            <form onSubmit={submit} className="rounded-xl border border-line-strong bg-card-muted/40 p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label htmlFor="oc-name" className={labelClass}>
                    Campaign name <span className="text-danger">*</span>
                  </label>
                  <input
                    id="oc-name"
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => set("name", e.target.value)}
                    placeholder="Hygiene reactivation, spring"
                    className={inputClass}
                  />
                </div>

                <div>
                  <label htmlFor="oc-site" className={labelClass}>
                    Site
                  </label>
                  <select id="oc-site" value={form.siteId} onChange={(e) => set("siteId", e.target.value)} className={inputClass}>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="oc-prac" className={labelClass}>
                    See this clinician (optional)
                  </label>
                  <select id="oc-prac" value={form.practitionerId} onChange={(e) => set("practitionerId", e.target.value)} className={inputClass}>
                    <option value="">Any clinician</option>
                    {practitioners.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {practitioners.length === 0 ? (
                    <p className="mt-1 text-[11px] text-muted">No practitioners loaded for this site.</p>
                  ) : null}
                </div>

                {/* Treatment keyword chips. */}
                <div className="sm:col-span-2">
                  <label htmlFor="oc-treat" className={labelClass}>
                    Past treatment keywords
                  </label>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-card-muted px-2 py-1.5">
                    {form.treatments.map((t) => (
                      <span key={t} className="inline-flex items-center gap-1 rounded-full bg-blue-royal/10 px-2 py-0.5 text-xs font-semibold text-blue-royal">
                        {t}
                        <button type="button" onClick={() => removeTreatment(t)} aria-label={`Remove ${t}`} className="text-blue-royal/70 hover:text-blue-royal">
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                    <input
                      id="oc-treat"
                      type="text"
                      value={form.treatmentDraft}
                      onChange={(e) => set("treatmentDraft", e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === ",") {
                          e.preventDefault();
                          addTreatment(form.treatmentDraft);
                        }
                      }}
                      onBlur={() => form.treatmentDraft.trim() && addTreatment(form.treatmentDraft)}
                      placeholder={form.treatments.length === 0 ? "Type a treatment and press Enter, e.g. hygiene" : "Add another"}
                      className="min-w-[120px] flex-1 bg-transparent px-1 py-0.5 text-sm text-ink placeholder:text-muted focus-visible:outline-none"
                    />
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, treatments: [...new Set([...f.treatments, ...HYGIENE_PRESET])] }))}
                      className="rounded-md border border-line-strong bg-card px-2 py-0.5 text-[11px] font-semibold text-navy hover:bg-card-muted"
                    >
                      + Hygiene preset
                    </button>
                    <span className="text-[11px] text-muted">Leave empty to match any past visit in the window.</span>
                  </div>
                </div>

                <div>
                  <label htmlFor="oc-lva" className={labelClass}>
                    Last visit on or after
                  </label>
                  <input id="oc-lva" type="date" value={form.lastVisitAfter} onChange={(e) => set("lastVisitAfter", e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label htmlFor="oc-lvb" className={labelClass}>
                    Last visit on or before
                  </label>
                  <input id="oc-lvb" type="date" value={form.lastVisitBefore} onChange={(e) => set("lastVisitBefore", e.target.value)} className={inputClass} />
                </div>

                <div>
                  <label htmlFor="oc-excl" className={labelClass}>
                    Exclude anyone seen in the last (days)
                  </label>
                  <input id="oc-excl" type="number" min={0} value={form.excludeSeenSinceDays} onChange={(e) => set("excludeSeenSinceDays", e.target.value)} placeholder="90" className={inputClass} />
                </div>

                <div>
                  <label className={labelClass}>Age range (optional)</label>
                  <div className="mt-1 flex items-center gap-2">
                    <input aria-label="Minimum age" type="number" min={0} max={120} value={form.ageMin} onChange={(e) => set("ageMin", e.target.value)} placeholder="Min" className={cn(inputClass, "mt-0")} />
                    <span className="text-muted">to</span>
                    <input aria-label="Maximum age" type="number" min={0} max={120} value={form.ageMax} onChange={(e) => set("ageMax", e.target.value)} placeholder="Max" className={cn(inputClass, "mt-0")} />
                  </div>
                </div>

                <div>
                  <label htmlFor="oc-gender" className={labelClass}>
                    Gender (optional)
                  </label>
                  <select id="oc-gender" value={form.gender} onChange={(e) => set("gender", e.target.value as FormState["gender"])} className={inputClass}>
                    <option value="">Any</option>
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label htmlFor="oc-angle" className={labelClass}>
                    What is the invite about? <span className="text-danger">*</span>
                  </label>
                  <input id="oc-angle" type="text" required value={form.messageAngle} onChange={(e) => set("messageAngle", e.target.value)} placeholder="a hygiene visit" className={inputClass} />
                  <p className="mt-1 text-[11px] text-muted">Woven into the text, in plain words. Never mentions funding or clinical detail.</p>
                </div>

                <div>
                  <label htmlFor="oc-cap" className={labelClass}>
                    Daily cap
                  </label>
                  <input id="oc-cap" type="number" min={1} max={100} value={form.dailyCap} onChange={(e) => set("dailyCap", e.target.value)} className={inputClass} />
                  <p className="mt-1 text-[11px] text-muted">Most patients contacted per day (1 to 100).</p>
                </div>
              </div>

              {(form.gender || form.ageMin.trim() || form.ageMax.trim()) ? (
                <p className="mt-3 rounded-lg border border-line bg-card px-3 py-2 text-[11px] text-muted">
                  Age and gender come from the patient record. Anyone with no recorded age or gender on file is not included when
                  those filters are used.
                </p>
              ) : null}

              {formError ? (
                <p className="mt-4 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{formError}</p>
              ) : null}

              <div className="mt-4 flex items-center gap-2">
                <Button type="submit" variant="primary" size="sm" disabled={submitting || form.name.trim().length === 0 || form.messageAngle.trim().length === 0}>
                  {submitting ? <Loader2 size={15} className="animate-spin" /> : <Users size={15} />}
                  Build the list
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : null}

          {/* Build progress + preview for the active campaign. */}
          {activeId && (building || progress || detail || detailLoading) ? (
            <div className="rounded-xl border border-blue-royal/30 bg-blue-royal/[0.04] p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-sm font-semibold text-navy">
                  <ChevronRight size={15} className="text-blue-royal" />
                  {activeCampaign?.name ?? "Campaign"}
                </p>
                {activeCampaign ? <StatusPill tone={STATUS_TONE[activeCampaign.status]}>{STATUS_LABEL[activeCampaign.status]}</StatusPill> : null}
              </div>

              {building || (progress && !progress.done) ? (
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <span className="inline-flex items-center gap-2 text-blue-royal">
                    <Loader2 size={15} className="animate-spin" /> Scanning the patient base
                  </span>
                  <span className="text-muted">
                    Pages walked <span className="font-semibold tabular-nums text-ink">{progress?.pagesWalked ?? 0}</span>
                  </span>
                  <span className="text-muted">
                    Scanned <span className="font-semibold tabular-nums text-ink">{(progress?.scanned ?? 0).toLocaleString("en-GB")}</span>
                  </span>
                  <span className="text-muted">
                    Matched <span className="font-semibold tabular-nums text-blue-royal">{progress?.matched ?? 0}</span>
                  </span>
                </div>
              ) : null}

              {progress?.note ? <p className="mt-2 text-xs text-[#7a5200]">{progress.note}</p> : null}

              {!building && detailLoading ? (
                <div className="flex items-center gap-2 py-4 text-sm text-muted">
                  <Loader2 size={15} className="animate-spin" /> Loading matched patients...
                </div>
              ) : null}

              {!building && detail ? (
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
                    <span>
                      <span className="text-lg font-semibold tabular-nums text-navy">{detail.matched.toLocaleString("en-GB")}</span>{" "}
                      <span className="text-muted">patients matched</span>
                    </span>
                    {detail.contactable !== null && detail.contactable < detail.matched ? (
                      <span className="text-xs text-muted">
                        <span className="font-semibold text-ink">{detail.contactable.toLocaleString("en-GB")}</span> have SMS
                        consent and will be contacted; those without are not texted
                      </span>
                    ) : null}
                    {detail.excludedMissingData > 0 ? (
                      <span className="text-xs text-muted">
                        {detail.excludedMissingData.toLocaleString("en-GB")} not included (no recorded age or gender on file)
                      </span>
                    ) : null}
                  </div>

                  <DataTable
                    columns={previewColumns}
                    rows={detail.targets}
                    getRowKey={(t) => t.id}
                    maxRows={25}
                    empty={
                      <EmptyState
                        icon={Users}
                        title="No patients matched"
                        description="No one in the base fits this segment. Loosen the filters (a wider last-visit window or fewer keywords) and build again."
                      />
                    }
                  />
                  {detail.targets.length > 0 ? (
                    <p className="text-[11px] text-muted">
                      Showing the first {Math.min(detail.previewLimit, detail.targets.length)} matched patients. Mobile numbers are
                      part-masked here for privacy.
                    </p>
                  ) : null}

                  {/* Launch / pause controls for the active campaign. */}
                  {activeCampaign ? (
                    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                      {activeCampaign.status === "running" ? (
                        <Button variant="secondary" size="sm" disabled={actionId !== null} onClick={() => act(activeCampaign, "pause")}>
                          {actionId === activeCampaign.id ? <Loader2 size={14} className="animate-spin" /> : <Pause size={14} />} Pause
                        </Button>
                      ) : activeCampaign.status === "paused" ? (
                        <Button variant="primary" size="sm" disabled={actionId !== null || !outreachEnabled} onClick={() => act(activeCampaign, "resume")}>
                          {actionId === activeCampaign.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Resume
                        </Button>
                      ) : (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={actionId !== null || activeCampaign.status !== "ready" || !outreachEnabled}
                          onClick={() => act(activeCampaign, "launch")}
                          title={!outreachEnabled ? "Segment outreach is switched off" : activeCampaign.status !== "ready" ? "Finish building the list first" : undefined}
                        >
                          {actionId === activeCampaign.id ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />} Launch campaign
                        </Button>
                      )}
                      {!outreachEnabled ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                          <AlertTriangle size={13} className="text-[#9a6700]" />
                          Switch Segment outreach on in{" "}
                          <Link href={controlsHref} className="font-semibold text-blue-royal hover:underline">
                            System controls
                          </Link>{" "}
                          to launch.
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {banner ? (
                    <p className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-xs text-[#7a5200]">{banner}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Campaign list. */}
          {loadError ? (
            <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{loadError}</p>
          ) : loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
              <Loader2 size={16} className="animate-spin" /> Loading campaigns...
            </div>
          ) : campaigns.length === 0 ? (
            <EmptyState
              icon={Send}
              title="No campaigns yet"
              description="Build your first list from the patient base, preview exactly who matches, then invite them back with a warm text."
            >
              <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
                <Plus size={15} /> New campaign
              </Button>
            </EmptyState>
          ) : (
            <ul className="space-y-3">
              {campaigns.map((c) => {
                const isActive = c.id === activeId;
                return (
                  <li
                    key={c.id}
                    className={cn(
                      "rounded-xl border bg-card px-4 py-3.5 shadow-[0_1px_2px_rgba(10,14,26,0.04)] transition-colors",
                      isActive ? "border-blue-royal/50 ring-1 ring-blue-royal/20" : "border-line",
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => openCampaign(c)}
                        className="min-w-0 flex-1 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-royal/40"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-navy">{c.name}</span>
                          <StatusPill tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</StatusPill>
                        </div>
                        <p className="mt-1 text-xs text-muted">
                          <span className="text-ink">{siteName(c.siteId)}</span>
                          <span className="px-1.5 text-line-strong">/</span>
                          <span className="text-ink">{c.messageAngle || "no angle yet"}</span>
                          {c.practitionerName ? (
                            <>
                              <span className="px-1.5 text-line-strong">/</span>
                              <span className="text-ink">with {c.practitionerName}</span>
                            </>
                          ) : null}
                          <span className="px-1.5 text-line-strong">/</span>
                          <span>cap {c.dailyCap}/day</span>
                        </p>
                      </button>
                      <div className="flex items-center gap-2">
                        {c.status === "running" ? (
                          <Button variant="secondary" size="sm" disabled={actionId !== null} onClick={() => act(c, "pause")}>
                            {actionId === c.id ? <Loader2 size={14} className="animate-spin" /> : <Pause size={14} />} Pause
                          </Button>
                        ) : c.status === "paused" ? (
                          <Button variant="primary" size="sm" disabled={actionId !== null || !outreachEnabled} onClick={() => act(c, "resume")}>
                            {actionId === c.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Resume
                          </Button>
                        ) : (
                          <Button variant="secondary" size="sm" onClick={() => openCampaign(c)}>
                            {c.status === "ready" ? "Preview & launch" : c.status === "building" || c.status === "draft" ? "Continue building" : "View"}
                          </Button>
                        )}
                      </div>
                    </div>

                    {/* Headline counts. */}
                    <div className="mt-3 grid grid-cols-4 gap-2 border-t border-line pt-3 text-center">
                      <Count label="Built" value={c.counts.built} />
                      <Count label="Contacted" value={c.counts.contacted} />
                      <Count label="Replied" value={c.counts.replied} />
                      <Count label="Booked" value={c.counts.booked} tone="success" />
                    </div>

                    {/* Two-message A/B read-back: shown only when this campaign carries a
                        second angle. Honest per-message counts (sent / replies / booked),
                        never a claim that one message is auto-chosen or "learned". */}
                    {c.messageAngleB && c.variants ? (
                      <div className="mt-2.5 space-y-1 border-t border-line pt-2.5">
                        <VariantLine label="A" angle={c.messageAngle} v={c.variants.a} />
                        <VariantLine label="B" angle={c.messageAngleB} v={c.variants.b} />
                      </div>
                    ) : null}

                    {/* Deliverability read-back: messages the guardrails stopped BEFORE any
                        paid send. One honest total - the drain does not record a per-stop
                        reason - so the tooltip names the possibilities rather than inventing
                        a split. Shown only when there is something to report. */}
                    {c.counts.blocked > 0 ? (
                      <p
                        className="mt-2.5 flex cursor-help items-center justify-center gap-1.5 text-[11px] text-muted"
                        title="Blocked before sending, so never charged. The reason is not itemised: an undeliverable number, missing consent, or a message-safety check."
                      >
                        <ShieldOff size={12} className="text-status-amber" />
                        <span className="font-semibold tabular-nums text-navy">
                          {c.counts.blocked.toLocaleString("en-GB")}
                        </span>
                        blocked before sending
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SectionCard>
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: "success" }) {
  return (
    <div>
      <p className={cn("text-base font-semibold tabular-nums", tone === "success" ? "text-success" : "text-navy")}>
        {value.toLocaleString("en-GB")}
      </p>
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
    </div>
  );
}

// One line of the two-message read-back, e.g.
// "Message A (a hygiene visit): 120 sent, 14 replies, 3 booked".
// Plain counts, so the owner can read which message is converting without any claim that
// the system picks a winner or learns from the split.
function VariantLine({ label, angle, v }: { label: string; angle: string | null; v: VariantCounts }) {
  const n = (x: number) => x.toLocaleString("en-GB");
  return (
    <p className="flex flex-wrap items-baseline gap-x-1.5 text-[11px] text-muted">
      <span className="font-semibold text-navy">Message {label}</span>
      {angle ? <span className="text-ink">({angle})</span> : null}
      <span className="tabular-nums">
        <span className="font-semibold text-navy">{n(v.sent)}</span> sent,{" "}
        <span className="font-semibold text-navy">{n(v.replied)}</span> {v.replied === 1 ? "reply" : "replies"},{" "}
        <span className="font-semibold text-success">{n(v.booked)}</span> booked
      </span>
    </p>
  );
}
