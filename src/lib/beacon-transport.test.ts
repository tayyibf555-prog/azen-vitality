// THE ONE TRANSPORT, held at the seam that made it worth extracting.
//
// WHAT THIS FILE IS ACTUALLY FOR. The sendBeacon-then-keepalive-fetch block used to
// exist FOUR TIMES, line for line and comment for comment: inside step-beacon.ts's
// private send(), inside funnel-progress-beacon.ts's report(), inside
// funnel/client.ts's send(), and inside the usage beacon's effect. Four copies means
// a fix to delivery is a fix to a QUARTER of the telemetry — the drop-off chart
// keeps its last screen while the lead's funnel position, the public funnel's last
// step and the owner's usage picture quietly lose theirs. So the first describe
// below reads every call site as TEXT and asserts each routes through the shared
// function and holds no transport of its own.
//
// AND THE SWEEP, which is the part that makes a FIFTH copy impossible. Enumerating
// call sites only pins the files someone thought to list — the third and fourth
// copies above sat in the tree for months precisely because this list named two.
// So the second describe walks all of src/ instead and asserts the mechanics appear
// in no non-test file but this one. Both are structural pins in the spirit of the
// importer pins elsewhere: the property is about the SHAPE of the source, and there
// is no runtime observation that would notice a copy reappearing.
//
// NOTE WHAT IS DELIBERATELY NOT SHARED. Only the mechanics. Every caller keeps its
// own endpoint, its own payload, its own validity rules and — the part that matters
// — its own identity: a nonce the BROWSER minted for an anonymous session, a token
// the SERVER minted for a named lead, a session id for an unauthenticated visitor,
// and an AUTHED staff session the server reads from a cookie. The transport holds no
// state and mints nothing, so it cannot become the place any two of those values
// meet (supabase/migrations/0094).

import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { srcPath, walkSrc } from "./test-support/walk-src";
import { postJsonBeacon } from "./beacon-transport";

/** This module's own path under src/: the one file the sweep below must exempt. */
const TRANSPORT_FILE = "lib/beacon-transport.ts";

const TRANSPORT_SOURCE = readFileSync(srcPath(TRANSPORT_FILE), "utf8");

/** Source with comments stripped: what a file DOES, not what it explains. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every module that must not grow a transport of its own again, as a path under
 * src/. Two are smile-assessment's; the rest are why this file no longer lives in
 * that feature's folder — a public funnel tracker shared with the booking page, the
 * authed shell's product-usage beacon, and a public landing page's tracker.
 *
 * THE FIFTH WAS AN EXEMPTION, not an oversight, and the exemption was wrong. The
 * landing tracker posted with a keepalive fetch and no sendBeacon, and was listed
 * in KEEPALIVE_ELSEWHERE below on the reasoning that folding it in "would change
 * what that public page does". It would, and the change is the one it wanted:
 * `cta_clicked` fires WHILE the browser is navigating to the booking page, and a
 * keepalive fetch is the weaker of the two answers to exactly that moment.
 */
const CALL_SITES = [
  ["the anonymous step beacon", "lib/smile-assessment/step-beacon.ts"],
  ["the lead progress beacon", "lib/smile-assessment/funnel-progress-beacon.ts"],
  ["the public funnel tracker", "lib/funnel/client.ts"],
  ["the product-usage beacon", "components/platform/usage-beacon.tsx"],
  ["the landing-page tracker", "lib/landing/track.ts"],
] as const;

/* ---------------------------------------------------------------------------
 * 1. Every beacon goes through it. The pin that keeps the copies from coming back.
 * ------------------------------------------------------------------------- */

describe("every browser beacon delivers through the one shared transport", () => {
  // MUTATION: inline the sendBeacon/fetch block back into any call site "so the
  // file reads on its own". That is exactly the state this dedup ended, and the
  // next fix to delivery would then land in part of the telemetry only.
  it.each(CALL_SITES)("%s posts through postJsonBeacon", (_name, file) => {
    const code = codeOnly(readFileSync(srcPath(file), "utf8"));
    expect(code, `${file} no longer imports the shared transport`).toMatch(
      /import\s*\{\s*postJsonBeacon\s*\}\s*from\s*["']@\/lib\/beacon-transport["']/,
    );
    expect(code, `${file} imports the shared transport but does not call it`).toContain(
      "postJsonBeacon(",
    );
  });

  // MUTATION: keep the import AND a "just this once" direct sendBeacon next to it.
  // A second delivery path in a beacon is the duplication wearing a hat.
  it.each(CALL_SITES)("%s holds no transport of its own", (_name, file) => {
    const code = codeOnly(readFileSync(srcPath(file), "utf8"));
    for (const mechanic of ["sendBeacon", "new Blob(", "keepalive", "fetch("]) {
      expect(code, `${file} still does its own delivery: found ${mechanic}`).not.toContain(
        mechanic,
      );
    }
  });

  it("and the transport is the only place those mechanics live", () => {
    const code = codeOnly(TRANSPORT_SOURCE);
    expect(code).toContain("navigator.sendBeacon(");
    expect(code).toContain("keepalive: true");
  });
});

/* ---------------------------------------------------------------------------
 * 2. And nowhere else in the tree. The sweep, not a list someone maintains.
 * ------------------------------------------------------------------------- */

/**
 * Every .ts/.tsx under src/, as a path relative to src/.
 *
 * THE WALK IS SHARED NOW (lib/test-support/walk-src.ts), and the reason is the one
 * this file's own comment used to state alone: it is rooted through import.meta.url
 * rather than process.cwd(), so a worktree copy of the repo sweeps ITS OWN tree and
 * not the one the runner happens to sit in. Written here as advice, that was
 * ignored by the very next sweep added to the suite — which rooted at cwd — so the
 * root now lives in a function no caller can override.
 *
 * TESTS ARE SKIPPED (the walker's default), and that is not a loophole: standing a
 * fake browser up around these mechanics is what a test of them has to do, and the
 * biggest offender would be this very file.
 */
function sourceFiles(): string[] {
  return walkSrc();
}

/**
 * Exceptions to the keepalive sweep below. EMPTY, AND KEPT.
 *
 * It held one name: the landing tracker, which hand-rolled a keepalive fetch with
 * no sendBeacon at all and was argued for as "a smaller shape, not a copy". That
 * argument was wrong in the direction that matters — postJsonBeacon only ADDS
 * sendBeacon-first delivery, and `cta_clicked` fires as the visitor navigates away,
 * which is precisely the moment a bare fetch is the one that gets cancelled. It is
 * now a call site (above) like the other four.
 *
 * The set stays because an exception has to be NAMEABLE. Deleting it would mean the
 * next file that wants one gets it by editing a filter instead of adding a line
 * here with a reason attached to it.
 */
const KEEPALIVE_ELSEWHERE = new Set<string>([]);

describe("no other file in the tree grows a transport of its own", () => {
  // MUTATION: paste the block into a fifth feature's beacon. The list above only
  // pins files someone thought to name — the funnel tracker and the usage beacon
  // held byte-identical copies for months while it named two. This is the pin that
  // does not depend on anyone noticing.
  it("is the only place in src/ that calls navigator.sendBeacon", () => {
    const offenders = sourceFiles().filter(
      (file) =>
        file !== TRANSPORT_FILE &&
        codeOnly(readFileSync(srcPath(file), "utf8")).includes("navigator.sendBeacon"),
    );
    expect(offenders, "a new copy of the beacon transport: route it through postJsonBeacon").toEqual(
      [],
    );
  });

  it("is the only place a keepalive fetch is written, bar the one named exception", () => {
    const offenders = sourceFiles().filter(
      (file) =>
        file !== TRANSPORT_FILE &&
        !KEEPALIVE_ELSEWHERE.has(file) &&
        codeOnly(readFileSync(srcPath(file), "utf8")).includes("keepalive"),
    );
    expect(offenders, "a new keepalive sender: route it through postJsonBeacon").toEqual([]);
  });

  // MUTATION: break the walk (a wrong SRC_ROOT, a filter that matches nothing) and
  // the two sweeps above pass by finding no files at all. This is what notices.
  it("actually walks the tree it claims to", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(TRANSPORT_FILE);
    for (const [, file] of CALL_SITES) expect(files).toContain(file);
  });
});

/* ---------------------------------------------------------------------------
 * 3. Sharing a module must not widen any caller's import graph.
 * ------------------------------------------------------------------------- */

describe("the shared transport is safe to pull into a client component", () => {
  // MUTATION: import the step-event rules here "to validate the payload", or the
  // repository "for one insert helper". Every caller is destined for a "use client"
  // component and they pin their own import lists; a widening here would widen ALL
  // of those graphs at once, behind pins that only read the callers themselves.
  it("imports nothing at all, so no caller's graph can widen through it", () => {
    const imports = [...TRANSPORT_SOURCE.matchAll(/^\s*import\b[\s\S]*?from\s+["']([^"']+)["']/gm)];
    expect(imports.map((m) => m[1])).toEqual([]);
  });

  it("names nothing server-only", () => {
    const code = codeOnly(TRANSPORT_SOURCE);
    for (const banned of ["serviceClient", "server-only", "repository", "process.env"]) {
      expect(code, `found ${banned}`).not.toContain(banned);
    }
  });

  // MUTATION: mint an id, remember the last endpoint, cache anything. The callers
  // are anonymous visitors, a NAMED lead and an AUTHED staff session, and the only
  // reason they may share a module is that this one cannot hold anything belonging
  // to any of them.
  it("keeps no state between calls", () => {
    const code = codeOnly(TRANSPORT_SOURCE);
    expect(code).not.toMatch(/^(let|var|const)\s/m);
    expect(code).not.toContain("crypto");
  });
});

/* ---------------------------------------------------------------------------
 * 4. The mechanics themselves, which used to be tested only through a beacon.
 * ------------------------------------------------------------------------- */

interface Posted {
  url: string;
  body: string;
  type: string;
}

const globals = globalThis as unknown as Record<string, unknown>;
const STUBBED = ["navigator", "Blob", "fetch"] as const;
const ORIGINAL = new Map<string, PropertyDescriptor | undefined>();

/**
 * Node's `navigator` is a getter-only own property of globalThis, so a plain
 * assignment throws. defineProperty (and restoring the captured descriptors) is
 * the only way to stand a fake browser up around this module.
 */
function stub(name: string, value: unknown): void {
  if (!ORIGINAL.has(name)) ORIGINAL.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/** A Blob that can be read synchronously, so a test can see what was queued. */
function stubBlob(): void {
  stub(
    "Blob",
    class {
      __text: string;
      __type: string;
      constructor(parts: string[], options?: { type?: string }) {
        this.__text = parts.join("");
        this.__type = options?.type ?? "";
      }
    },
  );
}

afterEach(() => {
  for (const name of STUBBED) {
    if (!ORIGINAL.has(name)) continue;
    const descriptor = ORIGINAL.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globals[name];
  }
  ORIGINAL.clear();
});

describe("how a payload leaves the page", () => {
  it("prefers sendBeacon, with the payload as an application/json blob", () => {
    const posted: Posted[] = [];
    stubBlob();
    stub("navigator", {
      sendBeacon: (url: string, blob: { __text: string; __type: string }) => {
        posted.push({ url, body: blob.__text, type: blob.__type });
        return true;
      },
    });
    stub("fetch", () => {
      throw new Error("fetch must not be reached when sendBeacon accepted the payload");
    });

    postJsonBeacon("/api/somewhere", '{"a":1}');
    expect(posted).toEqual([{ url: "/api/somewhere", body: '{"a":1}', type: "application/json" }]);
  });

  // MUTATION: ignore sendBeacon's return value. It returns FALSE when the browser
  // refuses to queue the payload (past its budget, or the page is closing), and a
  // beacon that treats that as sent silently loses the last screen of a session.
  it("falls back to a keepalive fetch when sendBeacon refuses the payload", () => {
    const calls: Array<[string, RequestInit]> = [];
    stubBlob();
    stub("navigator", { sendBeacon: () => false });
    stub("fetch", (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve({});
    });

    postJsonBeacon("/api/somewhere", '{"a":1}');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("/api/somewhere");
    expect(calls[0][1].method).toBe("POST");
    expect(calls[0][1].body).toBe('{"a":1}');
    expect(calls[0][1].keepalive).toBe(true);
    expect((calls[0][1].headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  it("falls back to fetch when sendBeacon throws, or when there is no navigator", () => {
    const calls: string[] = [];
    stubBlob();
    stub("fetch", (url: string) => {
      calls.push(url);
      return Promise.resolve({});
    });

    stub("navigator", {
      sendBeacon: () => {
        throw new Error("blocked by an extension");
      },
    });
    postJsonBeacon("/api/one", "{}");

    stub("navigator", {});
    postJsonBeacon("/api/two", "{}");

    expect(calls).toEqual(["/api/one", "/api/two"]);
  });

  // MUTATION: drop either catch. Telemetry that throws takes a render or a click
  // handler down with it — on a PUBLIC quiz, in front of a patient.
  it("never throws, whatever the browser does", () => {
    stubBlob();
    stub("navigator", {
      sendBeacon: () => {
        throw new Error("blocked by an extension");
      },
    });
    stub("fetch", () => {
      throw new Error("offline");
    });
    expect(() => postJsonBeacon("/api/somewhere", "{}")).not.toThrow();
  });

  it("swallows a rejected fetch rather than leaving it unhandled", async () => {
    stubBlob();
    stub("navigator", { sendBeacon: () => false });
    stub("fetch", () => Promise.reject(new Error("network gone")));
    expect(() => postJsonBeacon("/api/somewhere", "{}")).not.toThrow();
    // A rejection escaping here would surface as an unhandled rejection a tick later.
    await Promise.resolve();
    await Promise.resolve();
  });

  it("returns nothing, because no caller can know whether a beacon arrived", () => {
    stubBlob();
    stub("navigator", { sendBeacon: () => true });
    expect(postJsonBeacon("/api/somewhere", "{}")).toBeUndefined();
  });
});
