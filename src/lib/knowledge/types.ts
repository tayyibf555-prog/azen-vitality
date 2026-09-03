/**
 * APPROVED AUTHORITIES — domain types.
 *
 * An approved authority is an EXTERNAL source the practice owner has decided the
 * co-pilot may lean on: the GDC's standards, a faculty guideline, a textbook, a
 * course the principal sat. The row is NOT the source. It is the practice's OWN
 * summary of that source and the principles the practice takes from it, plus a
 * citation string so a reader can go and find the original for themselves.
 *
 * THREE THINGS THIS DELIBERATELY IS NOT, because each one is a different product
 * and each would need its own decision:
 *
 *   1. NOT internet access. `reference` is stored as text and never fetched. The
 *      platform has no live browsing and this seam does not add any: a URL here
 *      is a citation the same way an ISBN is, something a human follows.
 *   2. NOT ingestion of the work. `summary` and `principles` are the owner's own
 *      words, size-capped (see AUTHORITY_BODY_MAX_CHARS in ./authorities) so that
 *      transcribing a copyrighted book into this table is structurally impossible
 *      rather than merely discouraged.
 *   3. NOT a clinical authority. Nothing here overrules the practice's own
 *      records, and the co-pilot cites which authority informed an answer rather
 *      than presenting it as the platform's own knowledge.
 *
 * THE DEFAULT IS AN EMPTY LIST, and an empty list must contribute NOTHING to any
 * prompt (`authoritiesBrief` returns ""). "Practice data only" is not a setting
 * somebody has to choose; it is what the platform does until an owner deliberately
 * adds a source.
 *
 * Distinct from `src/lib/practice-brain/*`, which holds the practice's INTERNAL
 * knowledge tree with its own clearance tiers. That is what the practice knows;
 * this is who the practice trusts.
 */

/**
 * What kind of thing the source is. A small closed union on purpose: the value
 * appears in the citation and in the prompt brief, so a free-text field here
 * would let a typo ("regulaor") read to the model as a category of its own.
 *
 * Mirrored by a CHECK constraint in supabase/migrations/0100_approved_authorities.sql,
 * so the set is enforced in the code and in the database rather than in one of them.
 */
export const AUTHORITY_KINDS = [
  "regulator",
  "professional-body",
  "guideline",
  "textbook",
  "course",
  "internal-policy",
  "other",
] as const;

export type AuthorityKind = (typeof AUTHORITY_KINDS)[number];

/** Human labels for the kinds, for the owner's panel and the prompt brief. */
export const AUTHORITY_KIND_LABELS: Record<AuthorityKind, string> = {
  regulator: "Regulator",
  "professional-body": "Professional body",
  guideline: "Guideline",
  textbook: "Textbook",
  course: "Course",
  "internal-policy": "Internal policy",
  other: "Other",
};

/**
 * `archived` rather than deleted: an answer the co-pilot gave last month cited an
 * authority, and a hard delete would make that citation unreadable. Archived rows
 * stay visible to the owner and are excluded from every prompt.
 */
export type AuthorityStatus = "active" | "archived";

export interface ApprovedAuthority {
  id: string;
  clientId: string;
  /** e.g. "Standards for the Dental Team". */
  name: string;
  kind: AuthorityKind;
  /** Who publishes it, e.g. "General Dental Council". May be blank. */
  publisher: string;
  /**
   * A citation string — a URL, an ISBN, an edition and page range. STORED AS TEXT
   * AND NEVER FETCHED. See the header: this seam adds no internet access.
   */
  reference: string;
  /** The owner's OWN summary of the source. Never the source's text. */
  summary: string;
  /** The owner's OWN distilled principles taken from the source. */
  principles: string;
  status: AuthorityStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
