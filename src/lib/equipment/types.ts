/**
 * The equipment module's domain types.
 *
 * THE REGISTER IS A CQC/INSURANCE ARTEFACT FIRST AND AN AGENT'S CONTEXT SECOND.
 * The fields are the ones a practice's existing equipment register already holds
 * — the thing an inspector asks to see and an insurer asks for after a flood —
 * so that importing the spreadsheet the practice keeps today is a straight
 * mapping rather than a re-keying exercise. Nothing clinical, nothing about a
 * patient, and nothing about a member of staff lives here.
 */

/**
 * The register's category vocabulary.
 *
 * A CLOSED list, mirrored by a CHECK constraint in migration 0098, because the
 * category is what the register is filtered and counted by: "Autoclave",
 * "autoclaves" and "Steriliser" as three free-text values make a register that
 * cannot answer "show me every steriliser". The CSV importer maps the practice's
 * own words onto these and falls back to `other` rather than inventing a
 * category (see csv.ts).
 */
export const ASSET_CATEGORIES = [
  "sterilisation",
  "imaging",
  "surgery",
  "handpieces",
  "compressed_air_suction",
  "water",
  "it_hardware",
  "facilities",
  "emergency",
  "other",
] as const;

export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

/** Owner-facing labels. One place, so the table, the filters and the agent agree. */
export const CATEGORY_LABELS: Record<AssetCategory, string> = {
  sterilisation: "Sterilisation & decontamination",
  imaging: "Imaging & radiography",
  surgery: "Surgery equipment",
  handpieces: "Handpieces & instruments",
  compressed_air_suction: "Compressor & suction",
  water: "Water & waterlines",
  it_hardware: "IT hardware",
  facilities: "Building & facilities",
  emergency: "Emergency & resuscitation",
  other: "Other",
};

export interface EquipmentAsset {
  id: string;
  clientId: string;
  /** Internal site id (`site-cc` etc). Null = practice-wide / not stated. */
  siteId: string | null;
  name: string;
  category: AssetCategory;
  make: string | null;
  model: string | null;
  serial: string | null;
  /** Surgery, decon room, plant room — wherever the practice says it lives. */
  room: string | null;
  supplier: string | null;
  /** The number to ring when the manual's troubleshooting runs out. */
  supplierPhone: string | null;
  /** ISO date (YYYY-MM-DD) or null. Never a guess — see csv.ts on date parsing. */
  purchasedOn: string | null;
  lastServicedOn: string | null;
  nextServiceDue: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What a create/update accepts. Ids, timestamps and tenancy are server-set. */
export type AssetInput = Omit<EquipmentAsset, "id" | "clientId" | "createdAt" | "updatedAt">;

/**
 * One uploaded manual, per asset.
 *
 * THE BYTES ARE NOT KEPT. Only the extracted text is, in `EquipmentManualChunk`.
 * Two reasons, both deliberate: a manufacturer's manual is their copyright and
 * re-hosting the whole PDF for download is a different act from indexing its text
 * so staff can be told what it says; and storing bytes would need a new private
 * Storage bucket, which in this platform is provisioned out of band (see
 * migration 0076's note on the `onboarding` bucket) and would make ingestion
 * fail in any environment where nobody had created it. If the practice later
 * wants the original back, that is a bucket and a signed-URL read — a separate,
 * owner-agreed change, not something to do by accident.
 */
export interface EquipmentManual {
  id: string;
  assetId: string;
  clientId: string;
  filename: string;
  byteSize: number;
  pageCount: number;
  /** Which extractor produced the text, so a future swap is traceable in the data. */
  extractor: string;
  /** Characters of text recovered. Zero means a scanned/image-only PDF. */
  extractedChars: number;
  /** `ready` = searchable text stored. `no_text` = the PDF carried none (a scan). */
  status: "ready" | "no_text";
  uploadedAt: string;
}

export interface EquipmentManualChunk {
  id: string;
  manualId: string;
  assetId: string;
  clientId: string;
  /** 1-based page span this chunk came from, so an answer can cite a page. */
  pageFrom: number;
  pageTo: number;
  ordinal: number;
  body: string;
}

/** The catalog slug + system-toggle slug for the equipment agent. */
export const EQUIPMENT_SLUG = "equipment";

/**
 * THE BOUND EVERY REGISTER READ IS SUBJECT TO, stated where the PURE code can
 * see it.
 *
 * `repository.ts` owns the read and declares the same number as `ASSET_ROW_CAP`;
 * this copy exists because the two things that have to KNOW about the bound —
 * the system prompt and the tool results — must not import a `server-only`
 * module (the equipment route's test mocks the repository wholesale, so an
 * import of the cap from there would silently resolve to `undefined` and the
 * honesty below would evaporate without a single test going red).
 *
 * The two are pinned equal by a named test that reads the repository's source:
 * `prompt.test.ts`, "the prompt's bound is the REPOSITORY's bound, read out of
 * its source", the same way `os-band.test.ts` pins its own mock. Raise one and
 * the other goes red.
 *
 * WHY ANY OF THIS MATTERS. A count taken off a capped read is not a total, and
 * a register at its bound must say "at least N" rather than wear a complete
 * number's clothes (programme ruling W3/11). The failure it prevents is
 * specific: a practice past the cap being told it has exactly this many assets,
 * and being told a machine in the unread tail is not registered at all.
 */
export const REGISTER_READ_CAP = 400;

/**
 * THE SAME BOUND, FOR ONE MANUAL'S PASSAGES. Mirrors `CHUNK_ROW_CAP` in
 * `repository.ts` and exists here for the identical reason: `tools.ts` must know
 * whether the read it was handed was cut short, and it cannot learn the number
 * from a `server-only` module its own test mocks wholesale.
 *
 * WHY IT MATTERS MORE HERE THAN FOR THE REGISTER. When the register is capped
 * the desk says "at least N". When a MANUAL read is capped and nothing ranks,
 * `search_manual`'s note is "The manual does not cover this. Say so plainly and
 * do not answer from general knowledge" — an affirmatively false statement about
 * the practice's own uploaded document, made about a fault code that is printed
 * on page 361 of the book in the drawer. So a capped manual read swaps that
 * sentence for one that says which part was searched.
 *
 * Pinned equal to the repository's literal by a named test that reads its
 * source: `tools.test.ts`, "the manual bound is the REPOSITORY's bound, read out
 * of its source", and pinned below PostgREST's ceiling by "every equipment read
 * cap sits below PostgREST's own row ceiling" in the same file.
 */
export const MANUAL_CHUNK_READ_CAP = 900;
