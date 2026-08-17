# Go-Live Activation — switching the funnel program on

Follow-on to the funnel parity program (all lanes live as of 2026-08-17).
This charter activates what was built and clears the owed platform debt,
under one inviolable rule.

## THE RULE — Dentally is read-only, everywhere, no exceptions

- NO POST/PUT/PATCH/DELETE to any live Dentally endpoint, ever, under any
  framing ("just one test write" included). The only permitted live Dentally
  traffic is GET with the existing read key, which is established practice.
- All write-path testing runs against the LOCAL MOCK
  (DENTALLY_BASE_URL=http://localhost:3002/api/mock-dentally via the
  azen-web-mockwrite-3002 launch profile). DENTALLY_WRITE_ENABLED stays off
  in prod and is never pointed at a live base URL in any test.
- The output of the calibration lane is a RUNBOOK for a single authorised
  live test write that a human executes later — not the write itself.

## Lane 1 — Booking write-path calibration (without touching Dentally)

Goal: maximum confidence that the first authorised live booking write will
succeed, achieved entirely from reads + the mock.

1. Read-only probes against live Dentally (GET only): fetch real
   payment_plans per site (ids/names — compare against the hardcoded
   {nhs:1, private:2} map), sample real patient records for the shapes of
   title / date_of_birth / gender that live data actually carries, list the
   real appointment reasons/practitioners/site ids the create path would
   reference. Diff every assumption in booking/create's derivation helpers
   (knownTitle, canonicalDob, knownPaymentPlanId, genderFromTitle) against
   observed live data; fix mismatches in code with tests.
2. Mock-parity hardening: teach the local mock's patient-create endpoint to
   reject exactly what live Dentally rejected (the documented 422 shape from
   DENTALLY.md) so the mock can no longer pass a payload live would refuse.
   Re-run the full booking e2e against the strengthened mock.
3. In-funnel booking e2e on the mock: publish a flow with a booking block
   locally, walk quiz → book as a patient, confirm hold → create → confirmed
   against the mock, preview-mode still inert.
4. Deliverable: docs/runbooks/booking-live-calibration.md — the exact single
   test write a human runs when authorised (payload, expected result, which
   log line names a failure half, rollback = cancel the test appointment),
   plus the switch-on checklist (DENTALLY_WRITE_ENABLED, online-booking
   toggle, campaign booking block).

## Lane 2 — Publish deterministic flows on the live campaigns (Fable-run)

The four vitality campaigns still run the adaptive fallback, so drop-off
charts stay empty. Author template-built flows (validated by the real
validator), publish per campaign goal (invisalign, bonding, hygiene,
vitality-website→general), live-verify each public page runs the
deterministic runtime and the beacon records. Reversible: flow_published
back to false restores adaptive. DB via MCP + browser verification —
performed by the orchestrator, not a code lane.

## Lane 3 — Home screen chrome redesign (the owed one)

The Overview page reads worse than Dentally's despite a sound layout; the
saved diagnosis (memory: home-screen-redesign-owed) says the gap is CHROME,
not structure. Execute that fix list: read the memory file first at
/Users/tayyibarbab/.claude/projects/-Users-tayyibarbab-Downloads-Vitality-Dental-Project/memory/home-screen-redesign-owed.md
plus the house-style rule (copy Dentally's layout/density, modernise the
execution, never minimal — PRODUCT.md). Standard lane discipline: build →
gates → adversarial verify (visual + structural) → fix rounds → commit.
No loading.tsx. Owner band/server gating untouched.

## Settled without code

- Custom themes keep the STRICT readability bar (the shipped state); the
  grandfathering question is closed unless Tayyib reopens it.

## Blocked on humans (report, don't attempt)

- Real Meta pixel ids + follow-up message enablement: client decisions.
- Dentally write-key rotation: Tayyib's Dentally dashboard, not ours.
- The single live booking test write: waits for explicit authorisation.

## Discipline

Opus builds; every lane gates on tsc + full vitest + eslint ≤ baseline and
ends with an independent adversarial verify; commits stay local until
Tayyib says push.
