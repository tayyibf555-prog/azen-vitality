# CHARTING.md — FDI Charting Screen: Engineering Reference

Synthesised from seven parallel research passes (notation/conversion, surfaces, clinical
workflow, perio/BPE, NHS/FP17, competitor UX, legal/safety-record) plus the existing codebase
(`src/lib/charting/fdi.ts`, `src/lib/charting/fdi.test.ts`, `src/lib/dentally/charting-read.ts`)
and `DENTALLY.md`. Written for engineers implementing or extending the chart, not as prose to be
read once. Skip to the section you need; do not assume earlier sections are prerequisite reading.

Status of the underlying facts: this is a **READ-ONLY mirror** of Dentally, for 4 UK sites /
~49,400 active patients, on top of an API that stores teeth in **Palmer notation** and has
**no periodontal/BPE data at all**. Dentists make treatment decisions from what this screen
renders. Clinical correctness outranks visual polish, always.

---

## 1. READ THIS FIRST — the facts that cause a serious bug if you get them wrong

1. **Dentally's `teeth` field is Palmer, not FDI — and the actual wire format has never been
   observed.** The docs say "all teeth are stored using Palmer notation" but no example JSON
   payload exists anywhere public. The current codebase (`fdi.ts::parseTeeth`) only accepts
   bare/FDI-shaped numbers and its own test suite proves it **rejects** Palmer text like `"UR6"**.
   If the real wire shape turns out to be Palmer text, every real chart row currently comes back
   `unparsed: true`. **Do not treat this as solved. Run the live probe in §9 before this touches a
   real patient.** See §2 and §9.
2. **FDI, Palmer and Universal all reuse the same digits/letters for different teeth.** FDI `11`
   = upper right central incisor. Universal `11` = upper left canine. Palmer position digits mean
   premolars in the permanent set and molars in the deciduous set (§2.5, trap #2). Never print a
   bare two-digit number anywhere a human reads it without saying which system it is and which
   tooth it names in words. This is not a style rule — it is the exact mechanism named in the
   national HSSIB investigation into wrong-tooth extraction (§8).
3. **Molars use an 8-region surface scheme; everything else uses 5.** A five-trapezoid grid is
   correct for incisors, canines, premolars and ALL deciduous teeth (including deciduous molars —
   Dentally buckets those with the simple scheme even though they have four cusps). Rendering a
   permanent molar with 5 regions silently drops 3 chartable surfaces: a real restoration in
   Dentally would not appear on our chart at all. Tooth type must drive the diagram geometry.
   **The exact index→surface mapping for both schemes is NOT independently verified** — see §3.
4. **The chart mirrors — patient's right is drawn on the viewer's left, always, both arches.**
   This is not a rendering choice, it's the whole-industry orientation convention, and it's the
   direct analogue of the systemic gap that got wrong-tooth extraction removed from the NHS Never
   Events list in 2021. `fdi.ts::sideOf`/`archOf` already implement this correctly — any second
   renderer (print, PDF export, a future mirrored view) MUST reuse it, never re-derive it.
5. **Silence on this chart is a clinical claim, and it is often the wrong one.** No periodontal
   data exists in the Dentally API at all (§6). An empty periodontal section reads to a busy
   clinician as "nothing wrong", not "data not available" — this is a named, quantified hazard
   (§6, §8), not a cosmetic gap. The same applies to a failed/partial sync: never render a
   plausible-looking chart from incomplete data. Say what failed, loudly.

---

## 2. Tooth notation — Palmer, FDI, Universal

### 2.1 What each system actually is

- **Palmer**: quadrant (`UR`/`UL`/`LL`/`LR`, patient's own right/left) + position counted outward
  from the midline. Permanent position = digit `1–8`. Deciduous position = letter `A–E`. The
  bracket-glyph form (Zsigmondy cross, Unicode `U+23BE`/`U+23BF`/`U+23CB`/`U+23CC`) is a
  typographic curiosity with inconsistent real-world rendering — **do not parse or render against
  those code points**. The plain-text ASCII convention (`UR6`, `LL8`, `URE`) is what UK software
  and paper notes actually use, and is what any Palmer-text parser should target. A secondary
  slash form (`3/` = upper-right 3, `/5` = upper-left 5) may appear in free text but not in
  structured fields.
- **FDI (ISO 3950:2016)**: two digits, no zero. First digit = quadrant + dentition (`1–4`
  permanent, `5–8` deciduous, clockwise from upper right). Second digit = position from the
  midline (`1–8` permanent, `1–5` deciduous). Always read/spoken digit-by-digit ("three-six", never
  "thirty-six") — this is in the standard itself, and it's a deliberate defence against confusing
  FDI with Universal or a quantity.
- **Universal (ADA, US)**: one continuous count, `1–32` permanent (upper-right 3rd molar = 1,
  around to lower-right 3rd molar = 32), `A–T` deciduous. **Not quadrant+position — there is no
  arithmetic shortcut to or from FDI/Palmer.** Any Universal conversion must be table-driven,
  never formula-derived, because the counting direction reverses at the midline in FDI/Palmer but
  runs monotonically all the way round in Universal.
- Codes containing a zero (`00`, `10`, `20`...) are ISO 3950 **area/quadrant codes**, not teeth —
  a numeric-quadrant field from Dentally's `region` should never be assumed to be a tooth number.

### 2.2 Master conversion table — permanent dentition (32 teeth)

| FDI | Palmer | Universal | Tooth |
|---|---|---|---|
| 18 | UR8 | 1 | Upper right third molar |
| 17 | UR7 | 2 | Upper right second molar |
| 16 | UR6 | 3 | Upper right first molar |
| 15 | UR5 | 4 | Upper right second premolar |
| 14 | UR4 | 5 | Upper right first premolar |
| 13 | UR3 | 6 | Upper right canine |
| 12 | UR2 | 7 | Upper right lateral incisor |
| 11 | UR1 | 8 | Upper right central incisor |
| 21 | UL1 | 9 | Upper left central incisor |
| 22 | UL2 | 10 | Upper left lateral incisor |
| 23 | UL3 | 11 | Upper left canine |
| 24 | UL4 | 12 | Upper left first premolar |
| 25 | UL5 | 13 | Upper left second premolar |
| 26 | UL6 | 14 | Upper left first molar |
| 27 | UL7 | 15 | Upper left second molar |
| 28 | UL8 | 16 | Upper left third molar |
| 38 | LL8 | 17 | Lower left third molar |
| 37 | LL7 | 18 | Lower left second molar |
| 36 | LL6 | 19 | Lower left first molar |
| 35 | LL5 | 20 | Lower left second premolar |
| 34 | LL4 | 21 | Lower left first premolar |
| 33 | LL3 | 22 | Lower left canine |
| 32 | LL2 | 23 | Lower left lateral incisor |
| 31 | LL1 | 24 | Lower left central incisor |
| 41 | LR1 | 25 | Lower right central incisor |
| 42 | LR2 | 26 | Lower right lateral incisor |
| 43 | LR3 | 27 | Lower right canine |
| 44 | LR4 | 28 | Lower right first premolar |
| 45 | LR5 | 29 | Lower right second premolar |
| 46 | LR6 | 30 | Lower right first molar |
| 47 | LR7 | 31 | Lower right second molar |
| 48 | LR8 | 32 | Lower right third molar |

### 2.3 Master conversion table — deciduous dentition (20 teeth)

| FDI | Palmer | Universal | Tooth |
|---|---|---|---|
| 55 | URE | A | Upper right second (primary) molar |
| 54 | URD | B | Upper right first (primary) molar |
| 53 | URC | C | Upper right (primary) canine |
| 52 | URB | D | Upper right (primary) lateral incisor |
| 51 | URA | E | Upper right (primary) central incisor |
| 61 | ULA | F | Upper left (primary) central incisor |
| 62 | ULB | G | Upper left (primary) lateral incisor |
| 63 | ULC | H | Upper left (primary) canine |
| 64 | ULD | I | Upper left first (primary) molar |
| 65 | ULE | J | Upper left second (primary) molar |
| 75 | LLE | K | Lower left second (primary) molar |
| 74 | LLD | L | Lower left first (primary) molar |
| 73 | LLC | M | Lower left (primary) canine |
| 72 | LLB | N | Lower left (primary) lateral incisor |
| 71 | LLA | O | Lower left (primary) central incisor |
| 81 | LRA | P | Lower right (primary) central incisor |
| 82 | LRB | Q | Lower right (primary) lateral incisor |
| 83 | LRC | R | Lower right (primary) canine |
| 84 | LRD | S | Lower right first (primary) molar |
| 85 | LRE | T | Lower right second (primary) molar |

Cross-verified against the ISO 3950:2016 primary text, FGDP(UK) Appendix 14A/14B, three
independent secondary sources, and the existing `fdi.ts` arrays — all agree without exception.
This table (52 rows total) is what any Universal-conversion function and any Palmer-text parser
must be tested against **exhaustively**, not sampled.

### 2.4 Conversion logic, ready to transcribe

**Palmer ↔ FDI (near-arithmetic):**
```
quadrantIndex: { UR: 0, UL: 1, LL: 2, LR: 3 }

Permanent (Palmer position is digit 1-8):
  fdiQuadrantDigit = quadrantIndex + 1        // 1,2,3,4
  fdi = fdiQuadrantDigit * 10 + positionDigit
  // reverse:
  positionDigit = fdi % 10
  quadrantIndex = Math.floor(fdi / 10) - 1

Deciduous (Palmer position is letter A-E):
  fdiQuadrantDigit = quadrantIndex + 5        // 5,6,7,8
  positionDigit = charCode(letter) - charCode('A') + 1   // A=1..E=5
  fdi = fdiQuadrantDigit * 10 + positionDigit
  // reverse:
  letter = fromCharCode(charCode('A') + (fdi % 10) - 1)
  quadrantIndex = Math.floor(fdi / 10) - 5

Dentition test: fdi tens digit 1-4 => permanent, 5-8 => deciduous.
```

**Universal ↔ FDI/Palmer**: **no formula exists.** Use the §2.2/§2.3 tables directly, both
directions, 52 rows. Do not attempt to derive it algebraically — the counting direction flips at
the midline in FDI/Palmer but not in Universal, which is exactly the kind of "clever" shortcut
that introduces a silent off-by-one.

### 2.5 Named traps (all confirmed independently, not hypothetical)

1. **FDI/Universal digit collision** — same two characters, different tooth, depending on
   system. Never print a bare number without stating the system.
2. **Deciduous digit-4/5 meaning shift** — FDI permanent `4`/`5` = premolars; FDI deciduous `4`/`5`
   = first/second molar (no deciduous premolars exist). Two separate lookup tables, or one keyed
   by `(dentition, digit)` — never one keyed by digit alone.
3. **Quadrant tooth-count is not uniform** — permanent quadrants hold 8 teeth, deciduous hold 5.
   A range check that accepts "any digit 1–8 in any quadrant" will accept nonexistent teeth like
   `56`–`58`. `fdi.ts`'s explicit `ALL_TEETH` set already guards this correctly — do not
   "simplify" it into a range check.
4. **The mirror trap (highest stakes)** — patient's right tooth draws on the viewer's left, both
   arches, always. Reuse `fdi.ts::sideOf`/`archOf` in every renderer; never re-derive.
5. **Quadrant must derive from the tooth's own FDI digits, never from screen position** —
   `quadrantOf(fdi) = Math.floor(fdi/10)` is already correct; don't let a future print/mixed-view
   layout infer quadrant from "which half of the screen this is currently drawn in".
6. **Ambiguous partial Palmer text** — `"R6"` or `"6"` alone (missing arch or side) is genuinely
   ambiguous, not "close enough". Treat as `unparsed`, same as a fully unrecognised token — never
   silently guess.
7. **Reading FDI as a "teen" number** — `36` read as "thirty-six" invites confusion with
   Universal or a quantity. Any spoken/aria-label context should use `toothLongLabel()` ("lower
   right 6"), never the raw digits read as one number.

### 2.6 RESOLVED — the wire format, observed against live production data

**No longer unverified.** Probed 2026-08-02 against `https://api.dentally.co/v1/treatment_plan_items`,
500 real plan items across 5 pages, using `DENTALLY_PROD_READONLY_API_KEY`. The result is
possibility **(a)**: literal Palmer text.

```
teeth      array of STRINGS   e.g. ["UR6"], ["LL3"], ["ULA"]
           format             [U|L] [R|L] [1-8 | A-E]
           quadrant prefixes  UR, UL, LR, LL   (exactly these four, nothing else)
           position tokens    1 2 3 4 5 6 7 8  (permanent)
                              A B C D E        (deciduous)
surfaces   array of INTEGERS  (the docs are right; they are not strings)
region     one of: tooth, patient, surface, toothCoordinate, site, item
base_chart boolean, and ~49% of live items are true — the base chart is half the data
```

**Consequence: `fdi.ts::parseTeeth` as currently built rejects EVERY real row.** It accepts only
integers passing `isTooth()`, so `"UR6"` sets `unparsed: true` and yields no teeth. On live data the
chart renders empty. This is the single highest-priority fix in the build.

The parser must accept Palmer text as its PRIMARY form, keep integer/FDI input as a secondary form
(the local mock emits it), and continue to flag anything matching neither rather than guessing — an
ambiguous token must never be silently coerced to a tooth (§2.5, trap #2; §8).

**The 8-region molar scheme is confirmed by data, not just by the docs.** Maximum surface index
observed, grouped by tooth position:

| position | surfaces seen | max |
|---|---|---|
| 1 (central incisor) | 3, 5 | 5 |
| 2 (lateral incisor) | 5 | 5 |
| 4 (first premolar) | 4, 5 | 5 |
| 5 (second premolar) | 2, 5 | 5 |
| **6 (first molar)** | **3, 7, 8** | **8** |
| D (deciduous) | 4, 5 | 5 |

Molars reach 8; every other tooth type caps at 5, deciduous included. Tooth type must drive the
diagram geometry, exactly as §1 states.

> **Probing note for anyone repeating this.** A request without an acceptable `User-Agent` is
> rejected `403 "Request forbidden by administrative rules. Please make sure your request has an
> acceptable User-Agent header."` That is a User-Agent check, NOT an IP allowlist — send
> `User-Agent: Azen-Vitality/0.1 (+https://azen.ai)` and the key works from anywhere.

---

## 3. Surfaces

### 3.1 Anatomy (high confidence, safe to hard-code)

| Surface | Meaning | Applies to |
|---|---|---|
| Mesial | Nearest the arch midline | All teeth |
| Distal | Furthest from the arch midline | All teeth |
| Buccal | Facing the cheek | Posterior teeth (premolars, molars) |
| Labial | Facing the lips | Anterior teeth (incisors, canines) |
| Palatal | Facing the roof of the mouth | Upper teeth only |
| Lingual | Facing the tongue | Lower teeth only |
| Occlusal | Chewing/biting surface (a table) | Premolars, molars only |
| Incisal | Biting edge (a curved edge, not a table) | Incisors, canines only |
| Cervical | Zone nearest the gum line | All teeth — a reference zone, not a restorable "surface" |

**UK convention, not US**: palatal for upper teeth, lingual for lower teeth — never "lingual" for
both arches, never "facial" as an umbrella term, never "occlusal" on an incisor/canine (it has no
flat table, only an edge). This is what NEBDN examines UK dental nurses against; follow it in
every label.

Premolars have 5 surfaces (no deciduous premolars exist — deciduous molars occupy that arch
position). Molars have 5 anatomically-named surfaces but Dentally subdivides the occlusal table
further for permanent molars only (§3.3). A `surfaces` array of length > 1 on one
`treatment_plan_item` = one linked multi-surface restoration (MOD-style), not several separate
findings — corroborated by Dentally's own "join surfaces" UI behaviour and by NHS Scotland's
claim-coding convention.

### 3.2 What Dentally states, verbatim (the only primary source)

> "Surfaces are returned as numbers within an array. Surfaces are numbered 1-5 for incisors,
> canines, premolars and deciduous teeth and 1-8 for molar teeth. Surface numbering starts from
> the top left hand corner of the tooth and is counted clockwise around the edge of the tooth and
> into the center."

No public source — developer.dentally.co, help.dentally.com, the Dentally community forum,
GitHub, general web — documents the mapping beyond this one sentence. **Everything below this
line is reasoned inference, confidence-graded, not verified fact.**

### 3.3 The 5-scheme (structural split: high confidence; exact index mapping: low-moderate)

**Structure**: 4 peripheral surfaces (Mesial, Distal, Buccal/Labial, Palatal/Lingual) + 1 central
surface (Occlusal/Incisal). Independently corroborated by the NEBDN UK charting reference, which
draws exactly this "four triangles + one centre square" diagram for every quadrant.

Illustrative working hypothesis (reference tooth: upper-right), **confidence: low-to-moderate,
verify against real data before hard-coding**:

| Index | Position | Most probable surface |
|---|---|---|
| 1 | Top (start) | Buccal/Labial |
| 2 | Right | Mesial |
| 3 | Bottom | Palatal/Lingual |
| 4 | Left | Distal |
| 5 | Centre | Occlusal/Incisal |

### 3.4 The 8-scheme, permanent molars only (structural split: moderate confidence; exact index mapping: low)

Leading hypothesis: **4 peripheral surfaces (Mesial, Distal, Buccal, Palatal/Lingual) + 4 occlusal
quadrants matching the tooth's 4 functional cusps** (mesiobuccal, distobuccal, mesiolingual,
distolingual — real, universal molar anatomy, and exactly the vocabulary UK dentists already use
for cusp-level findings: onlays, cracked-cusp syndrome, cuspal fracture). Two different literal
readings of "clockwise from top-left... into the centre" both converge on this same 4+4
structure, which is why it's presented as the leading hypothesis rather than a coin flip — but
the **specific integer↔cusp mapping is not verified**:

| Index | Position (clockwise from top-left) | Most probable surface |
|---|---|---|
| 1 | Top-left corner | Distobuccal cusp |
| 2 | Top side | Buccal |
| 3 | Top-right corner | Mesiobuccal cusp |
| 4 | Right side | Mesial |
| 5 | Bottom-right corner | Mesiopalatal (mesiolingual) cusp |
| 6 | Bottom side | Palatal/Lingual |
| 7 | Bottom-left corner | Distopalatal (distolingual) cusp |
| 8 | Left side | Distal |

Genuinely important design fork, **not resolvable from public docs**: is the index→surface
mapping **anatomically fixed** (one static lookup table, mirrored only at render time) or
**screen-position fixed** (same index means mesial on a right-quadrant tooth, distal on a
left-quadrant tooth)? This changes the *shape* of the lookup function, not just its contents —
build for this to be verified, don't guess it into the type signature.

**Why deciduous molars stay in the 5-scheme despite having 4 cusps anatomically**: almost
certainly a deliberate product simplification (deciduous molars are exfoliating teeth; clinicians
rarely plan cusp-level restorations on them) — flag as a real, intentional Dentally design choice,
not a bug in your understanding.

### 3.5 Mirroring rule for rendering (independent of the index-mapping uncertainty above)

- **Buccal/Labial ↔ Palatal/Lingual flips vertically by arch**: buccal/labial toward the outer
  edge of the whole-mouth chart (top for upper teeth, bottom for lower teeth); palatal/lingual
  toward the inner edge (next to the midline).
- **Mesial ↔ Distal flips horizontally by side**: mesial always toward the chart's vertical
  midline; distal always away from it — independent of arch.
- **Occlusal/Incisal never mirrors** — rotation- and reflection-invariant, always centre.
- Implementation: one shape definition + two boolean props (`flipVertical` by arch, `flipHorizontal`
  by side) reproduces all four quadrant orientations correctly — two independent mirrors, not one.

### 3.6 Before writing any surfaces lookup table into production

Run an empirical pass against real charted data (the production read-only key exists — see §9):
pull `treatment_plan_item` rows where `teeth` includes molars and `surfaces` includes 6/7/8;
cross-reference against free-text `notes`/`nomenclature` for anatomical tells ("MOD amalgam",
"distobuccal cusp fracture", "onlay covering buccal cusps"); do this separately for
upper-right/upper-left and lower-right/lower-left molars to resolve the anatomically-fixed vs
screen-fixed question; sample non-molar teeth with values 1–5 the same way.

---

## 4. Chart states and tooth-status vocabulary

### 4.1 Three states, mapped directly onto Dentally's fields

| State | Clinical meaning | Dentally field mapping |
|---|---|---|
| Base chart | What is physically in the mouth right now — a snapshot, not a plan | `base_chart = true` |
| Planned / proposed | Dentist has proposed it; not yet done | `base_chart = false, completed = false` |
| Completed | Actually carried out; folds back into "existing dentition" | `completed = true`, has `completed_at` |

`charged` is a **separate financial state**, orthogonal to clinical state — never conflate it
with `completed` in UI logic. You cannot charge before completing, but a completed item is not
necessarily charged/invoiced yet.

**Base Chart is a distinct mode, not a layer inside active planning** — Dentally's own UI has a
separate Base Chart tab where the same treatment-list interaction edits baseline dentition
instead of an active plan. Multiple concurrent open treatment plans can exist (e.g. presenting two
options side-by-side); completed plans move to a filterable/searchable History. **Part-completion
is native, not an edge case** — each `treatment_plan_item` completes independently with its own
`completed_at`; a plan can sit indefinitely half-done.

**Do not lose the pre-completion snapshot.** FGDP flags this as a real, named defect class in
electronic dental records: once an item flips to `completed`, some systems auto-modify the chart
in place and lose the ability to reproduce "what was originally planned". Your chart must retain
and expose the plan's prior state, not just live current-state.

### 4.2 Tooth presence status (small closed set, gates what can be charted at all)

| Status | Meaning | Notes |
|---|---|---|
| Present | Normal, erupted, in place | The "reset" state |
| Missing | Not present, no reason specified | Removes tooth from both dental and perio chart |
| Unerupted | Exists but hasn't come through | Distinct from missing; reset to Present once it erupts |
| Partially erupted | Part of crown visible, rest submerged | Common in children/wisdom teeth |
| Extracted | Applied when an extraction treatment completes | Also wipes previously-charted icons on that tooth graphically (history stays visible separately) |
| Retained root | Root left in situ | Distinct from full extraction |
| Replaced | Position now occupied by an implant | Prerequisite: tooth must already be "missing" first |

### 4.3 Stackable annotations — NOT mutually exclusive with presence or each other

A tooth can be simultaneously present + crowned + root-filled + carrying a watch note. Model each
of these as an independent, co-occurring annotation, never as competing enum values:

- **Crown** — icon on a present tooth; doesn't change tooth-status.
- **Bridge** — multi-tooth: retainer/abutment teeth are present teeth with a retainer icon;
  pontic(s) sit over a **missing** position, shown as one linked unit.
- **Root-treated** — a treatment ("Fill Root"), rendered on a dedicated Root Chart view; stacks
  independently of presence/crown state.
- **Denture tooth** — not charted on the odontogram; the abutment positions are simply "missing",
  the denture itself is a separate prosthesis record.
- **Veneer** — condition/treatment icon, typically anterior, distinct from a crown (partial vs
  full coverage) — don't fold into "crown".
- **Sealant** — preventive icon at the occlusal-surface level, charted like a small restoration.
- **Impacted** — not a distinct tooth-status keyword found in any vendor doc; treat as a condition
  icon on an unerupted/partially-erupted tooth, not a fifth presence-state.
- **"Watch / monitor"** — ⚠️ **not a standardised status or symbol anywhere in UK sources
  checked** (FGDP, BSP, Dentally, vendor cheat-sheets). What FGDP actually describes is monitoring
  via *process* (serial photos/study models/radiographs over time), not a chart symbol.
  **Recommendation: implement as a clinical note + a review/recall-interval flag, not a
  mutually-exclusive enum state** — inventing a first-class "watch" status would be a confident,
  ungrounded design decision of exactly the kind this document exists to prevent.

---

## 5. Colour conventions

**RED = planned / needs treatment. BLUE (or black) = completed / existing.** This direction is
confirmed independently across every vendor with a documented convention checked (Dentrix
Ascend, XLDent, Open Dental, general UK/US teaching material) — no reversed example was found
anywhere. Dentrix Ascend goes further and makes this **non-configurable** specifically to protect
the convention from practice-level drift — a strong argument to treat this as a hard rule in our
build too, not a themeable token, given a dentist is making a clinical judgement from it.

- **Purple = referred out** to a specialist — a genuine third state some systems track
  separately from "planned" (Dentrix).
- **Light vs dark shade of the same colour** distinguishes *who* did the work (existing-by-this-
  practitioner vs existing-by-another) — useful here since multiple practitioners chart across 4
  sites.
- **Fill pattern, not colour alone, should encode status** — dotted = wear/abrasion, hatched =
  calculus/specific material, solid = active disease or completed, outline = planned. This
  colour+pattern double-encoding is a real accessibility requirement (colour-blind clinicians
  exist) at near-zero extra engineering cost.
- **Never colour-only.** Existing vs proposed vs done must never rely on colour as the sole
  channel — pair it with fill/outline style or an explicit label.

**The owner's screenshot showed yellow on six upper-anterior occlusal surfaces.** No vendor
documentation anywhere (including Dentally's own help centre) states a colour convention in
prose, and yellow appears in no other vendor's documented scheme. **Treat this as a
practice-specific/treatment-category tint (possibly a favourited category or a sealant colour),
not evidence of a reversed or third universal convention.** Do not build a yellow-based scheme
without a second screenshot showing a genuine mix of planned vs completed items in Dentally to
confirm.

**Standard symbol shapes** (near-universal, older than any software, carried over from paper
charts): X or line through the tooth = extracted/missing; circle around the tooth number =
scheduled for extraction; triangle at the root apex = root canal; zigzag = fracture.

**Interaction convention to preserve exactly (Dentally-parity, not a modernisation opportunity):**
**left-click charts the first surface; right-click adds further surfaces to the same tooth.**
This is the single most load-bearing, least-guessable mechanic on the screen. Other vendors use a
different gesture entirely (Open Dental/Curve: click-and-drag across surfaces) — these are
mutually exclusive muscle memories. Since staff are migrating **from** Dentally, build Dentally's
gesture, not whichever is "more modern" elsewhere.

---

## 6. Perio and BPE

### 6.1 What exists clinically (for context — none of this is in the Dentally API)

- **BPE (Basic Periodontal Examination)**: 6 sextants (UR 17–14, UA 13–23, UL 24–27, LR 47–44,
  LA 43–33, LL 34–37; sextant needs ≥2 teeth to qualify). WHO 621 probe, 0.5mm ball end, black
  band 3.5–5.5mm, light force (20–25g). Score per sextant = highest code found: `0` healthy,
  `1` bleeding, `2` calculus present, `3` pocket 3.5–5.5mm, `4` pocket >5.5mm, `*` furcation
  (additive, e.g. `"3*"`). Code 3 → 6-point chart of that sextant after initial therapy. Code 4 →
  full-mouth 6-point chart from the outset. BPE **cannot** be used to monitor treatment response —
  only a repeat 6-point chart can. Never used around implants.
- **Full 6-point perio charting** (triggered by BPE 3/4, or annually for anyone in periodontal
  maintenance): probing depth, recession, CAL (= depth + recession), bleeding on probing,
  suppuration, plaque score, mobility (Miller 0–III), furcation (Hamp I–III) — 6 sites/tooth.
- **2017/18 reclassification**: a periodontitis diagnosis is now Staged (I–IV, by bone
  loss/CAL/tooth loss) and Graded (A–C, by rate of progression, modified up — never down — by
  smoking/diabetes). None of this exists in Dentally's API surface either.
- BPE has been a **mandatory NHS FP17 claim field since 1 October 2022** — any dentist reading
  this chart will expect it and won't find it.

### 6.2 What we cannot get from the Dentally API — stated plainly

**No BPE resource, no periodontal-charting resource, no pocket depths, no bleeding index, no
furcation/mobility, no plaque score, no stage/grade — nothing.** This is not a permissions gap on
the read-only key; the API surface itself doesn't expose it (Dentally's own clinical UI does
capture all of this — it just isn't in the API).

### 6.3 The clinical consequence of showing that gap badly — this is the part that matters

Periodontitis is, by design, a **largely silent disease** until advanced — national UK data:
~37% of adults have moderate periodontitis, ~8% severe (scaled to this practice's ~49,400
patients: roughly 18,000 moderate, ~4,000 severe already sitting in this dataset). The chart,
not the patient's own complaint, is often the only thing standing between a dentist and a missed
diagnosis.

**The specific failure mode is not "missing data" — it is "false completeness".** A dentist
glancing at a page that faithfully renders teeth, restorations and treatment plans will
reasonably read the *whole page* as authoritative. If the periodontal section is simply absent —
no tab, no banner, nothing — the natural read in 20 seconds between patients is **"this patient
has no periodontal problems"**, which is functionally indistinguishable from a genuine BPE-0
result. Dentally's own UI has an explicit **red-dot "BPE overdue"** affordance specifically to
prevent this; a silent omission in our mirror is a strict regression on a safety affordance
clinicians are already trained to rely on.

Consequences named explicitly by BSP/GDC sources: an already-periodontitis-diagnosed patient
reads as clean; the annual-recharting obligation goes unnoticed with no reminder mechanism at
all; smoking/diabetes risk-grade modifiers are invisible in exactly the population where they
matter most; missed systemic-disease associations (cardiovascular, diabetes, adverse pregnancy
outcomes); and real medicolegal exposure — undiagnosed/untreated periodontal disease claims in the
UK are commonly cited in excess of £50,000, and "failure to carry out a BPE at least once every
year" is a specifically named allegation pattern in negligence claims.

**Mandatory design response**: the chart must **never render a periodontal section that looks
like an empty/clean result.** It must show an explicit, impossible-to-miss "Periodontal/BPE data
is not available in this view — check Dentally directly" state, functionally replacing (not
silently discarding) the "BPE due" affordance clinicians already rely on in Dentally itself.

---

## 7. NHS: FP17, UDA bands, and how charting feeds a claim

### 7.1 The claim mechanics

- **FP17** = the electronic claim for one course of treatment (COT) submitted via **Compass**
  (being migrated to NHSDSP — imminent as of Aug 2026, watch for this if any direct Compass/NHSDSP
  integration is ever built). The **Clinical Data Set (CDS)** inside it carries the actual
  clinical detail: Treatment Category codes (what was done) + Band (the UDA-weight bucket).
- **Band and Treatment Category are two required, independent axes** — without both, the
  treatment doesn't form part of the claim.

| Band | UDA | Covers |
|---|---|---|
| 1 | 1 | Exam, diagnosis, radiographs, scale & polish, prevention, fluoride, sealants |
| 2a | 3 | Other Band 2 restorative work |
| 2b | 5 | Non-molar endodontics on a permanent tooth, OR 3+ distinct teeth needing fillings/extraction combined |
| 2c | 7 | Molar endodontics on a permanent tooth |
| 3 | 12 | Lab-made items: crowns, bridges, dentures, inlays, veneers, custom occlusal appliances |
| Urgent | ~1.2 (rate under review — see below) | Defined urgent-care set only |
| Other/Band 0 | none | Denture/bridge repair, prescription-only, arrest of bleeding, suture removal — no NHS charge, no standard weighting |

**2a/2b/2c is counted by distinct tooth, not by row or surface** — a 3-surface filling on one
tooth still counts as one tooth toward the "3+ teeth" trigger. Get this wrong and any
"predicted band" preview over/under-counts.

`payment_plan_id` in the Dentally ground truth: **1 = NHS, 2 = Private.** Both can legitimately
coexist on the same tooth/COT (permitted since 2006) — a single COT is not one payment plan. Any
predicted-claim logic must filter to `payment_plan_id = 1` before applying band logic, and sum
private items' actual `price` separately. NHS/Private labelling is practice/clinician-facing
only and must **never** appear in patient-facing copy — this is already a standing platform rule
(`no-funding-jargon-to-patients`), and a charting screen is exactly the kind of surface where it's
tempting to leak `nhs_treatment_cat`/`uda_band` into something a patient eventually sees.

**"Band 4" in Dentally's own UI = "Urgent"** — this is Dentally's internal label, not NHS
terminology (the NHS has no Band 4). If displaying this, label it "Urgent" to avoid confusing
clinicians who think in real NHS terms.

### 7.2 What NOT to hard-code without a refresh mechanism

Patient charge figures (Band 1/2/3/urgent £ amounts) change every April and were only
secondary-sourced in this research (primary NHSBSA pages blocked automated fetch during
research). The reported April-2026 move of urgent care from 1.2 UDA to a flat fee is **unverified
against a primary NHS England document** — confirm before building any UDA-based analytics around
urgent claims. Since the chart is read-only and Dentally's own item already carries band/category,
this mostly affects analytics/UDA-target features, not the chart's clinical display.

### 7.3 Compass validation rules worth knowing if a "predicted claim" feature is ever built

Band declared must be internally consistent with the CDS items present (e.g. Band 3 claimed
needs ≥1 Band 3 item; "Other"/no-charge claims must carry **no** Band 1/2/3 item at all). A COT
can close **incomplete** (Failed To Return) with two separate band fields — the band actually
completed (drives patient charge) vs the band that was started (drives UDA credit); the latter
must be ≥ the former. `completed`/`completed_at` on a `treatment_plan_item` is what "actually
delivered" looks like in this data model; don't assume the highest-*planned* band item is what
gets claimed.

---

## 8. Record-keeping, DCB0129/0160, and the wrong-tooth hazard

### 8.1 GDC Standard 4.1 (the legal floor for the record itself)

Verbatim, the operative clauses:
- **4.1.1** — complete and accurate records, including up-to-date medical history, every visit.
- **4.1.4** — **"all documentation... must be clear, legible, accurate, and can be readily
  understood by others. You must also record the name or initials of the treating clinician."**
  → every historical chart entry must resolve and display `practitioner_id`; never render an
  "unknown clinician" state silently.
- **4.1.5** — amendments must be clearly marked up and dated (not silently edited). For a
  read-only mirror this is chiefly Dentally's problem, but it means **our own display
  transformations (Palmer→FDI, surface remapping) must be visibly a display transformation, never
  presented as if it were the record itself** — never silently "correct" a discrepancy between
  what we show and what Dentally holds.

**Retention**: current NHS England Digital position is **11 years from last attendance for
adults**; for children, the later of **25th birthday or 11 years post-treatment**. This figure has
changed three times in 18 months (10→8→15→11 years) — **do not hard-code it as a literal**; build
retention logic as configuration with a documented recheck step.

### 8.2 DCB0129 / DCB0160 — this chart is in scope, full stop

These are legally-mandated NHS clinical-risk-management standards (Health and Social Care Act
2012 s.250) for any Health IT System used to influence care. **DCB0129 = your platform's duty as
Manufacturer. DCB0160 = the dental group's duty as Health Organisation.** The scoping test in the
standard itself ("could failure, design flaws or incorrect use cause harm to patients") is
unambiguously met here — a chart a dentist uses to decide whether to extract/restore/leave a
tooth alone qualifies, independent of read-only status.

Concrete, non-optional actions: nominate a Clinical Safety Officer for the platform (a registered
clinician, knowledgeable in risk management — DCB0129 §2.3); the dental group separately
nominates their own CSO (DCB0160 §2.3), most obviously a registered dentist; open a **Hazard Log**
now, before build (seed list in §8.4); produce a **Clinical Safety Case Report** before this chart
is used for real clinical decisions, explicitly covering **fault conditions** — e.g. what a
dentist sees when a Dentally sync is stale, partial, or a tooth silently fails to load (the
standard requires hazard analysis to cover "both normal and fault conditions", not just the happy
path).

### 8.3 The wrong-tooth hazard, and why this specific project raises it

Wrong-site/wrong-tooth extraction was removed from the NHS Never Events list on 1 April 2021 —
**not** because it became less serious, but because the national review found "the barriers
available... are insufficient to meet the never event definition" (i.e. dentistry doesn't
currently have *strong systemic barriers* for this error, per the Never Events framework's own
definition of "strong": mechanical impossibility or a computerised/visual forcing function — a
plain checklist alone doesn't qualify). It remains fully reportable as a Serious Incident.

The national HSSIB investigation found, directly on point for a charting product:
- Information about the planned tooth is **transcribed no less than seven times** across
  artefacts before an extraction — every transcription is an independent error opportunity.
- **Notation-system confusion is named explicitly**: *"Different dental notation systems existed
  (Palmer vs. FDI), potentially creating confusion... clinicians trained internationally brought
  varied familiarity."*
- A peer-reviewed 351-dentist study found the three leading contributory factors to a
  self-reported wrong-tooth extraction were: inadequate radiographic exam (40%), improper clinical
  exam (24%), **uncertainty about tooth notation (14%)** — quantified, not hypothetical.

**This project introduces exactly this hazard by design**: Dentally stores Palmer natively and
its own UI presumably renders Palmer throughout; this product is contractually an *FDI* chart —
meaning every tooth reference crossing the Dentally→platform boundary undergoes precisely the kind
of system conversion independently evidenced as an error contributor. This is the single largest
notation-related hazard this specific build introduces that did not exist in Dentally's own UI.

### 8.4 Concrete mitigations that follow directly from the evidence above (seed the Hazard Log with these)

1. **Never render a bare notation code as the only label.** Pair every tooth reference with its
   name in full — "UR6 — upper right first permanent molar" — exactly as the RCS/FGDP LocSSIPs
   toolkit mandates for consent forms, whiteboards and on-screen records.
2. **Treat the Palmer→FDI conversion as the single highest-value hazard-control point in the
   whole build.** Exhaustively unit-test against the §2.2/§2.3 tables (52 rows, no sampling);
   never derive by runtime arithmetic alone without a lookup-table cross-check; consider surfacing
   both notations side by side rather than silently translating, since Palmer-trained UK
   clinicians shouldn't have to trust an invisible conversion for an irreversible decision.
3. **Periodontal/BPE absence must be an explicit, first-class UI state, never a blank** (§6.3).
4. **Preserve treatment-plan history — never let completion silently overwrite the pre-completion
   plan state** (§4.1) — this is a named FGDP defect class in electronic (not paper) dental
   records specifically.
5. **Attribute every entry to a named clinician, always** (GDC 4.1.4) — resolve `practitioner_id`
   on every historical row; never allow a silent "unknown clinician" render.
6. **Fail loud on any sync/discrepancy/partial-load, never quiet.** A stale, partial, or
   failed-to-resolve tooth must say so prominently — never render a plausible-looking but
   incomplete or wrong chart. This is both a DCB0129 fault-condition requirement and the direct
   fix for the "no closed-loop confirmation" gap HSSIB identified as the root systemic problem.
7. **A structured, software-enforced display that makes the correct tooth/side/notation
   impossible to misread is a genuinely stronger control than anything paper-dentistry has
   achieved** (per the Never Events framework's own "strong barrier" test) — this is squarely
   achievable here and is the most evidence-aligned contribution the software itself can make.

---

## 9. Concrete implications for our build — checklist

**Before this chart touches a single real patient:**
- [ ] Run one authenticated `GET /v1/treatment_plan_items` read against a real charted patient
      using `DENTALLY_PROD_READONLY_API_KEY` (per memory: this key currently carries full write
      scopes too — see `dentally-readonly-key-is-not-readonly.md`; read-only in intent only, so
      use it carefully and don't issue mutating calls with it). Log the raw, unprocessed `teeth`
      value verbatim for several rows, spanning at least one molar and one deciduous tooth if a
      mixed-dentition patient is available. This single probe resolves §2.6(a)/(b)/(c) definitively.
- [ ] Until that probe runs, build `parseTeeth` (or its successor) to detect all three shapes:
      Palmer-letter tokens (`/^[UL][RL][1-8A-E]$/i`) routed through §2.4's conversion; bare/CSV
      numeric tokens validated against the exhaustive FDI `ALL_TEETH` set (as today); anything
      else → `unparsed: true`, surfaced, never silently dropped.
- [ ] Pull a sample of real molar `treatment_plan_item`s with `surfaces` containing 6/7/8, and
      cross-reference against free-text notes/nomenclature to settle the 8-scheme mapping (§3.6)
      before hard-coding it; do the same separately per quadrant to resolve anatomically-fixed vs
      screen-fixed indexing.
- [ ] Get a second real Dentally screenshot showing a genuine mix of planned vs completed items
      before building any colour scheme around the yellow seen in the original screenshot (§5).

**Structural build rules:**
- [ ] Tooth-type (permanent vs deciduous, molar vs not) drives surface-diagram geometry — never
      a fixed 5-region grid for every tooth.
- [ ] Every tooth label pairs the notation code with the tooth's name in full; never a bare
      number or bare Palmer code alone anywhere a human reads it.
- [ ] Reuse `fdi.ts`'s `sideOf`/`archOf`/`quadrantOf` in any second renderer (print, PDF, future
      mirrored view) — never re-derive orientation logic.
- [ ] Base chart, active plan(s), and completed/History are three distinct views/modes, matching
      Dentally's own structure — not one merged always-current view.
- [ ] Red = planned, blue/black = completed/existing, non-negotiable; colour is never the only
      channel (pair with fill pattern/outline).
- [ ] Left-click = chart first surface; right-click = add further surfaces — Dentally's exact
      gesture, not a click-and-drag alternative, because staff are migrating **from** Dentally.
- [ ] A persistent, unmissable "Periodontal/BPE data not available in this view — check Dentally
      directly" state — never an empty periodontal section.
- [ ] Every chart entry displays its clinician (resolve `practitioner_id`); every partial/failed
      sync state renders as a loud, explicit warning, never a silently-incomplete-looking chart.
- [ ] `payment_plan_id` (NHS/Private) visually distinguished per item for clinician/reception use,
      but never surfaced as NHS/Private jargon anywhere a patient could see it.
- [ ] Retention/compliance logic (11-year figure) built as configuration, not a literal, given its
      recent history of change.

**Governance, not code, but blocking for real go-live:**
- [ ] Open a Hazard Log now, seeded with the items in §8.4.
- [ ] Nominate a platform CSO (DCB0129) and prompt the dental group to nominate their own
      (DCB0160) before this is used for real clinical decisions.

---

## 10. Contradictions and corrections against `DENTALLY.md`

`DENTALLY.md`'s existing "Charting (FDI)" section (its own correction block, lines ~93–112) already
states the two load-bearing facts this research was commissioned to verify: **teeth are Palmer,
not FDI**, and **molars carry 8 surface regions, not 5**. Both are corroborated, not
contradicted, by every one of the seven research passes. Specific refinements and additions on
top of that existing text:

1. **The Palmer wire-format question is still fully open, more open than `DENTALLY.md` implies.**
   `DENTALLY.md` correctly flags that a Palmer→FDI conversion function is needed. What none of the
   research could find, despite dedicated searching, is **any real example of what the `teeth`
   field actually contains on the wire** — not even a third-party integrator's forum post. This
   means the existing codebase's `parseTeeth()` — which only accepts bare/FDI-shaped numeric input
   and explicitly rejects Palmer text like `"UR6"` per its own test suite — is not confirmed
   correct, but also not confirmed wrong. `DENTALLY.md` should be read as correctly *identifying*
   the risk but the actual resolution requires the live probe in §9, which has not yet run.
2. **The 8-surface molar scheme's exact index-to-region mapping is not specified anywhere
   `DENTALLY.md` or Dentally's docs give** — `DENTALLY.md` correctly states the *count* (8, not
   5) but does not attempt a mapping. This document adds a reasoned, confidence-graded hypothesis
   (§3.4: 4 peripheral surfaces + 4 cusp-quadrants) that all researchers converged on, but flags it
   as genuinely unverified and requiring the empirical pass in §3.6/§9 before shipping.
3. **No contradiction found on notation direction, mirroring, colour convention, or the
   left-click/right-click interaction** — `DENTALLY.md`'s description of these matches what this
   research independently found across every vendor/source checked.
4. **New material not present in `DENTALLY.md` at all**: the complete Universal-numbering
   cross-reference (§2.2/§2.3), the full BPE/perio clinical picture and its absence-handling
   requirement (§6), the NHS FP17/UDA-band mechanics behind `nhs_treatment_cat`/`uda_band`/
   `payment_plan_id` (§7), and the DCB0129/0160 legal-compliance obligations plus the named
   wrong-tooth hazard evidence base (§8). None of this existed in the prior document; it is a
   material expansion of what the engineering team needs to know before this ships, not a
   contradiction of anything already written.
5. **One genuinely new caution `DENTALLY.md` doesn't carry**: the surface-index mapping may be
   **anatomically fixed or screen-position-dependent**, and public documentation gives no way to
   tell (§3.4). This changes the shape of the lookup function itself, not just its contents, and
   is worth flagging to whoever scopes the surfaces-rendering work specifically.

No finding in any of the seven research passes contradicts an existing factual claim in
`DENTALLY.md`'s charting section — the passes corroborate and deepen it, and narrow the remaining
uncertainty down to two concrete, resolvable-by-probe questions (Palmer wire format; surface
index mapping), both flagged as pre-existing open items in `DENTALLY.md`'s own text.
