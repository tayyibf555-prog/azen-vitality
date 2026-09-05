import { Info } from "lucide-react";
import { PageHeader } from "@/components/primitives";
import { getClient, getSites } from "@/lib/mock/clients";
import { ASSET_ROW_CAP, listAssets, listManuals } from "@/lib/equipment/repository";
import { isSystemEnabled } from "@/lib/systems/repository";
import { EQUIPMENT_SLUG } from "@/lib/equipment/types";
import type { AssetRow } from "@/lib/equipment/view";
import { EquipmentWorkspace } from "./equipment-workspace";

/**
 * The equipment module, in BOTH trees (/c/[client]/equipment and the owner
 * tree's [module] if-chain), so anything added here has to hold on both.
 *
 * A SERVER COMPONENT WRAPPING A CLIENT ONE. The reads happen here, on the server,
 * with the service-role client; the boundary starts at EquipmentWorkspace and
 * only plain arrays of plain objects cross it. The row shape itself lives in
 * src/lib/equipment/view.ts rather than in the client file — see that file for
 * why (the RSC value-import trap).
 *
 * THE THREE STATES OF THE REGISTER ARE KEPT APART, because they need three
 * different things said:
 *   unreadable  the read failed. Say so. Never show an empty table for this.
 *   empty       nothing added yet. Open on the Register tab and invite an import.
 *   loaded      the register.
 *
 * AND SO ARE THE MANUALS' (wave-3 review, 4 September 2026). `listManuals`
 * returns null on a failed read and [] when there are none, for the reason its
 * own header gives — telling a practice their register is empty when it is not
 * is how they conclude the platform lost it — and this file used to collapse the
 * two with `?? []`. Every machine then read "No manual uploaded", the register's
 * Manual column read "none", and a nurse was invited to re-upload a manual that
 * is stored, indexed and searchable. The asset half of this same component has
 * said so honestly since day one; the manual half now does too.
 *
 * THE REGISTER READ IS BOUNDED, AND THE SCREEN SAYS SO WHEN THE BOUND BITES.
 * `listAssets` stops at ASSET_ROW_CAP and hands back a bare array. Three of its
 * four consumers already turn that into "at least N" — the system prompt, the
 * tool results and Home's Operating system band — and the fourth is the only one
 * a person reads. A CSV import takes up to 500 rows in one go, so a practice's
 * FIRST upload can put it past the cap; without this the tab said "Register
 * (400)" over a silently cut table, and the equipment desk's own capped-register
 * note tells the reader to go and check that tab (charter §0/5, ruling W3/11).
 */
export async function EquipmentView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Equipment" description="This client could not be found." />;
  }

  const [assets, manuals, systemEnabled] = await Promise.all([
    listAssets(client.id),
    listManuals(client.id),
    isSystemEnabled(client.id, EQUIPMENT_SLUG),
  ]);

  const siteNames = new Map(getSites(client.id).map((s) => [s.id, s.name]));
  // `?? []` STILL, because a row has to render either way — but the fact that it
  // was a failed read travels beside it now (`manualsUnreadable`) instead of
  // being thrown away here.
  const manualByAsset = new Map((manuals ?? []).map((m) => [m.assetId, m]));

  // AT the bound is the same heuristic the other three consumers use
  // (os-band.ts:310, prompt.ts:58, tools.ts:133) and deliberately so: a register
  // of exactly ASSET_ROW_CAP items reads as truncated on all four surfaces
  // rather than three of them disagreeing with the fourth. The cost is one
  // over-cautious "400+" for the practice that owns exactly four hundred things.
  const registerMore = assets !== null && assets.length >= ASSET_ROW_CAP;

  const rows: AssetRow[] = (assets ?? []).map((a) => {
    const manual = manualByAsset.get(a.id);
    return {
      id: a.id,
      name: a.name,
      category: a.category,
      make: a.make,
      model: a.model,
      serial: a.serial,
      siteId: a.siteId,
      siteName: a.siteId ? siteNames.get(a.siteId) ?? null : null,
      room: a.room,
      supplier: a.supplier,
      supplierPhone: a.supplierPhone,
      purchasedOn: a.purchasedOn,
      lastServicedOn: a.lastServicedOn,
      nextServiceDue: a.nextServiceDue,
      notes: a.notes,
      manual: manual
        ? { filename: manual.filename, pageCount: manual.pageCount, status: manual.status }
        : null,
    };
  });

  return (
    <>
      <PageHeader
        title="Equipment"
        description="Your equipment register and the desk that answers from it: what you own, where it is, when it is next due a service, and what each machine's manual says about a fault."
      />

      <div className="flex items-start gap-2.5 rounded-[10px] border border-line bg-card-muted/50 px-4 py-3">
        <Info size={16} className="mt-0.5 shrink-0 text-muted" />
        <p className="text-xs leading-relaxed text-muted">
          The desk answers only about equipment on this register, using the manuals you upload against it. It will not
          help with anything that defeats a safety interlock or guard, with the mains supply or the inside of a machine,
          or with running equipment past its service or inspection date — those go to the manufacturer&rsquo;s engineer,
          and it will say so. It is a reference and an organiser, not a substitute for the manufacturer&rsquo;s
          instructions, your service contract or a qualified engineer.
        </p>
      </div>

      <EquipmentWorkspace
        clientSlug={clientSlug}
        assets={rows}
        sites={getSites(client.id).map((s) => ({ id: s.id, name: s.name }))}
        systemEnabled={systemEnabled}
        registerUnreadable={assets === null}
        registerMore={registerMore}
        registerCap={ASSET_ROW_CAP}
        manualsUnreadable={manuals === null}
      />
    </>
  );
}
