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

## Using it

Web app: **https://ccshare-eight.vercel.app** — sign in with a magic link or
GitHub. Workspace membership attaches automatically if your email is invited.

Host a session from your machine:

```bash
pnpm install && pnpm --filter ccshare build
node packages/daemon/dist/cli.js login     # one-time; browser PKCE or --email <you>
node packages/daemon/dist/cli.js           # in the repo you want to work on
```

The CLI prints the session URL; anyone in the workspace can join and (per the
session's mode) send messages, interrupt, and answer permission prompts.
`ccshare watch` mirrors plain `claude` TUI sessions read-only.
`ccshare --resume <claude-session-id>` promotes a TUI session to multiplayer.

## Development

```bash
corepack enable && pnpm install
supabase start            # local Supabase (Docker)
pnpm --filter web dev     # web app on :3000
pnpm check && pnpm typecheck && pnpm test
pnpm rls-check            # RLS negative tests against the local stack
```

Manual acceptance: [docs/acceptance.md](docs/acceptance.md).
