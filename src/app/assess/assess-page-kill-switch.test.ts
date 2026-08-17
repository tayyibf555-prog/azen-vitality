// THE KILL SWITCH ON THE PUBLIC CAMPAIGN PAGE.
//
// The owner-only per-system switch for `smile-assessment` used to be enforced in
// exactly two places, and both of them are things the ADAPTIVE quiz calls:
// /api/smile-assessment/next (next/route.ts:192) and the submit route
// (submit/route.ts:266). A deterministic funnel walks a graph the browser was
// already handed, so it never calls /next at all. With the system switched off it
// would have served the whole funnel and only failed at submit — after the patient
// had answered every question and typed in their name and mobile number.
//
// Turning a system off has to mean the door is shut. The check therefore lives on
// the PAGE, ahead of the campaign read, and this file is what keeps it there: it
// is one deletable line, guarding a switch nobody exercises in day-to-day use, on
// a page with no other test. Deleting it would break nothing visible.
//
// vitest collects only src/**/*.test.ts in a node env, and the page is a .tsx
// server component that awaits Supabase reads, so it is pinned by reading its
// source — the guided-assessment-shell.test.ts technique.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SYSTEM_BY_SLUG, isControllableSystem } from "@/lib/systems/catalog";

const PAGE_PATH = fileURLToPath(new URL("./[client]/[slug]/page.tsx", import.meta.url));
const source = readFileSync(PAGE_PATH, "utf8");

/** The page component's own body — never generateMetadata, which sits above it. */
const PAGE_ENTRY = "export default async function CampaignAssessmentPage(";
const metadataBody = (() => {
  const start = source.indexOf("export async function generateMetadata(");
  const end = source.indexOf(PAGE_ENTRY);
  expect(start, "generateMetadata is no longer in this page").toBeGreaterThan(-1);
  expect(end, "the page component was renamed").toBeGreaterThan(start);
  return source.slice(start, end);
})();
const pageBody = source.slice(source.indexOf(PAGE_ENTRY));

/** Index of a marker inside the page body, asserted present. */
function at(marker: string): number {
  const i = pageBody.indexOf(marker);
  expect(i, `the page no longer contains ${JSON.stringify(marker)}`).toBeGreaterThan(-1);
  return i;
}

describe("the public campaign page enforces the system kill switch", () => {
  it("reads the switch from the systems repository", () => {
    // A REGEX RATHER THAN toContain, and consciously so: the page now imports
    // `isSystemEnabledStrict` from the same module for its Meta-pixel gate, so the
    // exact one-name import statement this used to assert no longer exists. The
    // WORD BOUNDARY is what keeps the assertion honest — `\bisSystemEnabled\b` does
    // not match `isSystemEnabledStrict`, so an import list that kept only the
    // strict reader (i.e. a page that had quietly changed how the door works) still
    // fails here.
    expect(source).toMatch(
      /import \{[^}]*\bisSystemEnabled\b[^}]*\} from "@\/lib\/systems\/repository";/,
    );
  });

  it("names a system that actually exists and is switchable", () => {
    // A typo'd slug would read as "no row => enabled" and the switch would be a
    // decoration. The catalog is the authority on the spelling.
    expect(source).toContain('isSystemEnabled(clientRecord.id, "smile-assessment")');
    expect(SYSTEM_BY_SLUG.has("smile-assessment")).toBe(true);
    expect(isControllableSystem("smile-assessment")).toBe(true);
  });

  it("404s when the system is off, rather than rendering a disabled funnel", () => {
    expect(pageBody).toMatch(
      /if \(!\(await isSystemEnabled\(clientRecord\.id, "smile-assessment"\)\)\) notFound\(\);/,
    );
    expect(source).toContain('import { notFound } from "next/navigation"');
  });

  // THE ASSERTION THAT MATTERS. Position, not presence: a check that runs after
  // the funnel has been read and rendered is not a kill switch.
  it("runs the check before the campaign is read, the flow is resolved, or the quiz renders", () => {
    const killSwitch = at("isSystemEnabled(clientRecord.id");
    const campaignRead = at("getActiveCampaignBySlug(clientRecord.id, slug)");
    const flowGate = at("campaign.flowPublished");
    const flowRead = at("normaliseAndValidateFlow(campaign.flow)");
    const render = at("<AssessmentQuiz");

    expect(killSwitch).toBeLessThan(campaignRead);
    expect(campaignRead).toBeLessThan(flowGate);
    expect(flowGate).toBeLessThan(flowRead);
    expect(flowRead).toBeLessThan(render);
  });

  it("is the page's check, not a metadata-only one", () => {
    // generateMetadata deliberately degrades to a generic title instead of
    // throwing, so it is not, and must not become, the enforcement point. The
    // substring catches BOTH readers, which is what is wanted here: neither belongs
    // above the page component.
    expect(metadataBody).not.toContain("isSystemEnabled");

    // ONE DOOR, and the count is of the FAIL-OPEN reader alone. The regex needs the
    // open paren immediately after the name, so `isSystemEnabledStrict(` is not a
    // match — and that discrimination is deliberate rather than a lucky accident of
    // the pattern. The page makes two systems reads on purpose and they do
    // different jobs, so each is counted on its own terms: a second fail-open call
    // would mean a second door, or a gate that has drifted down the page.
    expect(pageBody.match(/isSystemEnabled\(/g)).toHaveLength(1);

    // ...AND ONE STRICT READ, the Meta-pixel gate. The door fails OPEN so a toggle
    // blip cannot 404 a live funnel; the pixel fails CLOSED so the same blip cannot
    // put a third-party script on a page whose system may be off. Losing the strict
    // call — or having the pixel ride on the door's answer, which is what this page
    // used to do — is a silent regression, so the count is pinned here too.
    // meta-pixel-wiring.test.ts owns what that read then decides.
    expect(pageBody.match(/isSystemEnabledStrict\(/g)).toHaveLength(1);
  });

  it("still checks the practice exists first, so an unknown client 404s either way", () => {
    const clientLookup = at("getClient(client)");
    expect(clientLookup).toBeLessThan(at("isSystemEnabled(clientRecord.id"));
    expect(pageBody).toContain("if (!clientRecord) notFound();");
  });
});

describe("the deterministic funnel is the reason the check has to be here", () => {
  it("serves an authored flow from this page without any call to /next", () => {
    // If this page stopped passing a flow down, the kill switch would once again
    // be reachable through /next alone and this file would be pinning nothing.
    expect(pageBody).toContain("flow={flow}");
    expect(source).toContain("toPublicFlow");
    // Vacuity guard: the body is the real page, not a stub left behind.
    expect(pageBody.length).toBeGreaterThan(1500);
  });
});
