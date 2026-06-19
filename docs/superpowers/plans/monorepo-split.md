# Monorepo Split: Client Portal vs Azen Console

> Status: PLAN ONLY. Do NOT execute until the prerequisite (a quiet, consolidated tree) is met. This plan is rule-based, not file-by-file, because it must run against the merged result of several in-flight branches.

## Goal

Turn the single Next.js app into a monorepo with two deployable apps and shared packages, so the **practice-owner dashboard becomes a standalone client product** decoupled from Azen's internal tooling.

- **apps/portal** — the CLIENT product. The practice-owner dashboard with its Management + Operations modes and all modules. Its own build, its own domain.
- **apps/console** — AZEN internal. The agency cockpit (cross-client oversight). Its own build, its own domain.
- **packages/core** (`@azen/core`) — shared domain + data layer.
- **packages/ui** (`@azen/ui`) — shared design system.

This matches the monorepo direction in the original `CLAUDE.md`.

### Key product decision
The owner dashboard's **Operations mode already subsumes the coordinator** (the `/c` surface). So in the split, the standalone `/c` coordinator routes are **retired** — their content is already reachable in the portal via the Operations toggle (rendered through the shared `TreatmentCoordinatorView` / `OverviewDashboard` / `ModulePlaceholder` components). Portal = owner + operations in one product. Console = agency only.

## PREREQUISITE (hard gate)

A tree-move conflicts violently with concurrent edits. Before executing:
1. Merge all in-flight branches (`reactivation`, `practice-brain`, `practice-brain-build`, `tc-review-fixes`) into one consolidated branch.
2. Pause the other sessions.
3. Cut a fresh branch (e.g. `monorepo-split`) off the consolidated HEAD and do the entire migration there as one atomic change.
4. Re-inventory the tree at that point and reconcile this plan's rules with whatever modules exist then (new reactivation/practice-brain libs, components, routes).

## Target structure

```
/
├── package.json                 # root: { "private": true, "workspaces": ["apps/*","packages/*"] }
├── turbo.json                   # task graph: build, dev, lint, test, typecheck
├── tsconfig.base.json           # shared compiler options + path aliases to packages
├── packages/
│   ├── core/                    # @azen/core
│   │   ├── package.json         # name "@azen/core", exports "./*"
│   │   ├── tsconfig.json        # extends ../../tsconfig.base.json
│   │   └── src/                 # <- everything from src/lib/*
│   │       ├── types.ts
│   │       ├── utils.ts
│   │       ├── nav.ts
│   │       ├── auth/            # mock-auth (shared; real auth later)
│   │       ├── dentally/        # client, normalise, webhook, webhook-*
│   │       ├── supabase/        # server clients
│   │       ├── coordinator/     # types, scoring, draft, repository
│   │       ├── reactivation/    # (from the reactivation branch)
│   │       └── mock/            # fixtures
│   └── ui/                      # @azen/ui
│       ├── package.json         # name "@azen/ui"
│       └── src/
│           ├── globals.css      # brand tokens + Plus Jakarta wiring (@theme)
│           ├── primitives/      # PageHeader, StatCard, DataTable, charts, ...
│           └── ui/              # button, slot
└── apps/
    ├── portal/                  # CLIENT product
    │   ├── package.json         # deps: next, react, @azen/core, @azen/ui
    │   ├── next.config.ts       # transpilePackages: ["@azen/core","@azen/ui"]; turbopack.root pin removed/updated
    │   ├── tsconfig.json
    │   └── src/app/
    │       ├── layout.tsx        # imports @azen/ui/globals.css, Plus Jakarta, MockAuthProvider, RoleSwitcher
    │       ├── login/            # portal login (client roles: owner, coordinator)
    │       ├── [client]/         # the owner dashboard (was /owner/[client]) becomes the portal's main tree
    │       │   ├── layout.tsx     # OwnerShell (sidebar + Ops/Mgmt topbar)
    │       │   ├── page.tsx       # Management view
    │       │   └── [module]/      # catch-all: overview | treatment-coordinator | placeholders
    │       └── api/              # coordinator/[action], sync/dentally, sync/reactivation,
    │                             # reactivation/[action], reactivation/sweep, webhooks/dentally,
    │                             # mock-dentally/** (dev only)
    └── console/                 # AZEN internal
        ├── package.json
        ├── next.config.ts
        └── src/app/
            ├── login/            # console login (agency)
            └── agency/           # the cockpit (was /agency)
```

Portal-specific components (`components/owner`, `components/client`, `components/dev`) move under `apps/portal/src/components`. Console-specific (`components/agency`, `components/dev`) under `apps/console/src/components`. Anything genuinely shared and presentational goes to `@azen/ui` instead of being duplicated.

## Migration steps (runbook)

Each step ends with a commit. Stop and fix if a build/typecheck/test fails.

1. **Workspaces + tooling.** Create root `package.json` with `workspaces`, add `turbo` (dev dep), write `turbo.json` (pipeline for build/dev/lint/test/typecheck), and `tsconfig.base.json` with path aliases `@azen/core/*` and `@azen/ui/*`. Keep the lockfile at the root.

2. **packages/core.** Move `src/lib/*` -> `packages/core/src/*`. Add `package.json` (`"@azen/core"`, `"exports": { "./*": "./src/*.ts" }`, `"type": "module"`) and `tsconfig.json`. No import changes needed inside core if it used relative imports; fix any `@/lib` self-refs to relative.

3. **packages/ui.** Move `src/components/primitives` and `src/components/ui` -> `packages/ui/src/*`, and `src/app/globals.css` -> `packages/ui/src/globals.css`. Add `package.json` (`"@azen/ui"`) + tsconfig. Ensure the Plus Jakarta font is set up where consumed (font lives in each app's root layout; tokens live in ui's globals.css).

4. **apps/portal.** New Next 16 app. Move: `src/app/owner/*` -> `apps/portal/src/app/[client]/*` (drop the `/owner` prefix so the portal serves the dashboard at its root), the API routes the client needs (`coordinator`, `sync/*`, `reactivation/*`, `webhooks/*`, `mock-dentally/**`), `src/app/login`, and `components/{owner,client,dev}`. Add `next.config.ts` with `transpilePackages: ["@azen/core","@azen/ui"]`. Root layout imports `@azen/ui/globals.css`.

5. **apps/console.** New Next 16 app. Move `src/app/agency/*` and `components/agency` + a console `login`. Same package wiring.

6. **Rewrite imports (the bulk).** Across both apps: `@/lib/X` -> `@azen/core/X`; `@/components/primitives` -> `@azen/ui/primitives`; `@/components/ui/*` -> `@azen/ui/ui/*`; app-local component imports stay `@/components/*` within each app. Do this with a scripted codemod (ripgrep + sed over a known mapping), then fix stragglers by typecheck.

7. **Retire `/c`.** Delete the standalone coordinator route tree; confirm every module it had is reachable in the portal's Operations mode (it is, via the shared views). Update any links.

8. **Cross-app linking.** The console's agency "Enter client" now points at the portal's URL: add `NEXT_PUBLIC_PORTAL_URL` and link to `${PORTAL_URL}/${clientSlug}`. The portal's "Back to agency" (agency_admin preview) points at `NEXT_PUBLIC_CONSOLE_URL`.

9. **Tests + dev.** Move `vitest.config.ts` to a root or per-package setup; unit tests (core: scoring, normalise, draft, client, webhook; reactivation) run via `turbo test`. Update `.claude/launch.json` to define two servers (portal on 3000, console on 3001).

10. **Env + Supabase.** Both apps share the same Supabase project + Dentally. Use a root `.env` for shared values, or per-app `.env.local` (document which app needs the service-role key: the portal, since it runs the data/API routes; the console can run on mock metrics until it needs reads). Keep all `.env*` gitignored.

11. **Docs.** Update `CLAUDE.md` / `AGENTS.md` for the new layout; note portal vs console; point future module work at `apps/portal` + `packages/core`.

## Tailwind v4 in the monorepo (watch-out)

Tailwind v4 scans source for classes. With `globals.css` in `@azen/ui` and class usage spread across `apps/*` and `packages/ui`, add explicit `@source` directives in each app's CSS entry (e.g. `@source "../../../packages/ui/src"`) so classes used in shared components are not purged. Verify styles render in both apps after the move.

## Verification (end to end)

- `turbo build` builds both apps clean; `turbo typecheck` and `turbo test` pass (all existing unit tests green).
- Portal: `/login` -> Practice owner -> `[client]` Management view; Ops/Mgmt switcher works; Treatment Coordinator worklist + live Claude draft works; Staff rota placeholder renders; webhook route responds.
- Console: `/login` -> Agency admin -> `/agency` cockpit; "Enter client" opens the portal URL.
- No `/c` routes remain; nothing 404s in the portal nav.
- `.env*` still gitignored; no secrets committed.
- Both dev servers run concurrently via the updated launch.json.

## Risks / notes

- This is a high-churn move (hundreds of import rewrites). The scripted codemod + typecheck loop is what keeps it sane. Budget for a focused pass, not incremental.
- Real auth + RLS hardening is still a separate prerequisite before any production/live-data go-live; the split does not change that.
- The agency cockpit currently uses mock metrics; once it needs live cross-client data, decide whether the console reads Supabase directly or via a portal API. Out of scope for the split itself.
- Keep `mock-dentally` in the portal but dev-only (it is only used when `DENTALLY_BASE_URL` points at it).
