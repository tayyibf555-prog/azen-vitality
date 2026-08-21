// THE BEACON, held at the two seams a pure test of step-events.ts cannot reach:
// that what it MINTS is what the server ACCEPTS, and that exactly ONE thing calls
// it — the deterministic quiz.
//
// The second is not ceremony. This module writes to a public, unauthenticated
// endpoint, and the ordinals it posts only mean anything against the numbering in
// step-numbering.ts. A second importer is how that stops being true: the adaptive
// quiz, the Guided style or a landing page would each be emitting step numbers
// for screens the drop-off chart is not describing, into the same table, under the
// same campaign. So the importer list is asserted from the filesystem rather than
// remembered.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import { isValidNonce, MAX_EVENTS_PER_BATCH } from "./step-events";
import { createStepBeacon } from "./step-beacon";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "step-beacon.ts"), "utf8");

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CODE = codeOnly(SOURCE);

/* ---------------------------------------------------------------------------
 * A browser, minimally. vitest runs environment:"node", so there is no window;
 * the beacon returns an inert tracker there, which is itself worth pinning.
 * ------------------------------------------------------------------------- */

interface Posted {
  url: string;
  body: string;
}

const globals = globalThis as unknown as Record<string, unknown>;

/**
 * Node's `navigator` is a getter-only own property of globalThis, so a plain
 * assignment throws. defineProperty (and restoring the captured descriptors) is
 * the only way to stand a fake browser up around this module.
 */
const STUBBED = ["window", "document", "navigator", "Blob", "crypto", "fetch"] as const;
const ORIGINAL = new Map<string, PropertyDescriptor | undefined>();

function stub(name: string, value: unknown): void {
  if (!ORIGINAL.has(name)) ORIGINAL.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function fakeBrowser(): { posted: Posted[]; fire: (event: "pagehide") => void } {
  const posted: Posted[] = [];
  const listeners = new Map<string, Array<() => void>>();
  const on = (type: string, fn: () => void) => {
    listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  };
  stub("window", { addEventListener: on });
  stub("document", { addEventListener: on, visibilityState: "visible" });
  stub("navigator", {
    sendBeacon: (url: string, blob: { __text: string }) => {
      posted.push({ url, body: blob.__text });
      return true;
    },
  });
  // Node has a real Blob, but nothing here should have to read one asynchronously.
  stub(
    "Blob",
    class {
      __text: string;
      constructor(parts: string[]) {
        this.__text = parts.join("");
      }
    },
  );
  return {
    posted,
    fire: (event) => (listeners.get(event) ?? []).forEach((fn) => fn()),
  };
}

afterEach(() => {
  for (const name of STUBBED) {
    const descriptor = ORIGINAL.get(name);
    if (!ORIGINAL.has(name)) continue;
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globals[name];
  }
  ORIGINAL.clear();
});

const OPTS = { clientSlug: "vitality", campaignSlug: "invisalign-spring", flowVersion: 4 };

/* ---------------------------------------------------------------------------
 * 1. It is still unwired, and that is the whole point of this lane.
 * ------------------------------------------------------------------------- */

describe("the beacon has exactly one caller", () => {
  const SRC_ROOT = resolve(process.cwd(), "src");

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  function importers(): string[] {
    return walk(SRC_ROOT)
      .filter((file) => {
        if (file.endsWith("step-beacon.ts") || file.endsWith("step-beacon.test.ts")) return false;
        return /from\s+["'][^"']*step-beacon["']/.test(readFileSync(file, "utf8"));
      })
      .map((f) => f.slice(SRC_ROOT.length + 1).split(sep).join("/"))
      .sort();
  }

  // MUTATION: wire it into the ADAPTIVE quiz, the Guided style or a landing page
  // "for parity". Those runtimes have no authored graph, so their screens have no
  // ordinal in step-numbering.ts — they would post step numbers into the same
  // table, under the same campaign, describing screens the chart is not about.
  it("is imported by the deterministic quiz and by nothing else", () => {
    expect(
      importers(),
      "step-beacon has a new importer: only the deterministic runtime has a numbering to emit against",
    ).toEqual(["components/assess/deterministic-assessment-quiz.tsx"]);
  });

  // MUTATION: emit an ordinal the component derived itself. The chart's labels and
  // its length come from step-numbering.ts on the server; a second derivation in
  // the browser is a chart quietly describing the wrong screens.
  it("is called with an ordinal that came from the shared numbering", () => {
    const quiz = readFileSync(
      join(SRC_ROOT, "components/assess/deterministic-assessment-quiz.tsx"),
      "utf8",
    );
    expect(quiz).toMatch(/from\s+["']@\/lib\/smile-assessment\/step-numbering["']/);
    expect(quiz).toContain("stepIndexOf(numbering,");
  });

  it("says in the file which runtime calls it, and why only that one", () => {
    expect(SOURCE).toContain("deterministic-assessment-quiz");
  });
});

/* ---------------------------------------------------------------------------
 * 2. Browser-only, and no server in its import graph.
 * ------------------------------------------------------------------------- */

describe("the beacon is safe to pull into a client component", () => {
  // MUTATION: import the repository here for "one insert helper". This module is
  // destined for a "use client" quiz; a serviceClient in its graph is a
  // service-role key in a public page's bundle.
  //
  // ./beacon-transport joined the list when the sendBeacon-then-keepalive-fetch
  // block stopped being copied between this file and funnel-progress-beacon.ts.
  // It is still a CLOSED list of two, and the property this test is really about
  // is unchanged, because beacon-transport.ts imports nothing at all —
  // beacon-transport.test.ts pins that, so the graph cannot widen through it.
  it("imports only the pure rules module and the shared transport", () => {
    const imports = [...SOURCE.matchAll(/^\s*import\b[\s\S]*?from\s+["']([^"']+)["']/gm)].map(
      (m) => m[1],
    );
    expect(imports.sort()).toEqual(["./beacon-transport", "./step-events"]);
  });

  it("names nothing server-only", () => {
    for (const banned of ["serviceClient", "server-only", "step-events-repository", "process.env"]) {
      expect(CODE, `found ${banned}`).not.toContain(banned);
    }
  });

  // MUTATION: drop the typeof window guard. The quiz is server-rendered first, and
  // an addEventListener at module scope on the server is a 500 on a public page.
  it("returns an inert beacon on the server, rather than touching window", () => {
    const beacon = createStepBeacon(OPTS);
    expect(() => {
      beacon.view(0);
      beacon.flush();
    }).not.toThrow();
  });
});

/* ---------------------------------------------------------------------------
 * 3. What it mints is what the server accepts. The seam that matters.
 * ------------------------------------------------------------------------- */

describe("the nonce it mints passes the server's own validator", () => {
  // MUTATION: mint a nonce with a dot, a space or a colon in it (a timestamp is
  // the obvious temptation). isValidNonce refuses it, so EVERY post from every
  // session is silently dropped — a feature that looks wired and records nothing.
  it("is accepted by isValidNonce, whichever generator ran", () => {
    const browser = fakeBrowser();
    for (let i = 0; i < 25; i++) {
      const beacon = createStepBeacon(OPTS);
      beacon.view(0);
      beacon.flush();
    }
    expect(browser.posted.length).toBe(25);
    const nonces = browser.posted.map((p) => JSON.parse(p.body).nonce as string);
    for (const nonce of nonces) expect(isValidNonce(nonce), `rejected ${nonce}`).toBe(true);
    // Distinct per session, or two visitors count as one.
    expect(new Set(nonces).size).toBe(25);
  });

  it("keeps one nonce for the whole session", () => {
    const browser = fakeBrowser();
    const beacon = createStepBeacon(OPTS);
    beacon.view(0);
    beacon.flush();
    beacon.view(1);
    beacon.flush();
    const [first, second] = browser.posted.map((p) => JSON.parse(p.body).nonce);
    expect(first).toBe(second);
  });

  // MUTATION: assume crypto.randomUUID everywhere. Older in-app browsers (and any
  // non-secure context) have no randomUUID, and an exception in the constructor
  // would take the quiz's own render down with it.
  it("uses the crypto fallback path and still passes", () => {
    const browser = fakeBrowser();
    stub("crypto", { randomUUID: undefined });
    const beacon = createStepBeacon(OPTS);
    beacon.view(0);
    beacon.flush();
    const nonce = JSON.parse(browser.posted[0].body).nonce as string;
    expect(isValidNonce(nonce)).toBe(true);
    // Really the fallback, not a UUID that happened to pass anyway.
    expect(nonce.startsWith("s-")).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
 * 4. What it sends, and what it refuses to send.
 * ------------------------------------------------------------------------- */

describe("a post carries the four closed fields and the campaign it belongs to", () => {
  it("posts to the public endpoint with exactly the fields the parser reads", () => {
    const browser = fakeBrowser();
    const beacon = createStepBeacon(OPTS);
    beacon.view(0);
    beacon.view(2);
    beacon.flush();
    expect(browser.posted).toHaveLength(1);
    expect(browser.posted[0].url).toBe("/api/smile-assessment/step-event");
    const body = JSON.parse(browser.posted[0].body);
    expect(Object.keys(body).sort()).toEqual([
      "campaignSlug",
      "clientSlug",
      "flowVersion",
      "nonce",
      "steps",
    ]);
    expect(body.steps).toEqual([0, 2]);
    expect(body.flowVersion).toBe(4);
  });

  // MUTATION: send every view. A quiz re-renders on every keystroke in the contact
  // step; without this the last screen alone writes dozens of rows per session.
  it("sends a step once per session however often the screen renders", () => {
    const browser = fakeBrowser();
    const beacon = createStepBeacon(OPTS);
    for (let i = 0; i < 10; i++) beacon.view(1);
    beacon.flush();
    beacon.view(1);
    beacon.flush();
    expect(browser.posted).toHaveLength(1);
    expect(JSON.parse(browser.posted[0].body).steps).toEqual([1]);
  });

  // MUTATION: let the queue grow past the server's batch cap and the tail of a
  // long funnel is dropped at the door, silently.
  it("flushes at the server's own batch limit rather than overflowing it", () => {
    const browser = fakeBrowser();
    const beacon = createStepBeacon(OPTS);
    for (let i = 0; i < MAX_EVENTS_PER_BATCH + 3; i++) beacon.view(i);
    expect(browser.posted.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(browser.posted[0].body).steps).toHaveLength(MAX_EVENTS_PER_BATCH);
  });

  it("refuses an ordinal the server would refuse", () => {
    const browser = fakeBrowser();
    const beacon = createStepBeacon(OPTS);
    beacon.view(-1);
    beacon.view(9999);
    beacon.view(1.5);
    beacon.flush();
    expect(browser.posted).toEqual([]);
  });

  // MUTATION: send anyway when there is no campaign. The generic /assess/<client>
  // quiz and the internal live preview have none, and rows with no campaign behind
  // them are rows nobody can ever read.
  it("goes inert without a campaign, a client, or a real version", () => {
    const browser = fakeBrowser();
    for (const opts of [
      { ...OPTS, campaignSlug: "" },
      { ...OPTS, clientSlug: "" },
      { ...OPTS, flowVersion: -1 },
      { ...OPTS, flowVersion: 1.5 },
    ]) {
      const beacon = createStepBeacon(opts);
      beacon.view(0);
      beacon.flush();
    }
    expect(browser.posted).toEqual([]);
  });

  // MUTATION: rely on the debounce alone. The LAST screen a session saw is the one
  // the whole chart is about, and it is the one the page navigating away eats.
  it("flushes what is queued when the page goes away", () => {
    const browser = fakeBrowser();
    const beacon = createStepBeacon(OPTS);
    beacon.view(3);
    expect(browser.posted).toEqual([]); // still debouncing
    browser.fire("pagehide");
    expect(JSON.parse(browser.posted[0].body).steps).toEqual([3]);
  });

  it("never throws into the caller, whatever the browser does", () => {
    fakeBrowser();
    stub("navigator", {
      sendBeacon: () => {
        throw new Error("blocked by an extension");
      },
    });
    stub("fetch", () => {
      throw new Error("offline");
    });
    const beacon = createStepBeacon(OPTS);
    expect(() => {
      beacon.view(0);
      beacon.flush();
    }).not.toThrow();
  });
});
