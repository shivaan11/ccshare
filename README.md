# ccshare

Multiplayer Claude Code. A web surface where a workspace of people can watch and drive
the same Claude Code session in real time — Google Docs-style simultaneous work, for
agentic coding. Sessions execute on the host's own machine, on the host's own Claude
subscription; the cloud only coordinates.

| Doc | What it holds |
|---|---|
| [PRD.md](PRD.md) | What is being built, for whom, how success is measured |
| [DESIGN.md](DESIGN.md) | Implementation truth: protocol, schema, RLS, module design |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Workflow, conventions, testing bar |

## Layout

```
apps/web            Next.js app (Vercel) — session list, live view, replay
packages/protocol   zod event/control schemas, shared reducer
packages/daemon     `ccshare` CLI — runs sessions headless, streams to Supabase
supabase/           migrations, config (Supabase CLI project)
```

## Quickstart (dev)

```bash
corepack enable && pnpm install
supabase start          # local Supabase (Docker)
pnpm --filter web dev   # web app on :3000
```

Status: pre-v1, under construction. See PRD §6 for the build checkpoints.
