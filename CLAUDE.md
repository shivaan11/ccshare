# ccshare

Multiplayer web surface for Claude Code: sessions execute on a host's own machine via
their logged-in CLI (their subscription); Supabase + Vercel only coordinate.

## Read first

- **PRD.md** — what we're building and why; decisions there are settled, don't
  re-litigate them silently.
- **DESIGN.md** — implementation truth: protocol, schema, RLS matrix, module layout.
  If your change makes DESIGN.md wrong, update it in the same change.
- **CONTRIBUTING.md** — workflow, testing bar, DB discipline. Follow it.

## Hard rules

- The cloud never executes Claude Code, and Anthropic credentials never leave the
  host machine.
- Only the host daemon writes `events` / mutates `control_requests` state
  (single-writer, DESIGN §1.3). Never add a browser-side or service-role write path
  around it.
- Event/control payload shapes live only in `packages/protocol` (zod). Anthropic SDK
  and transcript formats are known only to `packages/daemon/src/runner/adapter.ts`.
- Every new table gets RLS in the same migration; schema changes are migrations only.
- `policy.ts` and the reducer keep exhaustive tests; adapter changes update golden
  fixtures.

## Commands

```
pnpm check        # Biome lint + format
pnpm typecheck    # tsc -b
pnpm test         # Vitest
supabase start    # local stack (Docker) — required for integration tests
```
