// THE ONE TRANSPORT, held at the seam that made it worth extracting.
//
// WHAT THIS FILE IS ACTUALLY FOR. The sendBeacon-then-keepalive-fetch block used to
// exist TWICE, line for line: once inside step-beacon.ts's private send(), once
// inside funnel-progress-beacon.ts's report(). Two copies means a fix to one is a
// fix to half the telemetry — the drop-off chart keeps its last screen and the
// lead's funnel position quietly loses hers, or the other way round. So the first
// describe below reads both beacons as TEXT and asserts they route through the
// shared function and hold no transport of their own. It is a structural pin in
// the same spirit as the importer pins next to it: the property is about the SHAPE
// of the source, and there is no runtime observation that would notice a copy
// reappearing.
//
// NOTE WHAT IS DELIBERATELY NOT SHARED. Only the mechanics. The two beacons keep
// their own endpoints, their own payloads, their own validity rules and — the part
// that matters — their own identity: one carries a nonce the BROWSER minted for an
// anonymous session, the other a token the SERVER minted for a named lead. The
// transport holds no state and mints nothing, so it cannot become the place those
// two values meet (supabase/migrations/0094).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import { postJsonBeacon } from "./beacon-transport";

const HERE = dirname(fileURLToPath(import.meta.url));

const TRANSPORT_SOURCE = readFileSync(join(HERE, "beacon-transport.ts"), "utf8");

/** Source with comments stripped: what a file DOES, not what it explains. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The two modules that must not grow a transport of their own again. */
const BEACONS = [
  ["the anonymous step beacon", "step-beacon.ts"],
  ["the lead progress beacon", "funnel-progress-beacon.ts"],
] as const;

/* ---------------------------------------------------------------------------
 * 1. Both beacons go through it. The pin that keeps the copy from coming back.
 * ------------------------------------------------------------------------- */

describe("both browser beacons deliver through the one shared transport", () => {
  // MUTATION: inline the sendBeacon/fetch block back into either beacon "so the
  // file reads on its own". That is exactly the state this dedup ended, and the
  // next fix to delivery would then land in one half of the telemetry only.
  it.each(BEACONS)("%s posts through postJsonBeacon", (_name, file) => {
    const code = codeOnly(readFileSync(join(HERE, file), "utf8"));
    expect(code, `${file} no longer imports the shared transport`).toMatch(
      /import\s*\{\s*postJsonBeacon\s*\}\s*from\s*["']\.\/beacon-transport["']/,
    );
    expect(code, `${file} imports the shared transport but does not call it`).toContain(
      "postJsonBeacon(",
    );
  });

  // MUTATION: keep the import AND a "just this once" direct sendBeacon next to it.
  // A second delivery path in a beacon is the duplication wearing a hat.
  it.each(BEACONS)("%s holds no transport of its own", (_name, file) => {
    const code = codeOnly(readFileSync(join(HERE, file), "utf8"));
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
 * 2. Sharing a module must not widen either beacon's import graph.
 * ------------------------------------------------------------------------- */

describe("the shared transport is safe to pull into a client component", () => {
  // MUTATION: import the step-event rules here "to validate the payload", or the
  // repository "for one insert helper". Both beacons are destined for a
  // "use client" quiz and both pin their own import lists; a widening here would
  // widen BOTH graphs at once, behind pins that only read the beacons themselves.
  it("imports nothing at all, so neither beacon's graph can widen through it", () => {
    const imports = [...TRANSPORT_SOURCE.matchAll(/^\s*import\b[\s\S]*?from\s+["']([^"']+)["']/gm)];
    expect(imports.map((m) => m[1])).toEqual([]);
  });

  it("names nothing server-only", () => {
    const code = codeOnly(TRANSPORT_SOURCE);
    for (const banned of ["serviceClient", "server-only", "repository", "process.env"]) {
      expect(code, `found ${banned}`).not.toContain(banned);
    }
  });

  // MUTATION: mint an id, remember the last endpoint, cache anything. The two
  // callers are an ANONYMOUS session and a NAMED lead, and the only reason they
  // may share a module is that this one cannot hold anything belonging to either.
  it("keeps no state between calls", () => {
    const code = codeOnly(TRANSPORT_SOURCE);
    expect(code).not.toMatch(/^(let|var|const)\s/m);
    expect(code).not.toContain("crypto");
  });
});

/* ---------------------------------------------------------------------------
 * 3. The mechanics themselves, which used to be tested only through a beacon.
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
