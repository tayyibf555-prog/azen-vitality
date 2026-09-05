"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, FileUp, Loader2, MessageSquare, Plus, Trash2, Upload, Wrench } from "lucide-react";
import { DeskChat } from "@/components/client/desk/desk-chat";
import { cn } from "@/lib/utils";
import { CATEGORY_LABELS, type AssetCategory } from "@/lib/equipment/types";
// THE FIRST STEP IS WRITTEN ONCE, next to the other modules' first steps, and
// printed both here and on Home's Operating system band. Two copies of "what do
// I do with this empty screen" is how a band and a page end up asking for
// different things. src/lib/systems/first-steps.ts imports nothing, so this
// costs the client bundle a handful of strings.
import { firstStepFor } from "@/lib/systems/first-steps";
// The row + site shapes live in a PLAIN module, imported by this client file and
// by the server page alike. See src/lib/equipment/view.ts for why.
import type { AssetRow, SiteOption } from "@/lib/equipment/view";
// The upload ceiling and the reading of the server's answer. In their own plain
// module because `@/lib/equipment/pdf-text` — which owns the ceiling — opens with
// `import "server-only"` and cannot be reached from a browser bundle, and because
// a decision inside an event handler is untestable in this suite. See that file.
import { MAX_PDF_SIZE_LABEL, oversizeRefusal, readManualUploadReply } from "./upload-limits";

// ===========================================================================
// THE EQUIPMENT MODULE'S WORKSPACE: three tabs over one register.
//
//   Ask       the agent, which answers only about what is on the register
//   Register  the list, an add/edit form, and the CSV import
//   Manuals   which assets have a readable manual, and uploading one
//
// EVERYTHING IT SHOWS ARRIVES AS PROPS from the server view — plain arrays of
// plain objects, no functions across the boundary. It re-reads by calling
// `router.refresh()` after a write rather than holding a second copy of the
// register in state, so what is on screen is what is in the database and there is
// no cache here to go stale.
// ===========================================================================

type TabKey = "ask" | "register" | "manuals";

const EMPTY_FORM = {
  id: "",
  name: "",
  category: "other" as AssetCategory,
  make: "",
  model: "",
  serial: "",
  siteId: "",
  room: "",
  supplier: "",
  supplierPhone: "",
  purchasedOn: "",
  lastServicedOn: "",
  nextServiceDue: "",
  notes: "",
};

type FormState = typeof EMPTY_FORM;

interface ImportPlan {
  headers: { raw: string; field: string | null }[];
  rows: { line: number; name: string; category: string; warnings: string[] }[];
  skipped: { line: number; reason: string }[];
  unmappedHeaders: string[];
  missingNameColumn: boolean;
}

export function EquipmentWorkspace({
  clientSlug,
  assets,
  sites,
  systemEnabled,
  registerUnreadable,
  registerMore = false,
  registerCap,
  manualsUnreadable = false,
  initialTab,
}: {
  clientSlug: string;
  assets: AssetRow[];
  sites: SiteOption[];
  systemEnabled: boolean;
  /** True when the register could not be READ — a different fact from "empty". */
  registerUnreadable: boolean;
  /**
   * True when the server's register read came back AT its bound, so this page
   * holds a floor rather than the register.
   *
   * Stated by the caller, never inferred here: the bound belongs to the
   * `server-only` repository and this is a browser bundle. It defaults to false
   * so a caller that cannot prove a cut never claims one.
   */
  registerMore?: boolean;
  /** The bound itself, so the sentence can name the figure the page was cut at. */
  registerCap?: number;
  /**
   * True when the MANUALS read failed. Different from "no manuals": the first is
   * "we could not look", and this whole page renders `manual: null` either way.
   */
  manualsUnreadable?: boolean;
  /**
   * Which tab opens. Defaults to the register while there is nothing on it (its
   * empty state carries the first step) and to the desk otherwise.
   *
   * It is a prop rather than only internal state so a tab can be RENDERED on its
   * own — the same reason MiningPanel is exported over in the pre-visit module.
   * Only one tab is in the markup at a time, so a claim about the register table
   * or the manuals list is otherwise unassertable: the truncation sentence under
   * both of them could be deleted without a single test going red.
   */
  initialTab?: TabKey;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>(initialTab ?? (assets.length === 0 ? "register" : "ask"));
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [csv, setCsv] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const uploadRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const post = async (action: string, body: Record<string, unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/equipment/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: clientSlug, ...body }),
      });
      const data = ((await response.json()) ?? {}) as Record<string, unknown>;
      return data;
    } catch {
      return { ok: false, error: "We could not reach the server. Please try again." };
    } finally {
      setBusy(false);
    }
  };

  const saveAsset = async () => {
    if (!form.name.trim()) {
      setMessage("An item name is required.");
      return;
    }
    const data = await post("save", { ...form, id: form.id || undefined });
    if (data.ok) {
      setMessage(form.id ? "Saved." : "Added to the register.");
      setForm(EMPTY_FORM);
      setFormOpen(false);
      router.refresh();
    } else {
      setMessage(String(data.error ?? "We could not save that."));
    }
  };

  const removeAsset = async (id: string, name: string) => {
    if (!window.confirm(`Remove "${name}" from the register? Its manual is removed with it.`)) return;
    const data = await post("delete", { id });
    if (data.ok) {
      setMessage("Removed.");
      router.refresh();
    } else {
      setMessage(String(data.error ?? "We could not remove that."));
    }
  };

  const previewImport = async () => {
    const data = await post("import-preview", { csv });
    if (data.ok) {
      setPlan(data.plan as ImportPlan);
      setMessage(null);
    } else {
      setPlan(null);
      setMessage(String(data.error ?? "We could not read that file."));
    }
  };

  const runImport = async () => {
    const data = await post("import", { csv });
    if (data.ok) {
      setMessage(
        `Imported: ${data.inserted} added, ${data.updated} updated${Number(data.skipped) > 0 ? `, ${data.skipped} row(s) skipped` : ""}.`,
      );
      setCsv("");
      setPlan(null);
      router.refresh();
    } else {
      setMessage(String(data.error ?? "We could not import that file."));
    }
  };

  const uploadManual = async (assetId: string, file: File) => {
    // REFUSED HERE, BEFORE THE WIRE (ruling W3/13). Above 4.5 MB Vercel rejects
    // the request body at the edge — before the route, before its guards, before
    // its own 413 — with a non-JSON body, so nothing the application can write
    // ever reaches the screen. Refusing at 4 MB in the browser is what makes the
    // advertised ceiling true; the route's check stays the authoritative one.
    const tooLarge = oversizeRefusal(file.size);
    if (tooLarge) {
      setMessage(tooLarge);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const body = new FormData();
      body.append("client", clientSlug);
      body.append("assetId", assetId);
      body.append("file", file);
      const response = await fetch("/api/equipment/manual", { method: "POST", body });
      // NOT `response.json()` unconditionally. A 413 from the edge and a 502 from
      // a gateway are HTML; parsing one threw into the catch below and told the
      // practice to "try again" for a file that can never work. See upload-limits.
      const outcome = await readManualUploadReply(response);
      setMessage(outcome.message);
      if (outcome.ok) router.refresh();
    } catch {
      setMessage("We could not upload that manual. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const removeManual = async (assetId: string) => {
    setBusy(true);
    try {
      const response = await fetch("/api/equipment/manual", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: clientSlug, assetId }),
      });
      const data = ((await response.json()) ?? {}) as Record<string, unknown>;
      setMessage(data.ok ? "Manual removed." : String(data.error ?? "We could not remove that."));
      if (data.ok) router.refresh();
    } catch {
      setMessage("We could not remove that manual.");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (asset: AssetRow) => {
    setForm({
      id: asset.id,
      name: asset.name,
      category: asset.category,
      make: asset.make ?? "",
      model: asset.model ?? "",
      serial: asset.serial ?? "",
      siteId: asset.siteId ?? "",
      room: asset.room ?? "",
      supplier: asset.supplier ?? "",
      supplierPhone: asset.supplierPhone ?? "",
      purchasedOn: asset.purchasedOn ?? "",
      lastServicedOn: asset.lastServicedOn ?? "",
      nextServiceDue: asset.nextServiceDue ?? "",
      notes: asset.notes ?? "",
    });
    setFormOpen(true);
    setTab("register");
  };

  const field = (key: keyof FormState, label: string, type = "text") => (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-faint">{label}</span>
      <input
        type={type}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="rounded-[8px] border border-line px-2.5 py-1.5 text-[13px] text-navy outline-none focus:border-line-strong"
      />
    </label>
  );

  // A BADGE IS A COUNT, AND A COUNT OFF A CUT READ WEARS ITS SIGN. "Register
  // (400)" reads as "there are four hundred things on the register"; "(400+)"
  // does not, and the sentence under the table says the rest.
  const TABS: { key: TabKey; label: string; icon: typeof Wrench }[] = [
    { key: "ask", label: "Ask the desk", icon: MessageSquare },
    { key: "register", label: `Register (${assets.length}${registerMore ? "+" : ""})`, icon: Wrench },
    { key: "manuals", label: "Manuals", icon: BookOpen },
  ];

  /**
   * The sentence a cut register carries, printed under BOTH lists it cuts.
   *
   * The Manuals tab iterates the same bounded array, so an asset past the bound
   * cannot be given a manual at all — which is worse than the count, and is why
   * this is said twice rather than once under the register table.
   */
  const cutSentence = `This page holds ${assets.length.toLocaleString("en-GB")} items, which is as many as it reads in one go${
    registerCap && registerCap !== assets.length ? ` (${registerCap.toLocaleString("en-GB")})` : ""
  }. There are more on the register than this — the count on the tab is a floor, not a total, and the items past the cut are not on this page or on the Manuals tab.`;

  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="Equipment sections" className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line-strong bg-card p-[3px]">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "pressable inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 text-[12.5px] font-medium transition-colors",
              tab === key ? "bg-navy font-semibold text-white" : "text-muted hover:text-navy",
            )}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      {message ? (
        <p className="rounded-[8px] border border-line bg-tile px-3 py-2 text-[12.5px] text-navy">{message}</p>
      ) : null}
      {registerUnreadable ? (
        <p className="rounded-[8px] border border-line bg-tile px-3 py-2 text-[12.5px] text-navy">
          The register could not be read just now, so this page is showing nothing rather than showing an empty
          register. Nothing has been lost — try again in a moment.
        </p>
      ) : null}
      {/* THE SAME COURTESY FOR THE MANUALS, and for the same reason: without it
          every machine on both tabs reads "No manual uploaded" and somebody
          re-uploads a document the platform already holds — or rings the
          engineer because we told them the practice has no manual for it. */}
      {manualsUnreadable ? (
        <p className="rounded-[8px] border border-line bg-tile px-3 py-2 text-[12.5px] text-navy">
          Whether each machine has a manual could not be read just now, so this page cannot say which do. Nothing
          has been lost, and no manual has been removed — try again in a moment.
        </p>
      ) : null}

      {tab === "ask" ? (
        <DeskChat
          endpoint="/api/equipment/ask"
          clientSlug={clientSlug}
          emptyHeading="What has stopped working?"
          emptyBody="I answer questions about the equipment on your register, using the manuals you have uploaded against them — what a machine is, where it is, when it is next due a service, and what the manual says about a fault. I never advise on defeating a safety interlock, on electrical work, or on running a machine past its service date, and when the manual's troubleshooting runs out I will tell you to call the engineer."
          placeholder="Name the machine and what it is doing"
          starters={[
            "Which equipment is due a service in the next 90 days?",
            "What does the autoclave's manual say to check when a cycle fails?",
            "What equipment do we have in the decontamination room?",
          ]}
          disabledNote={
            systemEnabled
              ? undefined
              : "The equipment desk is switched off. The practice owner can switch it on in System controls; the register and the manuals stay editable either way."
          }
        />
      ) : null}

      {tab === "register" ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setForm(EMPTY_FORM);
                setFormOpen((v) => !v);
              }}
              className="pressable inline-flex items-center gap-1.5 rounded-[8px] bg-navy px-3 py-1.5 text-[12.5px] font-medium text-white"
            >
              <Plus size={14} />
              Add equipment
            </button>
          </div>

          {formOpen ? (
            <div className="rounded-[10px] border border-line p-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {field("name", "Item name")}
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-faint">Category</span>
                  <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value as AssetCategory })}
                    className="rounded-[8px] border border-line px-2.5 py-1.5 text-[13px] text-navy outline-none focus:border-line-strong"
                  >
                    {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-faint">Site</span>
                  <select
                    value={form.siteId}
                    onChange={(e) => setForm({ ...form, siteId: e.target.value })}
                    className="rounded-[8px] border border-line px-2.5 py-1.5 text-[13px] text-navy outline-none focus:border-line-strong"
                  >
                    <option value="">Not stated</option>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                {field("make", "Make")}
                {field("model", "Model")}
                {field("serial", "Serial number")}
                {field("room", "Room")}
                {field("supplier", "Supplier / service company")}
                {field("supplierPhone", "Supplier phone")}
                {field("purchasedOn", "Purchased", "date")}
                {field("lastServicedOn", "Last serviced", "date")}
                {field("nextServiceDue", "Next service due", "date")}
              </div>
              <label className="mt-3 flex flex-col gap-1">
                <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-faint">Notes</span>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={2}
                  className="rounded-[8px] border border-line px-2.5 py-1.5 text-[13px] text-navy outline-none focus:border-line-strong"
                />
              </label>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => void saveAsset()}
                  disabled={busy}
                  className="pressable inline-flex items-center gap-1.5 rounded-[8px] bg-navy px-3 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-40"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : null}
                  {form.id ? "Save changes" : "Add to register"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFormOpen(false);
                    setForm(EMPTY_FORM);
                  }}
                  className="pressable rounded-[8px] border border-line px-3 py-1.5 text-[12.5px] font-medium text-muted"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {assets.length === 0 ? (
            <p className="mx-auto max-w-xl rounded-[10px] border border-dashed border-line-strong px-4 py-8 text-center text-[13px] leading-relaxed text-muted">
              <span className="block font-semibold text-navy">Nothing on the register yet</span>
              <span className="mt-1 block">{firstStepFor("equipment")?.step}</span>
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left">
                    {["Item", "Category", "Where", "Serial", "Supplier", "Next service", "Manual", ""].map((h) => (
                      <th key={h} className="px-3 py-2 text-[11px] font-medium uppercase tracking-[0.04em] text-faint">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {assets.map((a) => (
                    <tr key={a.id} className="border-b border-line last:border-0">
                      <td className="px-3 py-2">
                        <button type="button" onClick={() => startEdit(a)} className="text-left font-medium text-navy hover:underline">
                          {a.name}
                        </button>
                        {a.make || a.model ? (
                          <span className="block text-[12px] text-muted">{[a.make, a.model].filter(Boolean).join(" ")}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-muted">{CATEGORY_LABELS[a.category]}</td>
                      <td className="px-3 py-2 text-muted">{[a.siteName, a.room].filter(Boolean).join(" · ") || "—"}</td>
                      <td className="px-3 py-2 text-muted">{a.serial ?? "—"}</td>
                      <td className="px-3 py-2 text-muted">
                        {a.supplier ?? "—"}
                        {a.supplierPhone ? <span className="block text-[12px]">{a.supplierPhone}</span> : null}
                      </td>
                      <td className="px-3 py-2 text-muted">{a.nextServiceDue ?? "not recorded"}</td>
                      <td className="px-3 py-2 text-muted">
                        {manualsUnreadable
                          ? "not read"
                          : a.manual
                            ? a.manual.status === "ready"
                              ? `${a.manual.pageCount} pages`
                              : "scan — unreadable"
                            : "none"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => void removeAsset(a.id, a.name)}
                          disabled={busy}
                          aria-label={`Remove ${a.name}`}
                          className="pressable rounded-md p-1 text-muted hover:text-navy disabled:opacity-40"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {registerMore ? (
                <p className="mt-2 text-[12px] leading-relaxed text-status-amber">{cutSentence}</p>
              ) : null}
            </div>
          )}

          <div className="rounded-[10px] border border-line p-4">
            <h3 className="text-title text-navy">Import your existing register</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
              Paste the contents of your equipment spreadsheet, saved as CSV. Column names do not have to match ours —
              Item, Equipment, Serial No, Asset Tag, Location, Service Due and the rest are all understood. Dates are
              read UK-first, so 03/04/2026 is 3 April; anything we cannot read is left blank and listed rather than
              guessed. A row whose serial number is already on the register updates that item instead of duplicating it.
            </p>
            <textarea
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setPlan(null);
              }}
              rows={5}
              placeholder="Item,Category,Make,Serial No,Location,Service Due&#10;Autoclave 1,Steriliser,W&amp;H,A1400273,Decon room,02/03/2027"
              className="mt-3 w-full rounded-[8px] border border-line px-2.5 py-2 font-mono text-[12px] text-navy outline-none focus:border-line-strong"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void previewImport()}
                disabled={busy || csv.trim().length === 0}
                className="pressable inline-flex items-center gap-1.5 rounded-[8px] border border-line px-3 py-1.5 text-[12.5px] font-medium text-navy disabled:opacity-40"
              >
                <FileUp size={14} />
                Check the file
              </button>
              {plan && !plan.missingNameColumn && plan.rows.length > 0 ? (
                <button
                  type="button"
                  onClick={() => void runImport()}
                  disabled={busy}
                  className="pressable inline-flex items-center gap-1.5 rounded-[8px] bg-navy px-3 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-40"
                >
                  Import {plan.rows.length} row{plan.rows.length === 1 ? "" : "s"}
                </button>
              ) : null}
            </div>

            {plan ? (
              <div className="mt-3 space-y-2 text-[12.5px] text-muted">
                {plan.missingNameColumn ? (
                  <p className="text-navy">
                    We could not find a column with the item name in it. Add one called Item, Equipment or Description.
                  </p>
                ) : (
                  <p>
                    Understood {plan.headers.filter((h) => h.field).length} column
                    {plan.headers.filter((h) => h.field).length === 1 ? "" : "s"}; {plan.rows.length} row
                    {plan.rows.length === 1 ? "" : "s"} ready.
                  </p>
                )}
                {plan.unmappedHeaders.length > 0 ? (
                  <p>Ignored columns: {plan.unmappedHeaders.join(", ")}.</p>
                ) : null}
                {plan.skipped.map((s) => (
                  <p key={`skip-${s.line}`}>Row {s.line} skipped: {s.reason}.</p>
                ))}
                {plan.rows
                  .filter((r) => r.warnings.length > 0)
                  .slice(0, 20)
                  .map((r) => (
                    <p key={`warn-${r.line}`}>
                      Row {r.line} ({r.name}): {r.warnings.join("; ")}.
                    </p>
                  ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === "manuals" ? (
        <div className="space-y-3">
          <p className="text-[12.5px] leading-relaxed text-muted">
            Upload the manufacturer&rsquo;s PDF for each machine. We read the text out of it and store it as searchable
            passages so the desk can answer from the manual and cite the page. The PDF itself is not kept. A scanned
            manual — pictures of pages rather than text — cannot be read, and we will tell you if that is what arrived.
          </p>
          {/* THE SIZE RULE, ON SCREEN, BEFORE THE UPLOAD (ruling W3/13). It used
              to exist only in the server's refusal — a sentence the practice
              reached by picking a file, waiting for it to upload, and being turned
              away. A ceiling nobody is told about is not advertised, and the
              mirror of it is the HR document vault's "PDF or a photograph, up to
              10 MB" (src/components/hr/staff-documents-panel.tsx). The figure is
              interpolated from the module's own constant, never typed out, so it
              cannot drift from what is enforced. */}
          <p className="text-[12.5px] leading-relaxed text-muted">
            One PDF per machine, {MAX_PDF_SIZE_LABEL} or smaller. A bigger manual is refused before it is sent — upload
            just the operating and troubleshooting sections, which is what the desk answers from anyway.
          </p>
          {assets.length === 0 ? (
            <p className="rounded-[10px] border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-muted">
              Add equipment to the register first, then upload each machine&rsquo;s manual here.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-[10px] border border-line">
              {assets.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-navy">{a.name}</p>
                    <p className="text-[12px] text-muted">
                      {manualsUnreadable
                        ? "Whether this machine has a manual could not be read just now"
                        : a.manual
                          ? a.manual.status === "ready"
                            ? `${a.manual.filename} · ${a.manual.pageCount} pages, searchable`
                            : `${a.manual.filename} · a scan, so there is no text to read`
                          : "No manual uploaded"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <input
                      ref={(el) => {
                        uploadRefs.current[a.id] = el;
                      }}
                      type="file"
                      accept="application/pdf"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void uploadManual(a.id, file);
                        e.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => uploadRefs.current[a.id]?.click()}
                      disabled={busy}
                      className="pressable inline-flex items-center gap-1.5 rounded-[8px] border border-line px-3 py-1.5 text-[12.5px] font-medium text-navy disabled:opacity-40"
                    >
                      <Upload size={14} />
                      {/* NEUTRAL WHILE THE READ IS UNKNOWN. `a.manual` is null
                          for every machine when the manuals could not be read,
                          so a plain "Upload" would invite somebody to overwrite
                          a manual this screen has wrongly implied is absent —
                          and the upload REPLACES (delete then insert). */}
                      {manualsUnreadable ? "Upload or replace" : a.manual ? "Replace" : "Upload"}
                    </button>
                    {a.manual ? (
                      <button
                        type="button"
                        onClick={() => void removeManual(a.id)}
                        disabled={busy}
                        aria-label={`Remove the manual for ${a.name}`}
                        className="pressable rounded-md p-1 text-muted hover:text-navy disabled:opacity-40"
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {assets.length > 0 && registerMore ? (
            <p className="text-[12px] leading-relaxed text-status-amber">{cutSentence}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
