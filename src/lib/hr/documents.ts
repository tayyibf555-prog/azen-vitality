// The staff document vault — PURE rules. No I/O, no Supabase, no React.
//
// Everything the upload route and the vault UI decide is decided here so it can be
// unit tested and mutation tested: which content types are allowed, what the stored
// path looks like, whether a supplied path belongs to the requesting practice, and
// whether a document is valid, expiring or expired. A rule that lives in a React
// closure or halfway down an API handler cannot be tested in this repo (vitest
// collects src/**/*.test.ts in a node environment only), which is exactly why none of
// these live there.
//
// THE FILE-SAFETY POSTURE, stated once, in full, because it is the honest answer to
// "is it safe to let staff upload files":
//   - MIME allow-list: PDF plus four image types. Nothing else is stored, ever.
//   - 10 MB cap, checked AFTER parsing (Content-Length can be absent or a lie); a
//     cheaper Content-Length pre-guard rejects an obviously oversized body first.
//   - Private bucket, and the only way to read a file is a 120 second signed URL.
//     `getPublicUrl` appears nowhere in this codebase and must stay that way.
//   - The uploader's filename is never trusted: it is sanitised to a leaf, and the
//     extension is FORCED from the validated content-type, so "cv.pdf.exe" is stored
//     as "cv.pdf".
//   - Only authenticated staff of the practice can upload at all.
//   - THERE IS NO VIRUS SCANNING IN THIS CODEBASE AND NONE IS PROPOSED. That is a
//     real, stated limitation, not an oversight: the mitigations above are what
//     stands between the vault and a malicious file. It is written into the module
//     note the UI renders so nobody assumes a scanner exists.
//
// British English. No dash characters in copy.

/** The private Storage bucket for staff documents and policy PDFs. */
export const STAFF_DOCS_BUCKET = "staff-docs";

// ---------------------------------------------------------------------------
// Kinds.
// ---------------------------------------------------------------------------

/**
 * A CLOSED list, matching the check constraint in migration 0076. "other" exists so
 * a practice is never forced to mislabel a file, but every kind that carries a
 * compliance meaning is named, because `documentsMissing` answers "what is this
 * person missing" from these values and a free-text kind makes that unanswerable.
 */
export const DOCUMENT_KINDS = [
  "passport",
  "right-to-work",
  "gdc-registration",
  "dbs",
  "indemnity",
  "qualification",
  "contract",
  "training-certificate",
  "other",
] as const;

export type StaffDocumentKind = (typeof DOCUMENT_KINDS)[number];

export function isDocumentKind(v: unknown): v is StaffDocumentKind {
  return typeof v === "string" && (DOCUMENT_KINDS as readonly string[]).includes(v);
}

/** Display labels. British English, no abbreviation an inspector would query. */
export const DOCUMENT_KIND_LABELS: Record<StaffDocumentKind, string> = {
  passport: "Passport or photo ID",
  "right-to-work": "Right to work",
  "gdc-registration": "GDC registration",
  dbs: "DBS certificate",
  indemnity: "Indemnity cover",
  qualification: "Qualification",
  contract: "Contract of employment",
  "training-certificate": "Training certificate",
  other: "Other",
};

/**
 * The kinds a practice is normally asked to hold for a clinical team member.
 * DECISION SUPPORT, NOT LEGAL ADVICE: it is a checklist the practice can work from,
 * and `documentsMissing` reports against whatever list it is given rather than
 * asserting this one is complete for every role.
 */
export const SUGGESTED_REQUIRED_KINDS: StaffDocumentKind[] = [
  "right-to-work",
  "gdc-registration",
  "dbs",
  "indemnity",
  "contract",
];

// ---------------------------------------------------------------------------
// Upload safety.
// ---------------------------------------------------------------------------

/**
 * content-type -> canonical extension for the stored object's leaf name.
 * The SAME five types the onboarding upload accepts (api/onboarding/upload/route.ts),
 * deliberately not widened: a vault that accepted .docx or .zip would be a different
 * risk profile and would need a different conversation.
 */
export const ALLOWED_DOCUMENT_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/webp": "webp",
};

/** Only PDFs are accepted as a POLICY document: a policy is a document, not a photo. */
export const ALLOWED_POLICY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
};

/** The authoritative size cap, applied after the body is parsed. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10MB
/**
 * The cheap pre-guard, applied to the declared Content-Length before parsing.
 * Above the file cap to allow multipart overhead; the post-parse check is what is
 * authoritative, because Content-Length can be absent or lied about.
 */
export const CONTENT_LENGTH_CEILING = 12_000_000;

/** Length cap on the practice's own label for a file. */
export const MAX_DOCUMENT_LABEL = 120;

/** The extension for a content-type, or null if it is not on the allow-list. */
export function extensionForMime(
  mime: unknown,
  allowed: Record<string, string> = ALLOWED_DOCUMENT_MIME,
): string | null {
  if (typeof mime !== "string") return null;
  return allowed[mime] ?? null;
}

/**
 * Make a safe leaf filename: strip any directory parts, keep a conservative charset,
 * bound the length, and FORCE the extension that matches the validated content-type.
 *
 * Cloned from `safeLeafName` in api/onboarding/upload/route.ts, which is the only
 * upload template in this repo and a good one. It lives here instead of in the route
 * so it has a test: the route's copy has none, because a function inside a route
 * handler is not reachable from src/**\/*.test.ts.
 */
export function safeDocLeafName(rawName: unknown, ext: string): string {
  const raw = typeof rawName === "string" ? rawName : "";
  const base = (raw.split(/[\\/]/).pop() ?? "file")
    .replace(/\.[^.]+$/, "") // drop the original extension
    .replace(/[^a-zA-Z0-9._-]+/g, "-") // conservative charset
    .replace(/^[-.]+|[-.]+$/g, "") // no leading/trailing dot or dash
    .slice(0, 80);
  const stem = base || "file";
  return `${stem}.${ext}`;
}

/** A path segment we generated ourselves must still look like one. */
function isSafeSegment(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 100 && /^[a-zA-Z0-9._-]+$/.test(v);
}

export interface SafeDocPathInput {
  clientSlug: string;
  /** The rota_staff uuid this document belongs to. */
  staffId: string;
  /** A server-generated random token (randomUUID) — never anything caller-supplied. */
  token: string;
  /** The uploader's filename. Used for the leaf only, and sanitised first. */
  filename: unknown;
  /** The content-type ALREADY validated against the allow-list. */
  mime: string;
  allowed?: Record<string, string>;
}

/**
 * The stored object path: `staff-docs/<clientSlug>/<staffId>/<token>/<safeName>`.
 *
 * Returns null rather than throwing when anything is off, so the route answers a
 * friendly 400 instead of a 500. The token directory is what makes the path
 * unguessable; the clientSlug prefix is what makes the tenancy check below possible.
 */
export function safeDocPath(input: SafeDocPathInput): string | null {
  const ext = extensionForMime(input.mime, input.allowed ?? ALLOWED_DOCUMENT_MIME);
  if (!ext) return null;
  if (!isSafeSegment(input.clientSlug)) return null;
  if (!isSafeSegment(input.staffId)) return null;
  if (!isSafeSegment(input.token)) return null;
  const leaf = safeDocLeafName(input.filename, ext);
  return `${STAFF_DOCS_BUCKET}/${input.clientSlug}/${input.staffId}/${input.token}/${leaf}`;
}

/** The policy PDF path: `staff-docs/<clientSlug>/policies/<token>/<safeName>`. */
export function safePolicyPath(input: Omit<SafeDocPathInput, "staffId">): string | null {
  const ext = extensionForMime(input.mime, input.allowed ?? ALLOWED_POLICY_MIME);
  if (!ext) return null;
  if (!isSafeSegment(input.clientSlug)) return null;
  if (!isSafeSegment(input.token)) return null;
  const leaf = safeDocLeafName(input.filename, ext);
  return `${STAFF_DOCS_BUCKET}/${input.clientSlug}/policies/${input.token}/${leaf}`;
}

/**
 * THE TENANCY + TRAVERSAL GUARD, as a pure function.
 *
 * A signed-URL endpoint takes a path from the query string, so this is the single
 * thing standing between one practice's employee passports and another's. It is the
 * same check `api/onboarding/file/route.ts:37-40` performs inline, lifted out so it
 * has tests: the path must live exactly under this client's prefix inside the
 * staff-docs bucket, and must contain no `..` anywhere.
 *
 * Deliberately strict about the bucket name too. A path of
 * "onboarding/vitality/..." would satisfy a naive "starts with the client slug"
 * check and read a PATIENT's document out of the other bucket.
 */
export function isWithinStaffDocPrefix(path: unknown, clientSlug: string): boolean {
  if (typeof path !== "string" || path === "") return false;
  if (!isSafeSegment(clientSlug)) return false;
  if (path.includes("..")) return false;
  return path.startsWith(`${STAFF_DOCS_BUCKET}/${clientSlug}/`);
}

/**
 * THE SELF-SERVICE HALF OF THE SAME GUARD: is this path THIS PERSON's document?
 *
 * `isWithinStaffDocPrefix` proves a path belongs to the practice, which is all a
 * manager's read needs — a manager may open anybody's file. A member of staff
 * reading their own vault from My work may not, and the path arrives from a
 * browser, so "the server gave me this path a moment ago" is a claim and not a
 * fact. Documents are stored at
 *
 *     staff-docs/<clientSlug>/<staffId>/<token>/<leaf>       (`safeDocPath`)
 *
 * so the person's own prefix is one segment longer, and asserting it is what
 * stops a signed URL for a colleague's passport being minted for anybody who can
 * guess a staff id. NOTE this deliberately excludes the policy prefix
 * (`.../policies/...`, `safePolicyPath`): a policy is not somebody's document,
 * and a staff id can never equal the literal segment "policies" because ids are
 * uuids.
 */
export function isWithinOwnDocPrefix(path: unknown, clientSlug: string, staffId: string): boolean {
  if (!isWithinStaffDocPrefix(path, clientSlug)) return false;
  if (!isSafeSegment(staffId)) return false;
  return (path as string).startsWith(`${STAFF_DOCS_BUCKET}/${clientSlug}/${staffId}/`);
}

// ---------------------------------------------------------------------------
// The stored row, and expiry.
// ---------------------------------------------------------------------------

export interface StaffDocument {
  id: string;
  clientId: string;
  staffId: string;
  kind: StaffDocumentKind;
  label: string;
  storagePath: string;
  mime: string;
  sizeBytes: number;
  /** YYYY-MM-DD, or null when this document has no expiry the practice tracks. */
  expiresOn: string | null;
  /** YYYY-MM-DD. Documented retention only: nothing in v1 deletes on this date. */
  retainUntil: string | null;
  uploadedBy: string | null;
  createdAt: string;
}

/**
 * FOUR states, not the three the brief sketched.
 *
 * "no-expiry" is its own answer because folding it into "valid" would be a confident
 * claim the data does not support: a passport scan with no recorded expiry is not
 * "valid until further notice", it is a document nobody put a date on. The vault
 * shows it as exactly that, and the practice can add a date.
 */
export type DocumentExpiryState = "no-expiry" | "valid" | "expiring" | "expired";

/** How far ahead counts as "expiring". Two months is enough notice to renew a DBS. */
export const EXPIRING_SOON_DAYS = 60;

const DAY_MS = 86_400_000;

/** Parse YYYY-MM-DD as a UTC midnight. Returns null for anything else. */
function parseDayKey(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  const back = new Date(ms);
  // Reject 2026-02-31 and friends: Date.UTC rolls them over silently.
  if (back.getUTCMonth() !== Number(mo) - 1 || back.getUTCDate() !== Number(d)) return null;
  return ms;
}

/** Whole days from `fromKey` to `toKey`. Null if either is not a date key. */
export function daysBetween(fromKey: unknown, toKey: unknown): number | null {
  const a = parseDayKey(fromKey);
  const b = parseDayKey(toKey);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY_MS);
}

/**
 * Valid, expiring soon, already expired, or carrying no expiry at all.
 *
 * A document that expires TODAY is "expiring", not "expired": it is still in force
 * for the whole of today, and telling somebody their indemnity lapsed this morning
 * when it has not is the kind of small lie that makes staff distrust the screen.
 */
export function expiryState(
  doc: Pick<StaffDocument, "expiresOn">,
  todayKey: string,
  withinDays: number = EXPIRING_SOON_DAYS,
): DocumentExpiryState {
  if (doc.expiresOn === null || doc.expiresOn === undefined) return "no-expiry";
  const days = daysBetween(todayKey, doc.expiresOn);
  if (days === null) return "no-expiry"; // unparseable: nothing to judge, say nothing
  if (days < 0) return "expired";
  if (days <= withinDays) return "expiring";
  return "valid";
}

/**
 * Which of the required kinds this person does not hold a USABLE document for.
 *
 * "Usable" excludes expired: a right-to-work check that lapsed last year is not
 * evidence of anything, and reporting the person as covered because a row exists is
 * the failure this function exists to prevent. A document with no expiry counts as
 * held (see `expiryState`) — the practice chose not to date it.
 *
 * Returns the missing kinds in the order they were asked for, deduplicated.
 */
export function documentsMissing(
  required: readonly StaffDocumentKind[],
  held: readonly Pick<StaffDocument, "kind" | "expiresOn">[],
  todayKey: string,
): StaffDocumentKind[] {
  const usable = new Set<string>();
  for (const doc of held) {
    if (expiryState(doc, todayKey) !== "expired") usable.add(doc.kind);
  }
  const out: StaffDocumentKind[] = [];
  for (const kind of required) {
    if (usable.has(kind)) continue;
    if (out.includes(kind)) continue;
    out.push(kind);
  }
  return out;
}

/**
 * Documents needing attention, worst first: expired before expiring, and within each
 * group the soonest date first. This is the practice's actual worklist.
 */
export function documentsNeedingAttention<T extends Pick<StaffDocument, "expiresOn">>(
  docs: readonly T[],
  todayKey: string,
  withinDays: number = EXPIRING_SOON_DAYS,
): T[] {
  const flagged = docs.filter((d) => {
    const state = expiryState(d, todayKey, withinDays);
    return state === "expired" || state === "expiring";
  });
  return [...flagged].sort((a, b) => String(a.expiresOn).localeCompare(String(b.expiresOn)));
}

/**
 * Is this document past the retention date the practice recorded?
 *
 * DISPLAY ONLY. Nothing in v1 acts on it. An automatic deleter that quietly destroyed
 * a right-to-work check would be far worse than a date nobody actioned, so the answer
 * is surfaced to a person and a person decides.
 */
export function isPastRetention(
  doc: Pick<StaffDocument, "retainUntil">,
  todayKey: string,
): boolean {
  if (!doc.retainUntil) return false;
  const days = daysBetween(todayKey, doc.retainUntil);
  if (days === null) return false;
  return days < 0;
}

/** A size a person can read. Integer bytes in, no floating point money anywhere near. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Copy. Kept beside the rules so the honest caveats cannot drift from the code.
// ---------------------------------------------------------------------------

export const DOCUMENT_COPY = {
  vaultNote:
    "The employee file's paperwork, held in this platform. Files are stored privately and can only be opened through a link that expires after two minutes. Documents are never made public.",
  noVirusScanning:
    "Uploads are not virus scanned. Only PDFs and photographs are accepted, files are capped at 10 MB, storage is private, and only signed in staff of this practice can upload or open a file.",
  retentionNote:
    "A retention date can be recorded against a document so the practice knows when it should be reviewed or removed. Nothing is deleted automatically: the date is a reminder for a person, not an instruction to the system.",
  gdprNote:
    "Passports, right to work checks, DBS certificates and the rest are employee personal data under UK GDPR. Keep only what the practice needs, for as long as it needs it, and record it in the practice's record of processing activities.",
  readFailed:
    "The document vault could not be read just now, so nothing is being shown. This is not an empty vault: please try again, and tell the practice if it keeps happening.",
  notReady:
    "The document vault is not set up on this environment yet. Once the practice's storage is connected, uploads and the file list will appear here.",
  uploadFailed: "That file could not be stored. Please try again.",
} as const;
