import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// ===========================================================================
// TWO STRUCTURAL RULES THAT KEEP NAVIGATION FAST — AND ONE THAT KEEPS IT ALIVE.
//
// They are joined in one file because they are the same trade seen from both
// ends. Next 16 will not prefetch a dynamic route unless there is a `loading.tsx`
// to prefetch down to; every authed page here is force-dynamic; and a loading.tsx
// is the one thing this app may never have. So the framework's own answer to
// "make navigation instant" is closed to us, and the replacement — arming a full
// `prefetch={true}` on intent — has to be wired by hand on every nav surface.
//
// A test rather than a comment because both halves fail SILENTLY. A reintroduced
// loading.tsx renders beautifully and merely leaves every button dead; a nav
// surface built with a bare <Link> looks identical to one with IntentLink and is
// simply half a second slower on every click. Neither shows up in tsc, in the
// build, or on a screenshot.
// ===========================================================================

const APP_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(APP_DIR, "..");

function walk(dir: string, hit: (path: string, name: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, hit);
    } else {
      hit(full, entry.name);
    }
  }
}

describe("no loading.tsx anywhere under src/app", () => {
  // ---------------------------------------------------------------------
  // THE TRAP THIS CLOSES, because "why is there no skeleton?" is a reasonable
  // question and the answer has to be findable.
  //
  // Three loading.tsx files once shipped in the shells (/c, /owner, /agency).
  // Content streamed through their Suspense boundaries rendered visually but
  // NEVER HYDRATED in production builds: every button on every authed page —
  // checklist ticks, worklist actions, drawers, approvals — was inert. Zero
  // console errors, zero server errors, HTTP 200, and screenshots that looked
  // perfect. They were removed in feb8677 and the trade (no route-level
  // skeleton) was accepted deliberately.
  //
  // Adding one back is an ATTRACTIVE mistake, which is exactly why this test
  // exists: the Next docs recommend loading.tsx as THE fix for slow dynamic
  // navigation, so anyone reading them while working on this problem is being
  // pointed straight at the landmine. The sanctioned alternatives are a
  // Suspense boundary INSIDE a page, useLinkStatus/useTransition, and the
  // intent-armed prefetch the second block below pins.
  // ---------------------------------------------------------------------
  it("finds none", () => {
    const found: string[] = [];
    walk(APP_DIR, (path, name) => {
      if (/^loading\.(tsx|ts|jsx|js)$/.test(name)) found.push(path.slice(APP_DIR.length));
    });
    expect(
      found,
      "A route-level loading.tsx streams its children through a Suspense boundary " +
        "that has never hydrated in this app: every button on the page below it goes " +
        "dead, silently, with a 200 and a perfect screenshot (feb8677). Put the " +
        "Suspense boundary INSIDE the page instead, or show pending state with " +
        "useLinkStatus / useTransition.",
    ).toEqual([]);
  });
});

describe("every nav surface arms a prefetch on intent", () => {
  // ---------------------------------------------------------------------
  // WHY A BARE <Link> IS NOT ENOUGH HERE, stated because the default genuinely
  // looks like it already does this. `prefetch` defaults to "auto", and auto
  // prefetches a STATIC route in full but a DYNAMIC route only down to the
  // nearest loading.tsx. With no loading.tsx (see above) that is nothing at
  // all, so a plain <Link> on these routes prefetches NOTHING and every click
  // is a cold server round trip.
  //
  // IntentLink is the escape: it flips to `prefetch={true}` — the documented
  // opt-in that covers dynamic routes — once the reader hovers, focuses or
  // presses. It is listed per surface rather than checked generically because
  // the point is COVERAGE: the drawer had this treatment for months while the
  // desktop rail, the section bar and the patient tab strip did not, which
  // meant the fix was live on the phone nobody uses and absent on the screens
  // the practice works from all day.
  // ---------------------------------------------------------------------
  const SURFACES: Record<string, string> = {
    "components/client/client-sidebar.tsx":
      "the desktop area rail AND the mobile drawer's module list",
    "components/client/section-tabs.tsx":
      "the section bar — the second-level module tabs along the top",
    "components/client/patients/record/patient-tab-strip.tsx":
      "the patient record's eleven tabs",
    // THE FOURTH, and it was missed by the first pass for the same reason the
    // drawer was fixed before the rail: the agency shell is a different tree, so
    // "every nav surface" quietly meant "every nav surface under /c". It is
    // force-dynamic exactly like the client shell (src/app/agency/layout.tsx),
    // so its bare <Link>s prefetched nothing at all.
    "components/agency/agency-sidebar.tsx":
      "the agency shell's rail — Cockpit and Feedback",
  };

  it.each(Object.entries(SURFACES))("%s (%s) uses IntentLink", (relPath, what) => {
    const source = readFileSync(join(SRC_DIR, relPath), "utf8");
    expect(source, `${what}: expected an IntentLink import`).toContain(
      '@/components/platform/intent-link',
    );
    expect(source, `${what}: expected at least one <IntentLink>`).toMatch(/<IntentLink\b/);
  });

  // -----------------------------------------------------------------------
  // AND THE OTHER HALF OF "INSTANT": the optimistic mark.
  //
  // Prefetch removes the wait; the mark removes the APPEARANCE of a wait on the
  // clicks prefetch did not cover. Both are needed, and the mark is four lines of
  // fiddly state (record the href with the pathname it was clicked from, derive
  // staleness during render, drop modified clicks, light the progress bar) that
  // was hand-copied into three surfaces and was about to be copied into a fourth.
  //
  // It now lives once in usePendingNav, and this pins that all four go through it
  // rather than growing a local variant. A hand-copied one that drops the
  // modified-click guard fails silently and permanently — see the behavioural
  // test in components/platform/use-pending-nav.test.ts, which exercises the guard
  // itself; this only checks that the surfaces are actually plugged into it.
  // -----------------------------------------------------------------------
  it.each(Object.entries(SURFACES))("%s (%s) marks pending through usePendingNav", (relPath, what) => {
    const source = readFileSync(join(SRC_DIR, relPath), "utf8");
    expect(source, `${what}: expected the shared hook's import`).toContain(
      '@/components/platform/use-pending-nav',
    );
    expect(source, `${what}: expected a usePendingNav() call`).toMatch(/usePendingNav\(\)/);
    expect(
      source,
      `${what}: the hook owns the click guard now — a local copy is how the four drift apart`,
    ).not.toMatch(/isPlainNavigationClick/);
    expect(
      source,
      `${what}: the hook owns the staleness derivation now — do not re-derive it here`,
    ).not.toMatch(/pendingHrefFor/);
    expect(
      source,
      `${what}: expected the progress bar gated on the hook's pending href`,
    ).toContain("<NavProgressBar active={pendingHref !== null} />");
  });

  // The nav links must not quietly regress to a bare <Link>: on a dynamic route
  // that silently removes the prefetch and nothing else changes. Three of these
  // files carry NO plain <Link> at all, which makes the rule trivially checkable.
  // (client-sidebar.tsx is excluded on purpose: its "Sign in" link points at
  // /login, a genuinely static route that needs no arming.)
  it.each([
    "components/client/section-tabs.tsx",
    "components/client/patients/record/patient-tab-strip.tsx",
    "components/agency/agency-sidebar.tsx",
  ])("%s carries no un-armed <Link>", (relPath) => {
    const source = readFileSync(join(SRC_DIR, relPath), "utf8");
    expect(source, "a bare <Link> on a force-dynamic route prefetches nothing").not.toMatch(
      /<Link\b/,
    );
  });

  // IntentLink itself must keep asking for the DYNAMIC-capable prefetch. The
  // difference between `prefetch={true}` and the Next docs' own hover example
  // (`prefetch={active ? null : false}`) is one word and the whole effect: null
  // means "auto", and auto is precisely the mode that does nothing here.
  it("IntentLink arms prefetch={true}, not the default auto", () => {
    const source = readFileSync(
      join(SRC_DIR, "components/platform/intent-link.tsx"),
      "utf8",
    );
    expect(source).toMatch(/prefetch=\{armed \? true : false\}/);
  });
});
