// ===========================================================================
// THE MANUAL UPLOAD'S CEILING, FROM THE PRACTICE'S SIDE (ruling W3/13).
//
// The route has enforced 4 MB since the wave-3 fix; this is the other three
// quarters of "advertise AND enforce":
//
//   1. THE NUMBER IS THE SAME NUMBER. `src/lib/equipment/pdf-text.ts` owns the
//      ceiling and cannot be imported by a browser bundle (`import "server-only"`),
//      so `upload-limits.ts` holds a second copy. Two copies drift — that is
//      exactly how the refusal came to say "larger than 25MB" while the code
//      enforced 4 MB — so both halves, the byte figure and the words, are read out
//      of that file's SOURCE and compared here. The route's own refusal sentence
//      is pinned against ours the same way.
//   2. AN OVERSIZED FILE NEVER LEAVES THE BROWSER. Vercel refuses a body over
//      4.5 MB at the edge, before the route and before its 413, so above that size
//      the application is never given the chance to explain itself.
//   3. A 413 THAT ARRIVES ANYWAY STILL NAMES THE SIZE. The old handler called
//      `response.json()` unconditionally; the edge's body is not JSON, the parse
//      threw, and the practice was told "We could not upload that manual. Please
//      try again." for a file that can never work however many times they retry.
//      That generic sentence is the outcome W3/13 exists to eliminate.
//   4. THE RULE IS ON SCREEN BEFORE ANY OF THAT. It used to be reachable only by
//      picking a file and being turned away.
//
// The decisions live in `upload-limits.ts` rather than inside the React event
// handler precisely so that (2) and (3) are ordinary functions with ordinary
// tests: this suite runs in node with `renderToStaticMarkup` and cannot click.
// The one thing that remains a source scan is that the handler CALLS them — the
// last test here — because nothing else can see inside a closure.
// ===========================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/c/vitality",
  useSearchParams: () => new URLSearchParams(),
}));

import {
  MAX_PDF_BYTES,
  MAX_PDF_SIZE_LABEL,
  OVERSIZE_MESSAGE,
  UPLOAD_FAILED,
  UPLOAD_UNCONFIRMED,
  oversizeRefusal,
  readManualUploadReply,
} from "./upload-limits";
import type { AssetRow } from "@/lib/equipment/view";
import { EquipmentWorkspace } from "./equipment-workspace";

const PDF_TEXT = "src/lib/equipment/pdf-text.ts";
const ROUTE = "src/app/api/equipment/manual/route.ts";
const WORKSPACE = "src/components/client/equipment/equipment-workspace.tsx";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

/** `4 * 1024 * 1024` out of a source file, without eval. */
function product(expression: string): number {
  return expression
    .split("*")
    .map((part) => Number(part.trim().replace(/_/g, "")))
    .reduce((a, b) => a * b, 1);
}

function reply(over: {
  ok?: boolean;
  status?: number;
  contentType?: string | null;
  json?: () => Promise<unknown>;
}) {
  const status = over.status ?? 200;
  return {
    ok: over.ok ?? (status >= 200 && status < 300),
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? over.contentType ?? null : null) },
    json:
      over.json ??
      (async () => {
        throw new SyntaxError("Unexpected token '<'");
      }),
  };
}

function asset(over: Partial<AssetRow> = {}): AssetRow {
  return {
    id: "a1",
    name: "Autoclave 1",
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

function renderManualsTab(): string {
  return renderToStaticMarkup(
    createElement(EquipmentWorkspace, {
      clientSlug: "vitality",
      assets: [asset()],
      sites: [],
      systemEnabled: true,
      registerUnreadable: false,
      initialTab: "manuals",
    }),
  );
}

describe("the browser's copy of the upload ceiling cannot drift from the server's", () => {
  it("MAX_PDF_BYTES equals pdf-text.ts's own", () => {
    const declared = source(PDF_TEXT).match(/export const MAX_PDF_BYTES\s*=\s*([\d_\s*]+);/);
    expect(declared, "the MAX_PDF_BYTES scan went stale").toBeTruthy();
    expect(MAX_PDF_BYTES, "the browser's copy of the ceiling drifted from the server's").toBe(
      product(declared![1]),
    );
  });

  it("MAX_PDF_SIZE_LABEL equals pdf-text.ts's own", () => {
    const declared = source(PDF_TEXT).match(/export const MAX_PDF_SIZE_LABEL\s*=\s*"([^"]+)"/);
    expect(declared, "the MAX_PDF_SIZE_LABEL scan went stale").toBeTruthy();
    expect(MAX_PDF_SIZE_LABEL, "the advertised words drifted from the server's").toBe(declared![1]);
  });

  it("the words and the figure agree with each other", () => {
    // The failure this catches is one number moving without the other, which is
    // what told a practice manager the limit was 25MB while 4 MB was enforced.
    const megabytes = Number(MAX_PDF_SIZE_LABEL.replace(/\s?MB/i, ""));
    expect(Number.isFinite(megabytes), MAX_PDF_SIZE_LABEL).toBe(true);
    expect(megabytes * 1024 * 1024).toBe(MAX_PDF_BYTES);
  });

  it("the sentence we show is the sentence the route sends", () => {
    // Both sides of the same ceiling say the same words and offer the same next
    // step, whether the refusal came from this browser or from the route.
    const declared = source(ROUTE).match(/const TOO_LARGE = `([^`]+)`/);
    expect(declared, "the route's TOO_LARGE scan went stale").toBeTruthy();
    expect(OVERSIZE_MESSAGE).toBe(declared![1].replace("${MAX_PDF_SIZE_LABEL}", MAX_PDF_SIZE_LABEL));
  });
});

describe("a manual over the ceiling is refused before it is sent", () => {
  it("refuses one byte over, and names the size", () => {
    const refusal = oversizeRefusal(MAX_PDF_BYTES + 1);
    expect(refusal).toBe(OVERSIZE_MESSAGE);
    expect(refusal).toContain(MAX_PDF_SIZE_LABEL);
    expect(refusal).not.toContain("Please try again");
  });

  it("refuses the 6 MB manual that the edge would otherwise swallow", () => {
    expect(oversizeRefusal(6 * 1024 * 1024)).toBe(OVERSIZE_MESSAGE);
  });

  it("lets a manual AT the ceiling through, because 4MB means 4MB", () => {
    expect(oversizeRefusal(MAX_PDF_BYTES)).toBeNull();
    expect(oversizeRefusal(1)).toBeNull();
  });
});

describe("a 413 names the size even when its body is not JSON", () => {
  it("the edge's HTML 413 is explained, not turned into 'please try again'", async () => {
    const outcome = await readManualUploadReply(reply({ status: 413, contentType: "text/html; charset=utf-8" }));
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe(OVERSIZE_MESSAGE);
    expect(outcome.message).not.toBe(UPLOAD_FAILED);
  });

  it("a 413 with NO content-type at all is explained too", async () => {
    const outcome = await readManualUploadReply(reply({ status: 413, contentType: null }));
    expect(outcome.message).toBe(OVERSIZE_MESSAGE);
  });

  it("the route's own 413 keeps the route's words", async () => {
    const outcome = await readManualUploadReply(
      reply({
        status: 413,
        contentType: "application/json",
        json: async () => ({ ok: false, error: OVERSIZE_MESSAGE }),
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe(OVERSIZE_MESSAGE);
  });

  it("a JSON refusal that is not about size keeps ITS words", async () => {
    const outcome = await readManualUploadReply(
      reply({
        status: 404,
        contentType: "application/json",
        json: async () => ({ ok: false, error: "That asset is not on this practice's register" }),
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("That asset is not on this practice's register");
  });

  it("a gateway's HTML 502 gets the generic sentence, which is the honest one there", async () => {
    const outcome = await readManualUploadReply(reply({ status: 502, contentType: "text/html" }));
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe(UPLOAD_FAILED);
  });

  it("a success carries the route's message through and refreshes", async () => {
    const outcome = await readManualUploadReply(
      reply({
        status: 200,
        contentType: "application/json",
        json: async () => ({ ok: true, message: "Read 42 pages of autoclave.pdf." }),
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toBe("Read 42 pages of autoclave.pdf.");
  });

  it("a 200 whose body will not parse is neither claimed nor denied", async () => {
    // FAIL CLOSED both ways: "Uploaded." would be a claim we cannot support, and
    // "we could not upload" would send somebody to re-upload a stored manual.
    const outcome = await readManualUploadReply(reply({ status: 200, contentType: "text/plain" }));
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe(UPLOAD_UNCONFIRMED);
  });

  it("a 200 without ok:true does not refresh the page", async () => {
    const outcome = await readManualUploadReply(
      reply({ status: 200, contentType: "application/json", json: async () => ({ error: "no" }) }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("no");
  });
});

describe("the size rule is on screen before anyone picks a file", () => {
  it("the Manuals tab states the ceiling next to the upload buttons", () => {
    const html = renderManualsTab();
    expect(html).toContain(`One PDF per machine, ${MAX_PDF_SIZE_LABEL} or smaller`);
    // The rule is above the buttons it governs, not under them.
    expect(html.indexOf(MAX_PDF_SIZE_LABEL)).toBeLessThan(html.indexOf(">Upload<"));
  });

  it("does not state it on the Register tab, which uploads nothing", () => {
    const html = renderToStaticMarkup(
      createElement(EquipmentWorkspace, {
        clientSlug: "vitality",
        assets: [asset()],
        sites: [],
        systemEnabled: true,
        registerUnreadable: false,
        initialTab: "register",
      }),
    );
    expect(html).not.toContain("One PDF per machine");
  });
});

describe("the upload handler actually uses both", () => {
  // A SOURCE SCAN, and the only one here, because a decision inside a React event
  // handler cannot be reached from a node suite with no DOM. Without it the whole
  // of `upload-limits.ts` could be correct and unused: the handler could go back
  // to a bare `response.json()` and every assertion above would stay green.
  const src = source(WORKSPACE);
  // Comments stripped, or the prose explaining why `response.json()` is gone
  // would itself satisfy a scan looking for `response.json()`.
  const handler = src
    .slice(src.indexOf("const uploadManual"), src.indexOf("const removeManual"))
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  it("refuses on size before it fetches", () => {
    expect(handler).toContain("oversizeRefusal(file.size)");
    expect(handler.indexOf("oversizeRefusal")).toBeLessThan(handler.indexOf("fetch("));
  });

  it("reads the reply through readManualUploadReply, never a bare response.json()", () => {
    expect(handler).toContain("readManualUploadReply(response)");
    expect(handler).not.toContain("response.json()");
  });
});
