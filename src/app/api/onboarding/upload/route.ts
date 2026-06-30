import { randomUUID } from "node:crypto";
import { getClient } from "@/lib/mock/clients";
import { serviceClient } from "@/lib/supabase/server";
import { ONBOARDING_BUCKET } from "@/lib/onboarding/repository";
import type { OnboardingFile } from "@/lib/onboarding/types";
import { consumeBudget } from "@/lib/rate-budget";

export const dynamic = "force-dynamic";

// Public per-file upload endpoint. The onboarding form calls this for each document
// the patient attaches BEFORE the final submit, then sends back the returned file
// references. It stores one file in the private `onboarding` bucket and returns its
// reference; the submit endpoint re-validates those references against the client's
// prefix.
//
// ABUSE SURFACE: unauthenticated and writes bytes to Storage. We cap to ONE file per
// request, enforce the content-type allow-list + 10MB size, rate-limit per IP, mint a
// random token for the path, and NEVER trust the supplied filename (we sanitise it and
// it only forms the leaf, under a random token directory). It returns a friendly 400 /
// 413 on reject and never throws to the client.

const IP_RATE_LIMIT = 40; // max uploads from one IP per hour (best-effort, per-instance)
const HOUR_MS = 60 * 60 * 1000;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB — matches the bucket limit

// content-type -> canonical extension for the stored object's leaf name.
const ALLOWED: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/webp": "webp",
};

const ipHits = new Map<string, number[]>();
function tooManyForIp(ip: string, now: number): boolean {
  const cutoff = now - HOUR_MS;
  const hits = (ipHits.get(ip) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) {
      if (v.every((t) => t <= cutoff)) ipHits.delete(k);
    }
  }
  return hits.length > IP_RATE_LIMIT;
}

function clientIp(request: Request): string {
  // Prefer the platform-set x-real-ip (not client-spoofable). Fall back to the
  // LAST x-forwarded-for entry (Vercel appends the real connecting IP at the end);
  // the leftmost entry is attacker-controlled, so never trust it.
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }
  return "unknown";
}

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/**
 * Make a safe leaf filename: strip any directory parts, keep a conservative charset,
 * collapse runs, bound the length, and force the extension that matches the validated
 * content-type. We never trust the supplied name for anything structural.
 */
function safeLeafName(rawName: string, ext: string): string {
  const base = (rawName.split(/[\\/]/).pop() ?? "file")
    .replace(/\.[^.]+$/, "") // drop the original extension
    .replace(/[^a-zA-Z0-9._-]+/g, "-") // conservative charset
    .replace(/^[-.]+|[-.]+$/g, "") // no leading/trailing dot or dash
    .slice(0, 80);
  const stem = base || "file";
  return `${stem}.${ext}`;
}

export async function POST(request: Request): Promise<Response> {
  try {
    // Per-IP cap first (cheap) so a flood is blunted before reading the body.
    if (tooManyForIp(clientIp(request), Date.now())) {
      return bad("Too many uploads, please try again later", 429);
    }
    // Shared global budget: the real ceiling across all instances, immune to IP
    // spoofing. Bounds abuse + orphaned-object flooding regardless of warm instances.
    if (!(await consumeBudget("onboarding-upload", 400, 60))) {
      return Response.json(
        { ok: false, error: "the form is busy, please try again shortly" },
        { status: 429 },
      );
    }

    // Fast Content-Length guard: reject an oversized body before parsing it. A bit
    // above the 10MB file cap to allow multipart overhead. The post-parse size check
    // below remains the authoritative limit (Content-Length can be absent or lied about).
    const contentLength = request.headers.get("content-length");
    if (contentLength) {
      const declared = Number(contentLength);
      if (Number.isFinite(declared) && declared > 12_000_000) {
        return bad("That file is too large (max 10MB)", 413);
      }
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return bad("Expected a multipart form upload");
    }

    const clientSlug =
      typeof form.get("clientSlug") === "string"
        ? (form.get("clientSlug") as string).trim()
        : "";
    const client = clientSlug ? getClient(clientSlug) : undefined;
    if (!client) return bad("Unknown practice");

    const file = form.get("file");
    if (!(file instanceof File)) return bad("No file provided");

    // Single file per request: reject if extra `file` entries were sent.
    if (form.getAll("file").length !== 1) return bad("Upload one file at a time");

    const type = file.type;
    const ext = ALLOWED[type];
    if (!ext) return bad("That file type is not supported");

    if (file.size <= 0) return bad("The file appears to be empty");
    if (file.size > MAX_FILE_BYTES) return bad("That file is too large (max 10MB)", 413);

    // Path: onboarding/<clientSlug>/<token>/<safeName>. The token directory makes the
    // path unguessable and keeps collisions impossible without trusting the filename.
    const token = randomUUID();
    const safeName = safeLeafName(file.name || "document", ext);
    const path = `onboarding/${client.slug}/${token}/${safeName}`;

    const bytes = new Uint8Array(await file.arrayBuffer());

    const db = serviceClient();
    const { error } = await db.storage.from(ONBOARDING_BUCKET).upload(path, bytes, {
      contentType: type,
      upsert: false,
    });
    if (error) return bad("We could not store that file, please try again", 500);

    const ref: OnboardingFile = {
      path,
      name: safeName,
      size: file.size,
      type,
    };
    return Response.json({ ok: true, file: ref });
  } catch {
    return bad("We could not store that file, please try again", 500);
  }
}
