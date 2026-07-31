import { describe, it, expect } from "vitest";
import { GET } from "./route";
import { dentallySiteId } from "@/lib/mock/clients";

// ===========================================================================
// THE site_id ECHO CONTRACT.
//
// listSitePractitionersSafe (src/lib/dentally/read.ts) drops any practitioner row
// whose site_id is a STRING that does not equal the Dentally UUID it queried with.
// So a mock that answers with the INTERNAL id ("site-cc") instead of the UUID
// filters out every practitioner and returns { practitioners: [], failed: false }.
//
// That combination is the worst possible one for the diary: an EMPTY list reported
// as a SUCCESSFUL read. Availability is then never requested (no ids to request it
// for), every column derives zero working spans, and the grid draws a fully grey
// "nobody is working today" while insisting nothing went wrong. It is precisely
// the confident-empty the whole availability design exists to prevent, and it
// regressed once already when this route was rewritten to serve per-site rosters.
// ===========================================================================

function request(siteId: string): Request {
  return new Request(
    `http://localhost/api/mock-dentally/v1/practitioners?site_id=${encodeURIComponent(siteId)}`,
    { headers: { authorization: "Bearer test-token" } },
  );
}

async function practitioners(siteId: string): Promise<Array<Record<string, unknown>>> {
  const res = await GET(request(siteId));
  const json = (await res.json()) as { practitioners: Array<Record<string, unknown>> };
  return json.practitioners;
}

describe("mock /v1/practitioners", () => {
  it("echoes site_id back in the SAME form it was asked for, so the UUID match survives", async () => {
    const uuid = dentallySiteId("site-cc");
    const rows = await practitioners(uuid);

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.site_id, "a row answering a UUID query must carry that UUID").toBe(uuid);
    }
  });

  it("survives the exact filter listSitePractitionersSafe applies", async () => {
    const uuid = dentallySiteId("site-cc");
    const rows = await practitioners(uuid);

    // The real filter, copied from read.ts: active, and site_id either absent or
    // equal to the queried UUID.
    const kept = rows.filter(
      (r) => r.active === true && (typeof r.site_id !== "string" || r.site_id === uuid),
    );
    expect(kept.length, "every active practitioner must survive the site match").toBeGreaterThan(0);
  });

  it("still serves a per-site roster and keeps an inactive row to catch a missing filter", async () => {
    const cc = await practitioners(dentallySiteId("site-cc"));
    const ng = await practitioners(dentallySiteId("site-ng"));

    const ids = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.id).sort();
    expect(ids(cc)).not.toEqual(ids(ng)); // not the same team at every site
    expect(cc.some((r) => r.active === false), "site-cc keeps an active:false row").toBe(true);
  });

  it("returns nothing for an unknown site rather than inventing a team", async () => {
    expect(await practitioners("no-such-site-uuid")).toEqual([]);
  });
});
