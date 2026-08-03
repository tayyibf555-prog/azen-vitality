# PERIO.md — periodontal charting and BPE: build spec

Clinical detail lives in [CHARTING.md](CHARTING.md) §6. This file is the build spec, and the
decisions that have to be made before it ships.

---

## 1. Read this first — perio is NOT the chart

The FDI chart is a **read-only mirror**: Dentally holds the data, we render it, nothing diverges.

**Perio cannot work that way.** Dentally's API exposes no periodontal resource of any kind — no
BPE, no pocket depths, no recession, no bleeding index. Verified: "perio" appears in their
documentation only as the word "*period*".

So there is nothing to mirror. Anything built here is **authored here**, which makes this platform
the system of record for that data the moment a hygienist types into it — while Dentally's own
Perio tab still exists and still works. That is a second clinical record, and it is inherent to
the feature, not a design mistake we can engineer around.

**Therefore: build it complete, build it tested, and ship it GATED OFF**, exactly as the chart
draft layer is. Enabling it is the practice's decision, in writing, not a consequence of us
finishing the code.

## 2. The correction that changes the business case

An earlier read of this said perio is self-contained and therefore the cheapest first module to
move off Dentally. **That was wrong, and the reason matters.**

**BPE has been a mandatory field on the NHS FP17 claim since 1 October 2022.**

So BPE is not clinical-only — it is load-bearing for getting paid. If a hygienist records BPE here
and the FP17 still goes out of Dentally, the score has to be entered **twice**. That is double
entry, not replacement, and double entry on a mandatory claim field is exactly where a claim gets
rejected or a record diverges.

This does not kill the feature. A materially better perio experience can still be worth building,
and it is a genuine step toward the endgame. But it must be sold internally as **"better charting,
same claim process"**, never as "perio moves off Dentally" — until the claim chain moves too.

State this to the practice before anyone uses it.

## 3. What to build

### 3.1 BPE — the screening layer, and the one clinicians use daily

Six sextants. A sextant needs **≥2 teeth** to qualify; if it does not, it is recorded with the
adjacent sextant rather than scored.

| sextant | FDI |
|---|---|
| upper right | 17–14 |
| upper anterior | 13–23 |
| upper left | 24–27 |
| lower left | 34–37 |
| lower anterior | 33–43 |
| lower right | 44–47 |

Score per sextant is the **highest code found** in it:

| code | meaning |
|---|---|
| `0` | healthy — no bleeding, no calculus, no pocket >3.5mm |
| `1` | bleeding on probing |
| `2` | calculus or plaque-retentive factor present |
| `3` | pocket 3.5–5.5mm (black band partially visible) |
| `4` | pocket >5.5mm (black band disappears) |
| `*` | furcation involvement — **additive**, e.g. `3*` |

Probe: WHO 621, 0.5mm ball end, black band 3.5–5.5mm, 20–25g force. Record the probe used.

**Rules the UI must enforce, because they are clinical protocol and not preferences:**
- Code `3` in a sextant → 6-point chart of **that sextant**, after initial therapy.
- Code `4` in a sextant → **full-mouth** 6-point chart from the outset.
- BPE **cannot** be used to monitor treatment response — only a repeat 6-point chart can. If a
  clinician records serial BPEs on a periodontitis patient, say so on screen.
- **Never** used around implants.

### 3.2 Full 6-point charting

Triggered by BPE 3 or 4, or annually for anyone in periodontal maintenance. Six sites per tooth
(mesiobuccal, buccal, distobuccal, mesiolingual, lingual, distolingual), recording:

probing depth · recession · **CAL (computed = depth + recession, never typed)** · bleeding on
probing · suppuration · plaque · mobility (Miller 0–III) · furcation (Hamp I–III)

### 3.3 Diagnosis (2017/18 classification)

Periodontitis is **Staged** I–IV (bone loss / CAL / tooth loss) and **Graded** A–C (rate of
progression, modified **up only** — never down — by smoking and diabetes). Offer this as
decision support that shows its working, never as an automatic diagnosis: the clinician owns it.

## 4. Build rules

- **Entry speed is the whole feature.** A 6-point chart is 192 numbers. Keyboard-first, tab/arrow
  progression, no mouse required, autosave per site. If it is slower than paper the hygienists
  will not use it, and a half-entered perio chart is worse than none.
- **Voice entry is the real prize** — this is how perio is done in practice, with an assistant
  reading numbers aloud. The transcription seam already exists (`TRANSCRIPTION_API_KEY`, used by
  patient-note dictation). A later phase, but design the state machine so it can be driven by a
  stream of numbers, not only by keystrokes.
- **Comparison over time is the clinical point.** A single chart is nearly useless; the value is
  this visit against the last. Build the diff view from the start.
- **Pure logic in `.ts`** (sextant assignment, highest-code rollup, `*` handling, CAL computation,
  BPE→charting-requirement rules, staging/grading). vitest cannot test `.tsx`.
- **Gate it.** `isPerioEnabled()`, default false, same pattern as `isChartDraftEnabled()`.
- **Attribution is not optional.** Every entry records the clinician who made it and when. GDC
  Standard 4.1.4 requires the treating clinician's name on the record; 4.1.5 requires amendments
  to be clearly marked and dated. No robot authorship, no shared identity, amendments append
  rather than overwrite.
- **The chart's Perio affordance must stop lying once this exists.** `chart-unavailable-panel.tsx`
  currently says perio lives in Dentally. If perio is enabled here, that copy has to change — and
  if it is enabled here *and* still recorded in Dentally, the panel must say **both**, because
  that is when a clinician is most likely to look in the wrong place.

## 5. Before it can be used clinically

- The practice decides, in writing, whether perio is recorded here, in Dentally, or both.
- The double-entry consequence for FP17 BPE is stated to whoever does the claims.
- DCB0129 applies: this is a health IT system informing treatment decisions, so it needs a
  Clinical Safety Officer (a registered clinician), a hazard log and a safety case. That is not
  something this repo can produce.
