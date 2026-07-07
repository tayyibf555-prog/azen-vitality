// The dashboard's site-scope resolver: default view is the flagship N15
// (`site-cc`); the cookie can pin another single site or "All sites"; a stale or
// foreign cookie value falls back to the default. Cookies + the site list are
// mocked so this is pure.
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({ cookie: undefined as string | undefined }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (_n: string) => (store.cookie === undefined ? undefined : { value: store.cookie }) }),
}));
vi.mock("@/lib/mock/clients", () => ({
  getSites: (clientId: string) =>
    clientId === "vitality"
      ? [{ id: "site-cc" }, { id: "site-rv" }, { id: "site-ng" }]
      : [{ id: "other-1" }, { id: "other-2" }],
}));

import { getViewSiteIds, getViewSiteSelection, ALL_SITES, DEFAULT_VIEW_SITE } from "./site-view";

beforeEach(() => {
  store.cookie = undefined;
});

describe("site-view default scope", () => {
  it("defaults to N15 (site-cc) when no cookie is set", async () => {
    expect(await getViewSiteSelection("vitality")).toBe(DEFAULT_VIEW_SITE);
    expect(await getViewSiteIds("vitality")).toEqual(["site-cc"]);
  });

  it("pins a specific chosen site", async () => {
    store.cookie = "site-rv";
    expect(await getViewSiteSelection("vitality")).toBe("site-rv");
    expect(await getViewSiteIds("vitality")).toEqual(["site-rv"]);
  });

  it("returns every site for the All-sites sentinel", async () => {
    store.cookie = ALL_SITES;
    expect(await getViewSiteSelection("vitality")).toBe(ALL_SITES);
    expect(await getViewSiteIds("vitality")).toEqual(["site-cc", "site-rv", "site-ng"]);
  });

  it("falls back to the default when the cookie names a site the client does not have", async () => {
    store.cookie = "site-zzz";
    expect(await getViewSiteIds("vitality")).toEqual(["site-cc"]);
  });

  it("falls back to all sites when the client has no N15 (site-cc)", async () => {
    expect(await getViewSiteSelection("other")).toBe(ALL_SITES);
    expect(await getViewSiteIds("other")).toEqual(["other-1", "other-2"]);
  });
});
