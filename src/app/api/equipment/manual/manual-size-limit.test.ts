import { describe, it, expect, vi, beforeEach } from "vitest";

// ===========================================================================
// THE SIZE THE PRACTICE IS TOLD IS THE SIZE THE ROUTE ENFORCES (ruling W3/13).
//
// WHY THIS FILE EXISTS. W3/13 lowered the ceiling to 4 MB — Vercel refuses a
// request body over 4.5 MB at the edge, before any handler runs, with a
// non-JSON 413 nothing in the application can explain — and the fix landed in
// `src/lib/equipment/pdf-text.ts`: MAX_PDF_BYTES, MAX_PDF_SIZE_LABEL, and that
// module's own refusal rewritten to interpolate the label. It did not land
// here. This route's two refusals were hard-coded strings still reading "larger
// than 25MB", and this route is the surface that actually refuses: the
// `file.size > MAX_PDF_BYTES` check fires BEFORE `extractPdfText` is reached, so
// the corrected sentence next door is unreachable over HTTP.
//
// `src/lib/equipment/ingest.test.ts` pins the ceiling inside pdf-text.ts and
// nothing read this file at all, so a practice manager refused a 4.2 MB manual
// was told the limit was 25 MB — and split it to 20 MB, and was refused again.
//
// What is pinned here is the PROPERTY, not today's wording: whatever number the
// refusal names must be the number the code enforces. Retyping a literal, or
// moving the ceiling in pdf-text.ts without touching the sentence, is red.
// ===========================================================================

vi.mock("server-only", () => ({}));

const store = vi.hoisted(() => ({
  user: null as unknown,
  extracted: 0,
  // The pages the stubbed extractor hands back. Default is one page, which is
  // what every size test above wants; the passage-count tests at the foot of
  // this file replace it to drive the real chunker over a long manual.
  pages: ["text"] as string[],
}));

// PARTIAL: requireClientAccess, requireModuleApiAccess and requireApproverRole
// are the real guards; only the session read is faked.
vi.mock("@/lib/auth/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guard")>();
  return { ...actual, requireUser: async () => store.user };
});
vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
}));
vi.mock("@/lib/equipment/repository", () => ({
  getAsset: async () => ({ id: "asset-1", clientId: "vitality", name: "Lisa steriliser" }),
  replaceManual: async () => ({ ok: true }),
  deleteManualForAsset: async () => true,
}));
// The extractor is stubbed so an oversized upload that slipped past the ceiling
// would be VISIBLE (store.extracted) rather than failing for its own reasons.
vi.mock("@/lib/equipment/pdf-text", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/equipment/pdf-text")>();
  return {
    ...actual,
    extractPdfText: async () => {
      store.extracted += 1;
      return {
        pages: store.pages,
        pageCount: store.pages.length,
        extractor: "test",
        totalChars: store.pages.join("").length,
      };
    },
  };
});

import { POST } from "./route";
import { MAX_PDF_BYTES, MAX_PDF_SIZE_LABEL } from "@/lib/equipment/pdf-text";

/** A file of exactly `bytes` bytes that starts with the PDF magic number. */
function pdfOf(bytes: number): File {
  const buf = new Uint8Array(bytes);
  buf.set(new TextEncoder().encode("%PDF-1.7"), 0);
  return new File([buf], "autoclave-manual.pdf", { type: "application/pdf" });
}

async function upload(file: File, headers?: Record<string, string>) {
  const form = new FormData();
  form.append("client", "vitality");
  form.append("assetId", "asset-1");
  form.append("file", file);
  const res = await POST(
    new Request("http://localhost/api/equipment/manual", { method: "POST", body: form, headers }),
  );
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string } };
}

/** Every "<number>MB" the sentence advertises, e.g. ["4MB"]. */
function sizesNamedIn(sentence: string): string[] {
  return sentence.match(/\d+(?:\.\d+)?\s?MB/gi) ?? [];
}

beforeEach(() => {
  store.user = { id: "u1", role: "client_owner", clientId: "vitality", siteIds: ["site-cc"] };
  store.extracted = 0;
  store.pages = ["text"];
});

describe("an oversized manual is refused with the number this route actually enforces", () => {
  it("refuses a file just over the ceiling and names the ENFORCED size, not a stale one", async () => {
    // 4.3 MB: over the app's 4 MB ceiling and under Vercel's 4.5 MB edge limit,
    // which is precisely the band that reaches this handler in production.
    const { status, body } = await upload(pdfOf(MAX_PDF_BYTES + 300 * 1024));
    expect(status).toBe(413);
    expect(store.extracted, "an oversized file was handed to the extractor").toBe(0);
    const sentence = body.error ?? "";
    expect(sentence).toContain(MAX_PDF_SIZE_LABEL);
    // THE PROPERTY: the sentence names ONE size and it is the enforced one. A
    // re-typed "25MB" fails here whatever else the sentence says.
    expect(sizesNamedIn(sentence), sentence).toEqual([MAX_PDF_SIZE_LABEL]);
  });

  it("the advertised label really is the enforced byte ceiling", async () => {
    // Guards the other direction: moving MAX_PDF_BYTES without moving the label
    // would leave both this route and pdf-text.ts advertising a number that is no
    // longer true, and every assertion above would still pass.
    const advertisedMb = Number(MAX_PDF_SIZE_LABEL.replace(/\s?MB/i, ""));
    expect(advertisedMb * 1024 * 1024).toBe(MAX_PDF_BYTES);
  });

  it("says the same thing on the cheap Content-Length path, and that path is reachable", async () => {
    // VERCEL'S EDGE CEILING IS 4.5 MB (4,718,592 bytes). A pre-check threshold
    // above it can never fire in production — the platform has already refused
    // the request — so this asserts a declared length inside the reachable band
    // is refused here, before the body is parsed at all.
    const VERCEL_BODY_LIMIT = 4.5 * 1024 * 1024;
    const declared = MAX_PDF_BYTES + 400 * 1024; // 4.4 MB
    expect(declared, "the probe is above Vercel's edge limit, so it proves nothing").toBeLessThan(VERCEL_BODY_LIMIT);

    const { status, body } = await upload(pdfOf(1024), { "content-length": String(declared) });
    expect(status, "the Content-Length pre-check never fires below Vercel's own ceiling").toBe(413);
    expect(sizesNamedIn(body.error ?? ""), body.error).toEqual([MAX_PDF_SIZE_LABEL]);
    expect(store.extracted).toBe(0);
  });

  it("a manual inside the ceiling is still ingested", async () => {
    // The fail direction is closed, not shut: an ordinary 1 MB manual goes
    // through, so the ceiling above is a limit and not a wall.
    const { status, body } = await upload(pdfOf(1024 * 1024));
    expect(status, JSON.stringify(body)).toBe(200);
    expect(store.extracted).toBe(1);
  });
});

// ===========================================================================
// WHAT WAS STORED IS NOT WHAT WILL BE SEARCHED (handoff H91 / N32, ruling W3/11).
//
// `listChunksForAsset` reads at most MANUAL_CHUNK_READ_CAP passages, in page
// order. The answer-time half of this is already honest — `tools.ts` swaps "the
// manual does not cover this" for a sentence naming the part it searched — but
// the UPLOAD said "Stored 1,240 searchable passages from 610 pages." and stopped
// there, so the owner who uploaded the whole book believed the whole book was in
// and never did the one thing that would have fixed it.
//
// Pinned as a PROPERTY, not as today's wording: over the cap the message must
// name the cap; at or under it the message must not, because an "only the first
// 900 were searched" note on a 40-passage manual is a different lie.
// ===========================================================================

import { MANUAL_CHUNK_READ_CAP } from "@/lib/equipment/types";

/**
 * Make the stubbed extractor return pages that the REAL chunker turns into
 * exactly `n` passages. Each page is over TARGET_CHARS (1,100) and under
 * HARD_MAX_CHARS (1,800), so `chunkManualPages` flushes once per page and
 * neither accumulates two pages into one chunk nor splits one page into two.
 * The chunker is not mocked — this asserts against the passage count the route
 * would really store.
 */
function withPassages(n: number) {
  store.pages = Array.from({ length: n }, (_, i) => `Page ${i + 1}. ${"Operating instructions. ".repeat(50)}`);
}

describe("the upload tells the practice how much of the manual the desk will actually search", () => {
  it("a manual longer than the desk reads says so, and names the cap and the total", async () => {
    withPassages(MANUAL_CHUNK_READ_CAP + 25);
    const form = new FormData();
    form.append("client", "vitality");
    form.append("assetId", "asset-1");
    form.append("file", pdfOf(1024));
    const res = await POST(new Request("http://localhost/api/equipment/manual", { method: "POST", body: form }));
    const body = (await res.json()) as { ok?: boolean; passages?: number; searchedInFull?: boolean; message?: string };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.passages).toBe(MANUAL_CHUNK_READ_CAP + 25);
    expect(body.searchedInFull, "a manual over the cap was reported as fully searchable").toBe(false);
    // THE PROPERTY: the sentence carries the cap, both counts, and the action.
    expect(String(body.message)).toContain(String(MANUAL_CHUNK_READ_CAP));
    expect(String(body.message)).toContain(String(MANUAL_CHUNK_READ_CAP + 25));
    expect(String(body.message), body.message).toMatch(/troubleshooting/i);
  });

  it("an ordinary manual is NOT given the caveat", async () => {
    // The other direction. A 40-passage manual IS read in full, and telling its
    // owner otherwise teaches everyone to skip the sentence that matters.
    withPassages(40);
    const form = new FormData();
    form.append("client", "vitality");
    form.append("assetId", "asset-1");
    form.append("file", pdfOf(1024));
    const res = await POST(new Request("http://localhost/api/equipment/manual", { method: "POST", body: form }));
    const body = (await res.json()) as { searchedInFull?: boolean; message?: string };
    expect(body.searchedInFull).toBe(true);
    expect(String(body.message)).not.toContain(String(MANUAL_CHUNK_READ_CAP));
    expect(String(body.message)).toMatch(/^Stored 40 searchable passages from \d+ pages\.$/);
  });
});
