// ===========================================================================
// THE REGISTER SCREEN IS THE FOURTH CONSUMER OF A BOUNDED READ, AND IT WAS THE
// ONLY ONE THAT LIED.
//
// This is the test src/lib/equipment/repository.ts and src/lib/equipment/types.ts
// have both cited by name since wave 1 and which did not exist. It holds two
// things.
//
// 1. THE TWO COPIES OF THE BOUND ARE EQUAL. `ASSET_ROW_CAP` (the `server-only`
//    repository, which owns the read) and `REGISTER_READ_CAP` (the pure module
//    the prompt and the tool results read, because neither may import a
//    server-only file) are the same number, proven by reading the repository's
//    SOURCE — the equipment route's test mocks the repository wholesale, so an
//    import would resolve to undefined and every honesty sentence downstream
//    would evaporate with nothing going red.
//
// 2. THE SCREEN AT THE BOUND SAYS SO. `listAssets` stops at the cap and hands
//    back a bare array. The system prompt says "at least N assets", the tool
//    results replace `total` with `atLeast`, Home's band says "at least N
//    registered" — and the Register tab printed "Register (400)" over a table
//    silently cut at four hundred, with the desk's own capped-register note
//    telling the reader to go and check that very tab. A CSV import takes 500
//    rows in one go, so the practice's FIRST upload can reach it.
//    (Charter §0/5, ruling W3/11.)
//
// The Manuals tab carries the same sentence, because it iterates the same cut
// array: an asset past the bound cannot be given a manual at all, which is worse
// than a wrong count.
// ===========================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The workspace refreshes the route after a write. Nothing here writes.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/c/vitality",
  useSearchParams: () => new URLSearchParams(),
}));

// THE SERVER VIEW IS DRIVEN TOO, and its repository is mocked because it is
// `server-only`. `ASSET_ROW_CAP` is re-exported by the mock rather than dropped:
// equipment-view.tsx imports it to decide whether the read came back AT the
// bound, and a mock without it would resolve to `undefined`, make the comparison
// false for every register, and take the sentence off the screen with nothing
// going red. The mock's copy is pinned against the repository's source below.
const MOCK_CAP = 400;
const state = vi.hoisted(() => ({
  cap: 400,
  assets: [] as { id: string; name: string; category: string; siteId: string | null }[] | null,
  manuals: [] as { assetId: string; filename: string; pageCount: number; status: string }[] | null,
}));

vi.mock("@/lib/equipment/repository", () => ({
  ASSET_ROW_CAP: state.cap,
  listAssets: async () =>
    state.assets === null
      ? null
      : state.assets.map((a) => ({
          ...a,
          clientId: "vitality",
          make: null,
          model: null,
          serial: null,
          room: null,
          supplier: null,
          supplierPhone: null,
          purchasedOn: null,
          lastServicedOn: null,
          nextServiceDue: null,
          notes: null,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        })),
  listManuals: async () => state.manuals,
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => true }));

import { REGISTER_READ_CAP } from "@/lib/equipment/types";
import type { AssetRow } from "@/lib/equipment/view";
import { EquipmentWorkspace } from "./equipment-workspace";
import { EquipmentView } from "./equipment-view";

const REPO = "src/lib/equipment/repository.ts";

function asset(i: number, over: Partial<AssetRow> = {}): AssetRow {
  return {
    id: `a${i}`,
    name: `Autoclave ${i}`,
    category: "sterilisation",
    make: null,
    model: null,
    serial: null,
    siteId: null,
    siteName: null,
    room: null,
    supplier: null,
    supplierPhone: null,
    purchasedOn: null,
    lastServicedOn: null,
    nextServiceDue: null,
    notes: null,
    manual: null,
    ...over,
  };
}

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(EquipmentWorkspace, {
      clientSlug: "vitality",
      assets: [],
      sites: [],
      systemEnabled: true,
      registerUnreadable: false,
      ...props,
    }),
  );
}

describe("the two copies of the register bound cannot drift", () => {
  it("REGISTER_READ_CAP equals the repository's own ASSET_ROW_CAP", () => {
    const source = readFileSync(join(process.cwd(), REPO), "utf8");
    const declared = source.match(/export const ASSET_ROW_CAP\s*=\s*([\d_]+)/);
    expect(declared, "the ASSET_ROW_CAP scan went stale").toBeTruthy();
    expect(REGISTER_READ_CAP, "the pure copy of the bound drifted from the repository's").toBe(
      Number(declared![1].replace(/_/g, "")),
    );
  });

  it("the read is actually limited to it", () => {
    const source = readFileSync(join(process.cwd(), REPO), "utf8");
    expect(source).toContain(".limit(ASSET_ROW_CAP)");
  });
});

describe("a register at its bound wears its sign", () => {
  const atBound = Array.from({ length: REGISTER_READ_CAP }, (_, i) => asset(i));

  it("counts the tab as a floor, not a total", () => {
    const html = render({ assets: atBound, registerMore: true, registerCap: REGISTER_READ_CAP });
    expect(html).toContain(`Register (${REGISTER_READ_CAP}+)`);
    expect(html).not.toContain(`Register (${REGISTER_READ_CAP})`);
  });

  it("says under the register table that the list is cut", () => {
    const html = render({
      assets: atBound,
      registerMore: true,
      registerCap: REGISTER_READ_CAP,
      initialTab: "register",
    });
    expect(html).toContain("There are more on the register than this");
    expect(html).toContain("the count on the tab is a floor, not a total");
    // After the names, where a reader working down the list arrives.
    expect(html.indexOf("There are more on the register")).toBeGreaterThan(html.indexOf("Autoclave 0"));
  });

  it("says it again on the Manuals tab, which is cut by the same read", () => {
    const html = render({
      assets: atBound,
      registerMore: true,
      registerCap: REGISTER_READ_CAP,
      initialTab: "manuals",
    });
    expect(html).toContain("the items past the cut are not on this page or on the Manuals tab");
  });

  it("says none of it when the register is whole", () => {
    // THE OTHER DIRECTION. A page that always warned would be as useless as one
    // that never did.
    const html = render({
      assets: [asset(1)],
      registerMore: false,
      registerCap: REGISTER_READ_CAP,
      initialTab: "register",
    });
    expect(html).toContain("Register (1)");
    expect(html).not.toContain("1+");
    expect(html).not.toContain("There are more on the register than this");
  });

  it("defaults to silent, so a caller that cannot prove a cut never claims one", () => {
    const html = render({ assets: atBound, initialTab: "register" });
    expect(html).toContain(`Register (${REGISTER_READ_CAP})`);
    expect(html).not.toContain("There are more on the register than this");
  });
});

describe("an unreadable manuals index is not a register with no manuals", () => {
  const withManual = [
    asset(1, { manual: { filename: "autoclave.pdf", pageCount: 42, status: "ready" } }),
  ];

  it("says the manuals could not be read rather than that there are none", () => {
    const html = render({ assets: [asset(1)], manualsUnreadable: true, initialTab: "manuals" });
    expect(html).toContain("Whether each machine has a manual could not be read just now");
    expect(html).toContain("no manual has been removed");
    expect(html).not.toContain("No manual uploaded");
  });

  it("does not print 'none' in the register's Manual column for it", () => {
    const html = render({ assets: [asset(1)], manualsUnreadable: true, initialTab: "register" });
    expect(html).toContain("not read");
    expect(html).not.toContain(">none<");
  });

  it("labels the button neutrally, because it REPLACES what it cannot see", () => {
    // The upload deletes the stored manual and inserts the new one. A button
    // that says "Upload" over a machine whose manual we simply could not read
    // invites somebody to overwrite a document the platform holds.
    const html = render({ assets: [asset(1)], manualsUnreadable: true, initialTab: "manuals" });
    expect(html).toContain("Upload or replace");
  });

  it("still says 'No manual uploaded' when the read SUCCEEDED and found none", () => {
    const html = render({ assets: [asset(1)], initialTab: "manuals" });
    expect(html).toContain("No manual uploaded");
    expect(html).not.toContain("could not be read just now");
  });

  it("still names a manual it can see", () => {
    const html = render({ assets: withManual, initialTab: "manuals" });
    expect(html).toContain("autoclave.pdf");
    expect(html).toContain("42 pages, searchable");
  });
});

describe("the page is what decides both facts, and it hands them down", () => {
  // WITHOUT THIS, the workspace could keep its sentences and the page could stop
  // computing them: every assertion above would stay green over a screen that
  // never says a word.
  async function page(): Promise<string> {
    return renderToStaticMarkup(await EquipmentView({ clientSlug: "vitality" }));
  }

  it("the mock's bound has not drifted from the repository's", () => {
    const source = readFileSync(join(process.cwd(), REPO), "utf8");
    const declared = source.match(/export const ASSET_ROW_CAP\s*=\s*([\d_]+)/);
    expect(state.cap, "the mock's bound drifted from the repository's").toBe(Number(declared![1].replace(/_/g, "")));
    expect(MOCK_CAP).toBe(state.cap);
  });

  it("marks the register as cut when the read came back AT the bound", async () => {
    state.assets = Array.from({ length: MOCK_CAP }, (_, i) => ({
      id: `a${i}`,
      name: `Autoclave ${i}`,
      category: "sterilisation",
      siteId: null,
    }));
    state.manuals = [];
    expect(await page()).toContain(`Register (${MOCK_CAP}+)`);
  });

  it("marks it whole one row below the bound", async () => {
    state.assets = Array.from({ length: MOCK_CAP - 1 }, (_, i) => ({
      id: `a${i}`,
      name: `Autoclave ${i}`,
      category: "sterilisation",
      siteId: null,
    }));
    state.manuals = [];
    const html = await page();
    expect(html).toContain(`Register (${MOCK_CAP - 1})`);
    expect(html).not.toContain(`${MOCK_CAP - 1}+`);
  });

  it("passes a FAILED manuals read down as a failed read", async () => {
    state.assets = [{ id: "a1", name: "Autoclave 1", category: "sterilisation", siteId: null }];
    state.manuals = null;
    const html = await page();
    expect(html).toContain("Whether each machine has a manual could not be read just now");
  });

  it("says nothing of the sort when the manuals read simply found none", async () => {
    state.assets = [{ id: "a1", name: "Autoclave 1", category: "sterilisation", siteId: null }];
    state.manuals = [];
    expect(await page()).not.toContain("Whether each machine has a manual could not be read");
  });
});
