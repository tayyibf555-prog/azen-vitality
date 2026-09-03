/**
 * The register's VIEW MODEL — the shape the page hands the workspace.
 *
 * A plain module, imported by BOTH the server view and the "use client"
 * workspace, which is the lesson `rsc-value-import.test.ts` pins: under React
 * Server Components every export of a client module becomes a client-reference
 * proxy on the server side, so a shared value defined in the client file and
 * imported by the page is a render-time crash that tsc, vitest and the
 * production build all report as green. Shared things live here instead.
 *
 * It is a view model rather than the domain type on purpose: it carries the
 * site's NAME (the page resolves it once) and the manual's summary, so the
 * workspace renders a row without a second lookup and without a function
 * crossing the boundary.
 */

import type { AssetCategory } from "./types";

export interface AssetRow {
  id: string;
  name: string;
  category: AssetCategory;
  make: string | null;
  model: string | null;
  serial: string | null;
  siteId: string | null;
  siteName: string | null;
  room: string | null;
  supplier: string | null;
  supplierPhone: string | null;
  purchasedOn: string | null;
  lastServicedOn: string | null;
  nextServiceDue: string | null;
  notes: string | null;
  manual: { filename: string; pageCount: number; status: "ready" | "no_text" } | null;
}

export interface SiteOption {
  id: string;
  name: string;
}
