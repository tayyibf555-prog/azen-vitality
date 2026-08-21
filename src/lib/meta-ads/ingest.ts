// WINNING-ADS INGEST + RANKING. A PURE module: no React, no network, no imports.
//
// It turns the raw shape the Apify Meta Ad Library scraper returns into the rows
// the `winning_ads` table stores (migration 0088), doing three things a database
// insert cannot:
//
//   1. FILTER OUT the pollution. Dynamic-catalogue ads whose copy is still a
//      "{{product.brand}}" template, ads with no real copy, and ads whose call to
//      action is a brand/community action (join a group, like a page, view a
//      profile) rather than a treatment offer, are not winning DENTAL ads to model
//      and are dropped before anything else.
//
//   2. DEDUPLICATE by the creative, not the row. The Ad Library returns every
//      variant of a scaled ad as its own row; 40 variants of one creative are ONE
//      thing to learn from, not 40. Rows are grouped by their collation id (which
//      all variants of a creative share) or, when absent, by page + body, and each
//      group collapses to a single library entry carrying a `variantCount`.
//
//   3. SCORE and RANK. Each entry gets a `winningScore` (0..100) computed from two
//      public signals, so the ads most likely to be winners come first.
//
// THE SCORE (why these two signals). We do not have spend, CTR or lead numbers for
// a competitor's ad, and we must never invent them. What the Ad Library DOES tell
// us honestly is how long an ad has run and how many variants of it are live, and
// both are real winner signals:
//
//   * RUNTIME  - an advertiser who keeps paying to run one creative for months is
//                telling you, with their own money, that it converts. This is the
//                strongest public signal of a proven ad. It saturates at
//                RUNTIME_SATURATION_DAYS (six months): half a year of continuous
//                spend is already a fully proven winner, and a two-year-old
//                always-on brand ad should not dominate the library on age alone.
//   * VARIANTS - running many variants of the same creative at once is how an
//                advertiser SCALES a winner. It saturates at VARIANT_SATURATION.
//
// Runtime is weighted above variants (RUNTIME_WEIGHT vs VARIANT_WEIGHT): longevity
// is the more reliable signal, scaling is the corroborating one. Every number here
// is a documented constant, so the score is a transparent function anyone can read,
// and it is pinned by ingest.test.ts (the six-month implant ad scores high, a
// two-day ad scores low).

// ---------------------------------------------------------------------------
// RAW INPUT SHAPE (the subset of the Apify scraper's fields we consume). Every
// field is optional/loose because scraped data is never uniform; the mapping
// tolerates missing pieces rather than trusting them.
// ---------------------------------------------------------------------------

export interface ApifyImage {
  resized_image_url?: string | null;
  original_image_url?: string | null;
}

export interface ApifyVideo {
  video_preview_image_url?: string | null;
}

export interface ApifySnapshot {
  page_name?: string | null;
  page_profile_picture_url?: string | null;
  cta_text?: string | null;
  cta_type?: string | null;
  display_format?: string | null;
  link_url?: string | null;
  title?: string | null;
  body?: { text?: string | null } | null;
  images?: ApifyImage[] | null;
  videos?: ApifyVideo[] | null;
}

export interface ApifyAdItem {
  ad_archive_id?: string | null;
  page_name?: string | null;
  page_id?: string | null;
  start_date_formatted?: string | null;
  end_date_formatted?: string | null;
  is_active?: boolean | null;
  collation_count?: number | null;
  collation_id?: string | null;
  currency?: string | null;
  publisher_platform?: string[] | null;
  snapshot?: ApifySnapshot | null;
  ad_library_url?: string | null;
  categories?: string[] | null;
}

// ---------------------------------------------------------------------------
// OUTPUT SHAPE (one deduplicated, scored library entry — mirrors the winning_ads
// columns, camelCased). The repository maps this straight onto the row.
// ---------------------------------------------------------------------------

export interface WinningAd {
  niche: string;
  keyword: string;
  dedupKey: string;
  collationId: string | null;
  adArchiveId: string | null;
  collationCount: number | null;
  variantCount: number;
  pageName: string | null;
  pageId: string | null;
  title: string | null;
  bodyText: string | null;
  ctaText: string | null;
  ctaType: string | null;
  linkUrl: string | null;
  displayFormat: string | null;
  publisherPlatform: string[];
  imageUrl: string | null;
  currency: string | null;
  startDate: string | null; // ISO, or null
  endDate: string | null; // ISO, or null
  isActive: boolean;
  runtimeDays: number;
  categories: string[];
  adLibraryUrl: string | null;
  winningScore: number;
}

export interface IngestOptions {
  /** "Now" for the active-ad runtime calculation. Injectable so tests are stable. */
  now?: Date;
  /** The niche this batch belongs to. Half of the dedup/upsert key. */
  niche?: string;
}

// ---------------------------------------------------------------------------
// SCORE DESIGN. Exported so tests and any UI "why this scored what it did" copy
// reference the same numbers.
// ---------------------------------------------------------------------------

/** Six months of continuous spend = a fully proven winner; runtime saturates here. */
export const RUNTIME_SATURATION_DAYS = 180;
/** ~8 concurrent variants = an advertiser clearly scaling; variant signal saturates here. */
export const VARIANT_SATURATION = 8;
/** Longevity is the more reliable signal... */
export const RUNTIME_WEIGHT = 0.7;
/** ...and scaling is the corroborating one. The two weights sum to 1. */
export const VARIANT_WEIGHT = 0.3;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * The winning score, 0..100, from the two public signals. A pure function of its
 * inputs and nothing else, so it is fully reproducible and testable.
 */
export function winningScore(input: { runtimeDays: number; variantCount: number }): number {
  const runtimeComponent = clamp01(input.runtimeDays / RUNTIME_SATURATION_DAYS);
  const variantComponent = clamp01((input.variantCount - 1) / (VARIANT_SATURATION - 1));
  const raw = 100 * (RUNTIME_WEIGHT * runtimeComponent + VARIANT_WEIGHT * variantComponent);
  return Math.round(raw);
}

// ---------------------------------------------------------------------------
// FILTERS.
// ---------------------------------------------------------------------------

/**
 * Calls to action that are brand/community/app actions, not a treatment offer. An
 * ad asking you to join a Facebook group or like a page is not a winning dental
 * lead ad to model, however long it has run, so it never enters the library. (The
 * dental-tourism CTAs BOOK_TRAVEL / GET_QUOTE are deliberately NOT here: those are
 * real competitor lead ads.)
 */
export const IRRELEVANT_CTA_TYPES = new Set<string>([
  "JOIN_GROUP",
  "LIKE_PAGE",
  "PAGE_LIKE",
  "VIEW_INSTAGRAM_PROFILE",
  "VISIT_PROFILE",
  "INSTALL_MOBILE_APP",
  "EVENT_RSVP",
  "NO_BUTTON",
  "GET_DIRECTIONS",
]);

/** A dynamic-catalogue template placeholder like {{product.brand}}: unusable copy. */
export function hasTemplatePlaceholder(text: string): boolean {
  return /\{\{[^}]*\}\}/.test(text);
}

/** The minimum real-copy length for an ad to be worth keeping as a copy reference. */
export const MIN_BODY_LENGTH = 20;

function bodyText(item: ApifyAdItem): string {
  return (item.snapshot?.body?.text ?? "").trim();
}

/**
 * Whether a raw row is a real, keepable dental ad. Applied to rows BEFORE grouping,
 * so a group survives on its keepable variants only, and a group all of whose
 * variants are junk disappears entirely.
 */
export function isKeepable(item: ApifyAdItem): boolean {
  const body = bodyText(item);
  if (body.length < MIN_BODY_LENGTH) return false;
  if (hasTemplatePlaceholder(body)) return false;
  const cta = (item.snapshot?.cta_type ?? "").trim().toUpperCase();
  if (cta && IRRELEVANT_CTA_TYPES.has(cta)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// KEYWORD (treatment) CLASSIFIER. Deterministic keyword match over the ad's own
// copy; first match wins, order = most specific first. Default is broad. This is
// the `keyword` column the library filters by, not a claim about the ad.
// ---------------------------------------------------------------------------

const KEYWORD_RULES: { keyword: string; re: RegExp }[] = [
  { keyword: "dental-implants", re: /\b(implant|implants|all[ -]?on[ -]?(4|4x|6|four|six)|full[ -]?(jaw|mouth|arch)|teeth[ -]?in[ -]?a[ -]?day)\b/i },
  { keyword: "clear-aligners", re: /\b(invisalign|clear ?aligners?|aligners?|clearcorrect|spark aligners?)\b/i },
  { keyword: "veneers", re: /\b(veneers?|composite bonding|bonding|hollywood smile|smile ?makeover|smile ?design)\b/i },
  { keyword: "teeth-whitening", re: /\b(whitening|whiten|teeth ?whitening)\b/i },
  { keyword: "dentures", re: /\b(dentures?|false teeth|snap[ -]?in)\b/i },
  { keyword: "crowns-bridges", re: /\b(crowns?|bridges?|zirconia|emax|e[ -]?max|laminate)\b/i },
  { keyword: "orthodontics", re: /\b(braces|orthodontic|orthodontics|fixed brace)\b/i },
  { keyword: "root-canal", re: /\b(root canal|endodontic|endodontics)\b/i },
  { keyword: "hygiene", re: /\b(hygiene|hygienist|airflow|scale and polish|gum (disease|health)|periodontal)\b/i },
  { keyword: "checkup", re: /\b(check ?up|check-?up|examination|new patient|dental exam|free consultation)\b/i },
];

export function deriveKeyword(text: string): string {
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(text)) return rule.keyword;
  }
  return "general-dentistry";
}

// ---------------------------------------------------------------------------
// DATES + RUNTIME.
// ---------------------------------------------------------------------------

/** Parse the scraper's "YYYY-MM-DD HH:MM:SS" (UTC) into a Date, or null. */
export function parseAdDate(raw: string | null | undefined): Date | null {
  if (!raw || typeof raw !== "string") return null;
  const iso = raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
}

/**
 * How long an ad has run, in whole days. For an active ad the end is "now" (it is
 * still running); for a finished ad it is its stored end date. Missing/invalid
 * dates yield 0, never a negative or a guess.
 */
export function runtimeDaysFor(
  item: ApifyAdItem,
  now: Date,
): { runtimeDays: number; start: Date | null; end: Date | null } {
  const start = parseAdDate(item.start_date_formatted);
  if (!start) return { runtimeDays: 0, start: null, end: null };
  const active = Boolean(item.is_active);
  const storedEnd = parseAdDate(item.end_date_formatted);
  const end = active ? now : storedEnd ?? now;
  return { runtimeDays: daysBetween(start, end), start, end };
}

// ---------------------------------------------------------------------------
// DEDUP KEY + GROUPING.
// ---------------------------------------------------------------------------

function normalizeBody(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * The identity a creative is grouped and upserted by. All variants of a scaled ad
 * share a collation id, so that is the key when present; otherwise page + body is a
 * stable stand-in so the same creative always maps to the same row.
 */
export function dedupKeyFor(item: ApifyAdItem): string {
  const cid = (item.collation_id ?? "").trim();
  if (cid) return `c:${cid}`;
  const page = (item.page_id ?? item.snapshot?.page_name ?? "").trim();
  return `p:${page}|b:${normalizeBody(bodyText(item))}`;
}

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Pick the representative variant of a group: longest-running, then active, then most variants. */
function pickRepresentative(rows: ApifyAdItem[], now: Date): ApifyAdItem {
  return [...rows].sort((a, b) => {
    const ra = runtimeDaysFor(a, now).runtimeDays;
    const rb = runtimeDaysFor(b, now).runtimeDays;
    if (rb !== ra) return rb - ra;
    const aa = a.is_active ? 1 : 0;
    const ab = b.is_active ? 1 : 0;
    if (ab !== aa) return ab - aa;
    if (num(b.collation_count) !== num(a.collation_count)) return num(b.collation_count) - num(a.collation_count);
    return String(a.ad_archive_id ?? "").localeCompare(String(b.ad_archive_id ?? ""));
  })[0];
}

function representativeImage(snapshot: ApifySnapshot | null | undefined): string | null {
  if (!snapshot) return null;
  const img = snapshot.images?.find((i) => i?.resized_image_url || i?.original_image_url);
  if (img) return img.resized_image_url ?? img.original_image_url ?? null;
  const vid = snapshot.videos?.find((v) => v?.video_preview_image_url);
  if (vid?.video_preview_image_url) return vid.video_preview_image_url;
  return snapshot.page_profile_picture_url ?? null;
}

// ---------------------------------------------------------------------------
// THE PIPELINE.
// ---------------------------------------------------------------------------

/**
 * Map one deduplicated GROUP of raw rows to a single scored library entry.
 * Exported for the test; `ingestAds` is the normal entry point.
 */
export function groupToWinningAd(rows: ApifyAdItem[], niche: string, now: Date): WinningAd {
  const rep = pickRepresentative(rows, now);
  const snapshot = rep.snapshot ?? null;

  // Runtime spans the whole concept: earliest any variant started to the latest any
  // finished (or now, while any variant is still live). One long-running variant
  // proves the creature has legs even if a newer variant of it is only days old.
  let earliestStart: Date | null = null;
  let latestEnd: Date | null = null;
  let anyActive = false;
  let maxCollation = 0;
  for (const r of rows) {
    const { start, end } = runtimeDaysFor(r, now);
    if (start && (!earliestStart || start < earliestStart)) earliestStart = start;
    if (end && (!latestEnd || end > latestEnd)) latestEnd = end;
    if (r.is_active) anyActive = true;
    maxCollation = Math.max(maxCollation, num(r.collation_count));
  }
  const end = anyActive ? now : latestEnd ?? now;
  const runtimeDays = earliestStart ? daysBetween(earliestStart, end) : 0;

  // The scaling signal: the Ad Library's own collation count, or the number of rows
  // we actually saw sharing this group, whichever is larger. Never below 1.
  const variantCount = Math.max(1, maxCollation, rows.length);

  const body = (snapshot?.body?.text ?? "").trim() || null;
  const title = (snapshot?.title ?? "").trim() || null;
  const keyword = deriveKeyword(`${title ?? ""} ${body ?? ""}`);

  return {
    niche,
    keyword,
    dedupKey: dedupKeyFor(rep),
    collationId: (rep.collation_id ?? "").trim() || null,
    adArchiveId: (rep.ad_archive_id ?? "").trim() || null,
    collationCount: typeof rep.collation_count === "number" ? rep.collation_count : maxCollation || null,
    variantCount,
    pageName: (rep.page_name ?? snapshot?.page_name ?? "").trim() || null,
    pageId: (rep.page_id ?? "").trim() || null,
    title,
    bodyText: body,
    ctaText: (snapshot?.cta_text ?? "").trim() || null,
    ctaType: (snapshot?.cta_type ?? "").trim() || null,
    linkUrl: (snapshot?.link_url ?? "").trim() || null,
    displayFormat: (snapshot?.display_format ?? "").trim() || null,
    publisherPlatform: Array.isArray(rep.publisher_platform)
      ? rep.publisher_platform.filter((p): p is string => typeof p === "string")
      : [],
    imageUrl: representativeImage(snapshot),
    currency: (rep.currency ?? "").trim() || null,
    startDate: earliestStart ? earliestStart.toISOString() : null,
    endDate: anyActive ? null : latestEnd ? latestEnd.toISOString() : null,
    isActive: anyActive,
    runtimeDays,
    categories: Array.isArray(rep.categories)
      ? rep.categories.filter((c): c is string => typeof c === "string")
      : [],
    adLibraryUrl: (rep.ad_library_url ?? "").trim() || null,
    winningScore: winningScore({ runtimeDays, variantCount }),
  };
}

/**
 * The full pipeline: filter out the pollution, deduplicate by creative, score each
 * entry, and return them ranked best-first. The caller slices the top N.
 *
 * Ranking ties (many proven ads saturate the runtime term) break on raw runtime,
 * then variant count, then the dedup key, so the order is fully deterministic and a
 * re-run produces the same library.
 */
export function ingestAds(items: ApifyAdItem[], opts: IngestOptions = {}): WinningAd[] {
  const now = opts.now ?? new Date();
  const niche = opts.niche ?? "uk-dental";

  const groups = new Map<string, ApifyAdItem[]>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (!isKeepable(item)) continue;
    const key = dedupKeyFor(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }

  const ads = [...groups.values()].map((rows) => groupToWinningAd(rows, niche, now));

  ads.sort((a, b) => {
    if (b.winningScore !== a.winningScore) return b.winningScore - a.winningScore;
    if (b.runtimeDays !== a.runtimeDays) return b.runtimeDays - a.runtimeDays;
    if (b.variantCount !== a.variantCount) return b.variantCount - a.variantCount;
    return a.dedupKey.localeCompare(b.dedupKey);
  });

  return ads;
}
