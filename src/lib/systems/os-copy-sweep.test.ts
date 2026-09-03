import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";

// The band's read layer is `server-only`, which node cannot resolve; this suite
// only needs its tile definitions.
vi.mock("server-only", () => ({}));

// The three workspaces are client components that call `useRouter` to refresh
// after a save. Nothing in this suite saves anything; the router is stubbed so
// the EMPTY STATE can be rendered, which is the only thing being read.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/c/vitality",
  useSearchParams: () => new URLSearchParams(),
}));

import { CLIENT_NAV } from "@/lib/nav";
import { FORBIDDEN_PATIENT_WORDS } from "@/lib/triage/forbidden";
import { OS_TILES } from "@/lib/home/os-band";
import { SYSTEMS, SYSTEM_SLUGS } from "./catalog";
import { FIRST_STEPS } from "./first-steps";
import { SYSTEM_VOCABULARY } from "./vocabulary";

// ===========================================================================
// THE COPY SWEEP: three rules that apply to the WHOLE platform, checked in one
// place because each of them was previously checked in none.
//
// 1. NO PATIENT-FACING SURFACE SAYS NHS OR PRIVATE. The rule is PRODUCT.md's
//    and section 0 item 7 of the programme charter. src/lib/triage/copy.test.ts
//    proves it for the pre-visit form by RENDERING it, which is the stronger
//    proof and covers one route tree. This sweep covers the OTHER public trees
//    — the assessment, the booking page, onboarding, the medical-history link,
//    the short-link lander — by crawling their source, which is weaker (a word
//    reaching them from a database is invisible to it) and is why it is an
//    addition to that suite and not a replacement for it.
//
// 2. NOTHING PROMISES THE PARKED PER-COMPUTER IT AGENT. "The installed
//    per-computer IT agent is PARKED by decision" (charter §4). The IT desk has
//    no software on any machine and no way to get one there, so any sentence
//    that mentions installing, remote access or an endpoint has to be a DENIAL.
//    This is what stops the module drifting into a promise the practice would
//    reasonably expect us to keep.
//
// 3. MODULE COPY USES THE PRACTICE'S VOCABULARY, NEVER AN INTERNAL SLUG. The
//    practice says "Pre-visit questions", "the IT desk", "Dentally write-back".
//    "pre-visit-triage" is a database value and a URL segment, and a screen that
//    prints one has stopped speaking the practice's language.
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. The funding crawl over the public route trees.
// ---------------------------------------------------------------------------

/**
 * Every public tree a patient can land on.
 *
 * /fp17 IS EXEMPT, BY NAME AND FOR ONE REASON: the thing the patient is filling
 * in on that page IS an NHS dental declaration — a legal form, named in
 * legislation, which the patient is signing. Renaming it to protect them from
 * the word would leave them signing a document whose name they had not been
 * told. The exemption is exactly this route tree and nothing else, and the
 * assertion below proves the exemption is still needed rather than leaving a
 * stale hole in the crawl.
 */
const PUBLIC_TREES = ["src/app/pv", "src/app/assess", "src/app/book", "src/app/onboard", "src/app/mh", "src/app/go"];
const FUNDING_EXEMPT_TREE = "src/app/fp17";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const path = join(d, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) out.push(path);
    }
  };
  walk(join(process.cwd(), dir));
  return out;
}

/**
 * Lines that could reach a screen: comment lines are dropped, because the rule is
 * about what a patient reads and a comment explaining the rule would otherwise
 * break it. Crude on purpose — a heuristic that over-reports is a nuisance, one
 * that under-reports is a hole, and this one only ever drops a line that BEGINS
 * as a comment.
 */
function copyLines(file: string): Array<{ line: number; text: string }> {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => {
      const t = text.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
}

describe("no funding word reaches a patient on any public surface", () => {
  it("crawls every public route tree", () => {
    const hits: string[] = [];
    for (const tree of PUBLIC_TREES) {
      for (const file of sourceFiles(tree)) {
        for (const { line, text } of copyLines(file)) {
          for (const re of FORBIDDEN_PATIENT_WORDS) {
            if (re.test(text)) hits.push(`${file.replace(process.cwd() + "/", "")}:${line} ${text.trim().slice(0, 100)}`);
          }
        }
      }
    }
    expect(hits, `funding words on a patient-facing surface:\n${hits.join("\n")}`).toEqual([]);
  });

  it("the one exempt tree is exempt because it still needs to be", () => {
    // If FP17's pages ever stop naming the declaration, the exemption is dead
    // wood and should be deleted rather than left standing as a hole.
    const named = sourceFiles(FUNDING_EXEMPT_TREE).some((f) =>
      copyLines(f).some(({ text }) => /\bnhs\b/i.test(text)),
    );
    expect(named, "the FP17 funding exemption is no longer needed — delete it").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. The parked IT agent.
// ---------------------------------------------------------------------------

/** Words that only ever appear in a sentence about software on somebody's machine. */
const ENDPOINT_WORDS = /\b(install(?:s|ed|ing|ation)?|remote(?:ly)?|endpoint|take over your (?:screen|computer))\b/i;
/** A sentence carrying one of those words must also carry one of these. */
const DENIAL = /\b(never|no|not|cannot|can't|without|nothing|nobody)\b/i;

/** Every string a person reads about the IT desk, from every surface that has one. */
function itDeskCopy(): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  const navItem = CLIENT_NAV.flatMap((g) => g.items).find((i) => i.slug === "it-desk");
  if (navItem?.note) out.push({ where: "nav note", text: navItem.note });
  const system = SYSTEMS.find((s) => s.slug === "it-desk");
  if (system) out.push({ where: "catalog halts", text: system.halts });
  out.push({ where: "vocabulary starts", text: SYSTEM_VOCABULARY["it-desk"].starts });
  out.push({ where: "first step", text: FIRST_STEPS["it-desk"].step });
  for (const file of ["src/components/client/itdesk/it-desk-view.tsx", "src/components/client/itdesk/it-desk-workspace.tsx"]) {
    for (const { line, text } of prose(join(process.cwd(), file))) {
      out.push({ where: `${file}:${line}`, text });
    }
  }
  return out;
}

/**
 * The lines of a component that are PROSE rather than code: at least four words
 * and at least one space-separated pair of ordinary words. `endpoint="/api/..."`
 * is a route, not a promise, and a crawl that cannot tell the two apart gets
 * loosened until it proves nothing.
 */
function prose(file: string): Array<{ line: number; text: string }> {
  return copyLines(file).filter(({ text }) => {
    const words = text.trim().replace(/[<>{}()[\]"'`=/]/g, " ").split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z'-]{1,}$/.test(w));
    return words.length >= 6;
  });
}

describe("nothing promises the per-computer IT agent that is parked", () => {
  it("every sentence that mentions installing or remote access is a denial", () => {
    const promises = itDeskCopy()
      .filter(({ text }) => ENDPOINT_WORDS.test(text) && !DENIAL.test(text))
      .map(({ where, text }) => `${where}: ${text.trim().slice(0, 120)}`);
    expect(
      promises,
      `IT desk copy that reads as a promise of software on a machine:\n${promises.join("\n")}`,
    ).toEqual([]);
  });

  it("the denial is actually made, on the module's own page", () => {
    const view = readFileSync(
      join(process.cwd(), "src/components/client/itdesk/it-desk-view.tsx"),
      "utf8",
    );
    expect(view).toMatch(/no way to see, reach or control any computer/i);
    expect(view).toMatch(/there is no software of ours on any machine/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Slugs are not vocabulary.
// ---------------------------------------------------------------------------

/**
 * Hyphenated compounds the PRACTICE says out loud. They happen to be slugs too,
 * and banning them would be banning English: a receptionist says "after-hours",
 * an owner says "the co-pilot", everybody says "no-show". Kept short and
 * explicit, because every entry is a hole in the crawl and a hole nobody can
 * read is how a crawl dies.
 */
const PRACTICE_WORDS = new Set(["after-hours", "co-pilot", "no-show"]);

/**
 * The internal names that must never be printed. Derived from the catalog and the
 * nav rather than typed here, so a new module's slug joins the ban automatically.
 *
 * Single-word slugs ("recall", "equipment", "compliance") are excluded because
 * they are ordinary English AND are what the practice calls those things — there
 * is no second name to prefer. Hyphenated ones are the risk: "pre-visit-triage"
 * and "dentally-write-back" have proper names ("Pre-visit questions", "Dentally
 * write-back") and printing the slug means a screen stopped using them.
 */
function bannedSlugs(): string[] {
  const all = new Set<string>([...SYSTEM_SLUGS, ...CLIENT_NAV.flatMap((g) => g.items.map((i) => i.slug))]);
  return [...all].filter((s) => s.includes("-") && !PRACTICE_WORDS.has(s));
}

/**
 * Every string this lane puts in front of a person.
 *
 * `needsFirst` IS EXCLUDED BY NAME, and the exclusion is paid for rather than
 * assumed. It carries environment variable names, cron job names and account
 * names — DENTALLY_WRITE_ENABLED, PUBLIC_BASE_URL, /api/previsit/sweep — which
 * have no other name to be called by, and the person reading that line is the
 * person who arranges them. vocabulary.test.ts pins that it is the roster's own
 * list and not something typed into a screen, which is what the exclusion would
 * otherwise let through.
 */
function userVisibleCopy(): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  for (const group of CLIENT_NAV) {
    for (const item of group.items) {
      out.push({ where: `nav label ${item.slug}`, text: item.label });
      if (item.note) out.push({ where: `nav note ${item.slug}`, text: item.note });
    }
  }
  for (const system of SYSTEMS) {
    out.push({ where: `catalog label ${system.slug}`, text: system.label });
    out.push({ where: `catalog halts ${system.slug}`, text: system.halts });
    // ROSTER-DERIVED SENTENCES ARE EXCLUDED, BY NAME AND WITH A REASON. Those
    // belong to the switch-on runbook (src/lib/agent-wiring/roster.ts), are
    // addressed to the person doing the go-live, and cross-reference other
    // agents by the slug printed on their switch — "becomes a speed-to-lead
    // lead" is how that reader finds the next thing to turn on. This lane
    // cannot launder its own copy through the hole, because vocabulary.test.ts
    // pins every roster-derived sentence to the roster's own string by identity.
    if (SYSTEM_VOCABULARY[system.slug].source === "module") {
      out.push({ where: `vocabulary starts ${system.slug}`, text: SYSTEM_VOCABULARY[system.slug].starts });
    }
  }
  for (const step of Object.values(FIRST_STEPS)) {
    out.push({ where: `first step ${step.key}`, text: `${step.surface} ${step.step}` });
  }
  for (const tile of OS_TILES) {
    out.push({ where: `os tile ${tile.key}`, text: tile.label });
  }
  return out;
}

describe("module copy speaks the practice's language, never a slug", () => {
  it("no hyphenated internal slug appears in anything a person reads", () => {
    const banned = bannedSlugs();
    expect(banned.length, "the slug list came back empty; it has gone stale").toBeGreaterThan(10);
    const hits: string[] = [];
    for (const { where, text } of userVisibleCopy()) {
      for (const slug of banned) {
        // Word-boundaried so "Pre-visit questions" is fine and
        // "pre-visit-triage" is not.
        if (new RegExp(`(^|[^A-Za-z0-9-])${slug}([^A-Za-z0-9-]|$)`).test(text)) {
          hits.push(`${where}: "${slug}" in "${text.slice(0, 90)}"`);
        }
      }
    }
    expect(hits, `internal slugs in user-visible copy:\n${hits.join("\n")}`).toEqual([]);
  });

  it("the Operating system band's tiles are named the way the practice names them", () => {
    for (const tile of OS_TILES) {
      expect(tile.label).not.toBe(tile.moduleSlug);
      expect(tile.label[0]).toBe(tile.label[0].toUpperCase());
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The empty states say what to do first — on the screen, not in a constant.
// ---------------------------------------------------------------------------

describe("every wave-1 surface's empty state says what to do first", () => {
  /**
   * Rendered, not grepped. A first step written into `first-steps.ts` and never
   * printed is exactly the failure this is for: the constant would satisfy a
   * source crawl while the practice looked at a blank table.
   */
  async function renderEmpty(module: string, extra: Record<string, unknown> = {}): Promise<string> {
    switch (module) {
      case "equipment": {
        const { EquipmentWorkspace } = await import("@/components/client/equipment/equipment-workspace");
        return renderToStaticMarkup(
          createElement(EquipmentWorkspace, {
            clientSlug: "vitality",
            assets: [],
            sites: [],
            systemEnabled: false,
            registerUnreadable: false,
            ...extra,
          }),
        );
      }
      case "it-desk": {
        const { ItDeskWorkspace } = await import("@/components/client/itdesk/it-desk-workspace");
        return renderToStaticMarkup(
          createElement(ItDeskWorkspace, {
            clientSlug: "vitality",
            playbooksByArea: [],
            contact: { name: "", company: "", phone: "", email: "", hours: "", notes: "" },
            contactUnavailable: false,
            canEditContact: true,
            systemEnabled: false,
            ...extra,
          }),
        );
      }
      case "pre-visit-triage": {
        const { PreVisitWorkspace } = await import("@/components/client/previsit/previsit-workspace");
        return renderToStaticMarkup(
          createElement(PreVisitWorkspace, {
            clientSlug: "vitality",
            isOwner: true,
            treatments: [],
            interest: [],
            interestCounts: {},
            mining: [],
            miningTitle: "Implant interest",
            miningCoverage: "",
            miningExclusions: "",
            miningCaveats: [],
            systemEnabled: false,
            ...extra,
          }),
        );
      }
      case "authorities": {
        const { AuthoritiesPanel } = await import("@/components/client/copilot/authorities-panel");
        return renderToStaticMarkup(createElement(AuthoritiesPanel, { clientSlug: "vitality", ...extra }));
      }
      default:
        throw new Error(`no empty-state renderer for ${module}`);
    }
  }

  /**
   * A distinctive fragment of each shared first step, as it must appear on
   * screen. Apostrophe-free on purpose: React escapes `'` to `&#x27;` in static
   * markup, so a fragment carrying one fails for a reason that has nothing to do
   * with the copy being present.
   */
  const ON_SCREEN: Array<[string, string]> = [
    ["equipment", "Import the register you already keep for CQC"],
    ["it-desk", "IT contact — the person or company a problem goes to"],
    ["pre-visit-triage", "Review the two question lists"],
  ];

  for (const [module, fragment] of ON_SCREEN) {
    it(`${module} prints its first step when it is empty`, async () => {
      const html = await renderEmpty(module);
      expect(html).toContain(fragment);
    });
  }

  it("the approved-sources panel's first step is the shared one", () => {
    // The panel is collapsed until an owner opens it and its list arrives from a
    // fetch, so the constant is asserted here and the panel's use of it is a
    // one-line call. What is proved is that the sentence exists, is written in
    // the practice's language, and names the action.
    expect(FIRST_STEPS.authorities.step).toContain("Add the first source your practice trusts");
    const panel = readFileSync(
      join(process.cwd(), "src/components/client/copilot/authorities-panel.tsx"),
      "utf8",
    );
    expect(panel).toContain('firstStepFor("authorities")');
  });

  it("every first step reaches at least one screen", () => {
    // The reverse direction: a sentence in `first-steps.ts` that no component
    // ever prints is dead copy pretending to be a feature.
    const trees = ["src/components/client", "src/app/c", "src/app/owner", "src/lib/home"];
    const sources = trees.flatMap((t) => sourceFiles(t)).map((f) => readFileSync(f, "utf8"));
    for (const key of Object.keys(FIRST_STEPS)) {
      const used = sources.some((s) => s.includes(`firstStepFor("${key}")`)) ||
        sources.some((s) => s.includes("firstStepFor(") && s.includes("first-steps"));
      expect(used, `no screen ever prints the first step for ${key}`).toBe(true);
    }
  });
});
