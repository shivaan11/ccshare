# Contributing to ccshare

Conventions for a two-person project run like a professional one. Optimize for the
reviewer (the other of us) and for future Claude Code sessions working in this repo.

## Toolchain

- **Node ≥ 20** (pinned in `.nvmrc` and `package.json#engines`), **pnpm** via corepack.
- **TypeScript strict** everywhere, ESM only. Shared base config in `tsconfig.base.json`.
- **Biome** for lint + format (one tool, one config, fast). `pnpm check` must pass;
  no editor-specific formatting.
- **Supabase CLI** for everything database: local stack via `supabase start`.

## Repo discipline

- Layout is fixed by [DESIGN.md §2](DESIGN.md); new top-level packages need a DESIGN.md
  change in the same PR.
- `packages/protocol` is the only place event/control/env shapes are defined. Apps
  import from it; nobody redefines a payload locally.
- Generated DB types (`supabase gen types typescript`) are committed; CI fails on drift.

## Git workflow

- **Trunk-based.** `main` is protected and always deployable. Short-lived branches:
  `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`.
- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`),
  imperative subject ≤ 72 chars. Squash-merge; the PR title becomes the commit and
  must itself be a valid conventional commit.
- **PRs for everything**, reviewed by the other person. Small PRs (< ~400 lines diff)
  beat big ones; split by checkpoint milestone (M1–M4), not by "done with everything".
- PR description states *what* and *why*, links the DESIGN.md section it implements,
  and includes screenshots/recordings for UI changes.

## Database changes

- Schema changes are **migrations only** (`supabase migration new <name>`); never edit
  an applied migration, never touch the dashboard SQL editor for schema.
- Every table ships with its RLS policies in the same migration. A table without RLS
  does not merge.
- Migration PRs include the regenerated types and note any RLS-matrix change in
  DESIGN.md §4.2.

## Testing bar

- `policy.ts` and the event reducer: exhaustive table/property tests — these encode
  the trust model and correctness of replay; they stay at 100%.
- Adapter changes require updated golden fixtures (`fixtures/*.ndjson`).
- New RLS policies require a negative test (the thing they forbid, attempted with a
  real second-user JWT).
- UI: component tests are optional pre-M4; Playwright flows land in M4 and gate merge
  after that.

## Docs discipline

- **PRD.md** = intent. **DESIGN.md** = truth. Any PR that changes behavior, schema, or
  protocol updates DESIGN.md *in the same PR* — that's what keeps "DESIGN is truth"
  true. Bigger decision reversals get a dated note in the relevant section.
- `docs/acceptance.md` holds the manual real-Claude acceptance checklist per milestone;
  tick it in the milestone-closing PR.

## Definition of done (PR checklist)

- [ ] `pnpm check` (Biome) and `pnpm typecheck` clean
- [ ] Tests for new logic; policy/reducer/RLS rules above respected
- [ ] DESIGN.md updated if behavior/schema/protocol changed
- [ ] No secrets in code or fixtures; new env vars added to `.env.example` + zod env schema
- [ ] Migration includes RLS + regenerated types (if DB touched)

## CI (GitHub Actions, on every PR)

1. `pnpm install --frozen-lockfile`
2. Biome check + `tsc -b`
3. Vitest (unit + protocol property tests)
4. `next build` (web) + `tsup` (daemon)
5. DB job: `supabase start` → apply all migrations from zero → typegen drift check →
   RLS integration tests

## Environments & secrets

- `.env.example` per app is the contract; envs are validated by zod at boot — the app
  refuses to start with a missing/malformed var rather than failing later.
- Service-role key exists **only** as a Vercel server env var. It never appears in the
  daemon, the browser bundle, fixtures, or CI logs.
- Local dev: `supabase start` values in `.env.local` (gitignored).

## Releases

- Web deploys from `main` via Vercel (preview deploys per PR).
- Daemon publishes to npm via **changesets**: PRs that change the daemon add a
  changeset; merging a release PR publishes and tags.
