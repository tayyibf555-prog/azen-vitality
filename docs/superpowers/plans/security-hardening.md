# Security Hardening Backlog (pre-production gate)

> From the adversarial dashboard security review (22 findings, all verified). This is the gate before ANY deploy, live Dentally pull, real messaging, or real patient data. Almost all findings share one root cause: there is no server-side auth/authz, and the DB is reachable with a public key under permissive RLS. The employee-levels UI is fine; it just needs a server-side backbone.

## Root cause (fix these and ~20 of 22 fall)
Access control is enforced only in the browser, at three bypassable layers:
1. Role is a client-writable `localStorage` string (no server session).
2. Server pages + API routes do zero auth/role/site checks.
3. The DB is directly reachable with the public anon key under `using(true)` RLS.

## Workstream 1 — Real authentication (replaces the mock)
- [ ] Replace `src/lib/auth/mock-auth.tsx` (localStorage role) with server-issued sessions: Supabase Auth (httpOnly cookies) via `@supabase/ssr`. Never derive privilege from client state.
- [ ] Persist user -> role + client_id + site scope server-side (a `profiles`/`memberships` table).
- [ ] Remove the role-picker login and the `RoleSwitcher` from non-local builds (gate behind an env flag). [findings: mock self-elevation HIGH]

## Workstream 2 — Lock down RLS + keys (the CRITICAL)
- [ ] Drop the `pilot_all_*` policies and the `grant all ... to anon` in migrations 0002/0003. Revoke `anon` on all patient/coordinator/webhook tables.
- [ ] Add auth-bound, SITE-SCOPED policies (row visible only to members of that `site_id`/client) using `auth.uid()` / a JWT claim.
- [ ] Set `SUPABASE_SERVICE_ROLE_KEY` (server-only) and make `serviceClient()` REQUIRE it — remove the public-anon fallback; throw in production if unset.
- [ ] Rotate the publishable + service-role keys if the project ever held real data. [findings: permissive-RLS CRITICAL; anon-fallback MED/LOW]

## Workstream 3 — Server-side authorization
- [ ] Add `middleware.ts` (or per-route guards) that requires a valid session and authorizes the caller for the requested `client`/`site` before any page or API handler runs.
- [ ] Server-enforce employee levels: pages and the `[module]` catch-all check the role's `allowedSlugs` SERVER-side and 404/redirect — not just the client `RoleGuard`.
- [ ] Scope every data read to the caller's client + site (kills the `[client]`-slug IDOR). [findings: client-side-only RoleGuard HIGH; cosmetic levels MED; cross-client IDOR HIGH; data-exposure to manager/general HIGH/MED]

## Workstream 4 — API route protection
- [ ] Authenticate + authorize `POST /api/coordinator/[action]`, `/api/sync/dentally`, `/api/sync/reactivation`, `/api/reactivation/*`. No unauthenticated access. [findings: unauth routes HIGH]
- [ ] Gate `sync` behind auth + a server-side "live sync enabled" flag so production data can never be pulled by an anonymous call. [finding: unauth sync pulls prod PII HIGH]
- [ ] Rate-limit `draft` (Claude cost abuse) and all mutating routes. [finding: LLM cost abuse MED]
- [ ] Scope `send`/`approve`/`book` to the caller's client/site + verify ownership of the touch/opportunity. [finding: IDOR on actions MED]
- [ ] Webhook: constant-time token compare, accept the secret via header only (not query string). [finding: webhook token LOW]
- [ ] Strict body validation (zod) on every route; `book` allow-lists fields (already partly done). [finding: loose validation LOW]

## Workstream 5 — PII, secrets, compliance
- [ ] Retention + minimisation for `webhook_event.payload`, `coordinator_touch.body`, `treatment_opportunity` (TTL/purge job; store only what's needed).
- [ ] Move secrets out of `.env.local` into the deploy platform's secret store (Vercel env / a manager). Keep the production Dentally key out of any shared file.
- [ ] Confirm no `NEXT_PUBLIC_*` var carries a secret (anon key is public-by-design; that's fine once RLS is locked).
- [ ] Audit log of who accessed/actioned what (for GDPR accountability). [findings: PII no-retention MED; secrets-on-disk HIGH-context]

## Exit criteria
- No route or page serves data without an authenticated, authorized session scoped to the caller's client + site.
- The anon key can read/write nothing of consequence (RLS denies by default).
- A re-run of the dashboard security review returns no high/critical findings.
- Only then: set the production Dentally key active, register the webhook against the deployed URL, and run the first live sync.
