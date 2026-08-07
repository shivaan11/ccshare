# ccshare

**Multiplayer Claude Code.** A web surface where several people watch and drive the same
Claude Code session in real time — Google Docs-style simultaneous work, for agentic coding.

The session runs on the **host's own machine**, through the host's own Claude Code CLI and
subscription. The cloud (Supabase + Vercel) only coordinates: it stores the transcript and
relays messages. It never executes Claude Code, and Anthropic credentials never leave the
host's laptop.

```
   Shivaan's laptop                    cloud                     Anmol's browser
 ┌───────────────────┐        ┌──────────────────────┐        ┌──────────────────┐
 │ ccshare daemon    │ events │ Supabase             │ events │ live transcript  │
 │  └ Claude Agent   │───────▶│  Postgres + Realtime │───────▶│ tool calls,      │
 │     SDK (his sub) │        │  (RLS everywhere)    │        │ diffs, thinking  │
 │                   │◀───────│                      │◀───────│ messages,        │
 │ applies or queues │control │ control_requests     │control │ interrupts       │
 └───────────────────┘        └──────────────────────┘        └──────────────────┘
```

Everyone in a workspace can host. You are the host of the sessions you share, and a guest
in everyone else's — so a session always bills to whoever's machine it runs on.

## What it does

**Watch a session live.** The full agent stream, not just the final answer: assistant text
token-by-token, thinking blocks, every tool call with its arguments, tool results, file
diffs rendered as diffs, shell commands rendered as terminal output, and turn-end token
counts.

**Drive it together.** Guests can send messages, interrupt a running turn, answer
permission prompts, and change the model or permission mode — subject to the session's
mode (below). Messages sent while Claude is busy are queued and shown as pending chips,
so two people typing at once doesn't garble the conversation.

**Two control modes.** The host picks per session:

| | equal | moderated (default) |
|---|---|---|
| Guest sends a message | runs immediately | waits for host approval |
| Guest interrupts | immediate | immediate |
| Guest answers a permission prompt | allowed | host only |
| Guest changes model / permission mode | allowed | waits for host approval |
| Guest changes the session mode | never | never |

In moderated mode the host gets an approval tray listing everything pending, with approve
and reject buttons. Approval is enforced by the host's own daemon, not by hiding buttons in
the UI — the database physically refuses guest writes to the transcript.

**See who's around.** Presence shows who's viewing, who's typing, and — if they toggle
draft sharing on — what they're about to send, live, before they send it.

**Coexist with the terminal.** `ccshare watch` mirrors sessions you run in the plain
`claude` TUI to the web read-only, so someone can follow along without you changing how
you work. When you want them to actually participate, exit the TUI and re-attach the same
session with `ccshare --resume <id>` — nothing is lost.

**Replay anything.** Every session is archived and replays through exactly the same
renderer as the live view, so an ended session looks identical to a live one.

**Survive a flaky network.** If the daemon loses connectivity it spools events to disk and
flushes them when the connection returns. Browsers that reconnect backfill by sequence
number, so nobody sees a gap or a duplicate.

### Not built yet

Image/file attachments (the schema and storage bucket exist, the composer doesn't upload
yet), and an automated end-to-end browser test suite. Slash commands are not interpreted —
model and permission mode are first-class controls in the UI instead.

## Getting started

### 1. Get access

Sign up at the web app, then wait to be approved. Signing in creates an identity only; it
grants no access to anything until the workspace owner approves you (or your email was
invited ahead of time, in which case you're in immediately). Until then you'll see a
"pending approval" screen.

Sign-in is email + password. New accounts confirm their address once via an emailed link;
after that, sign-in never leaves the tab. The **account** page lets you set or change your
password — the CLI uses the same credentials.

### 2. Install the CLI

You need [Claude Code](https://claude.com/claude-code) installed and logged in already —
ccshare drives your existing CLI and subscription.

```bash
git clone https://github.com/shivaan11/ccshare.git
cd ccshare
corepack enable && pnpm install
pnpm --filter ccshare build
```

Optionally put it on your PATH:

```bash
ln -s "$PWD/packages/daemon/dist/cli.js" /usr/local/bin/ccshare
```

The examples below assume you did; otherwise use
`node packages/daemon/dist/cli.js` in place of `ccshare`.

### 3. Log in and host a session

```bash
ccshare login              # same email + password as the web app
cd ~/code/your-project
ccshare                    # starts a shared session in this directory
```

The CLI prints a URL. Anyone in the workspace can open it and join. Useful flags:

| Command | What it does |
|---|---|
| `ccshare` | Share a session in the current directory (moderated by default) |
| `ccshare --mode equal` | Start with guests at full control |
| `ccshare --model opus` | Pick the model up front |
| `ccshare --permission-mode plan` | `default`, `plan`, `acceptEdits`, or `bypassPermissions` |
| `ccshare --resume <claude-session-id>` | Take over an existing Claude Code session |
| `ccshare watch` | Mirror your `claude` TUI sessions to the web, read-only |
| `ccshare whoami` / `ccshare logout` | Check or clear the stored login |

Permission prompts appear in both places at once: as a `y/N` prompt in your terminal and as
a card in every browser. Whoever answers first wins, and the other surface updates.

## Access control

Nobody can see anything without an approved account.

- Anyone can sign up, but sign-up only creates an identity. Row-level security means a
  user with no workspace membership can read no sessions, no transcripts, and no other
  users' profiles.
- Emails on the invite list join automatically on first sign-in.
- Everyone else lands on `/pending` and shows up in an **access requests** panel visible
  only to the workspace owner, with approve and deny. Deny deletes the account outright, so
  a denied person can sign up again rather than being silently stuck.
- The same gate covers the CLI: the daemon refuses to start a session for an account with
  no workspace membership.

## Running your own instance

1. **Create a Supabase project**, then link and push the schema:

   ```bash
   supabase link --project-ref <your-ref>
   supabase db push          # schema, RLS, realtime, storage
   supabase config push      # auth URLs, password rules
   ```

   Edit `supabase/migrations/*_seed_workspace.sql` first so the workspace and its owner
   invite point at your email, not `shivaansood@gmail.com`.

2. **Set auth URLs** in `supabase/config.toml` (then `supabase config push`): `site_url` is
   your deployment, and `additional_redirect_urls` must include your domain plus
   `http://127.0.0.1:41741-41743/auth/callback` for the CLI's OAuth flow.

3. **Deploy the web app to Vercel** from `apps/web`, with the env vars in
   `apps/web/.env.example`: the Supabase URL and publishable key (public, protected by RLS)
   and `SUPABASE_SERVICE_ROLE_KEY` (server-only — it is used exclusively by the approval
   route and must never be exposed to the browser).

4. **Point the CLI at your project** by editing the defaults in
   `packages/daemon/src/config.ts`, or by setting `CCSHARE_SUPABASE_URL`,
   `CCSHARE_SUPABASE_ANON_KEY`, and `CCSHARE_APP_URL`.

Note that Supabase's built-in email service is rate-limited to a couple of messages per
hour, which is fine here because email is only used at sign-up. Configuring custom SMTP
lifts that limit and unlocks custom email templates.

## Development

```
apps/web            Next.js app (Vercel) — session list, live view, replay, approvals
packages/protocol   zod event/control schemas + the shared reducer
packages/daemon     `ccshare` CLI — runs sessions headless, streams to Supabase
supabase/           migrations and project config
scripts/            rls-check.mjs — negative tests against the trust boundary
```

```bash
supabase start            # local stack (Docker); required for integration tests
pnpm --filter web dev     # web app on :3000
pnpm check                # Biome lint + format
pnpm typecheck            # tsc -b
pnpm test                 # Vitest
pnpm rls-check            # asserts the database refuses what the RLS matrix forbids
```

Four rules keep the trust model intact; [CONTRIBUTING.md](CONTRIBUTING.md) has the rest.

- The cloud never executes Claude Code, and Anthropic credentials never leave the host.
- Only the host's daemon writes transcript events or resolves control requests. There is no
  browser-side or service-role write path around it.
- Payload shapes live only in `packages/protocol`; Anthropic SDK formats are known only to
  `packages/daemon/src/runner/adapter.ts`.
- Every new table gets RLS in the same migration, and schema changes are migrations only.

| Doc | What it holds |
|---|---|
| [PRD.md](PRD.md) | What is being built, for whom, how success is measured |
| [DESIGN.md](DESIGN.md) | Implementation truth: protocol, schema, RLS matrix, modules |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Workflow, conventions, testing bar |
| [docs/acceptance.md](docs/acceptance.md) | Manual acceptance checklist |

## Troubleshooting

**"Not logged in" from the CLI** — run `ccshare login`. Credentials are stored at
`~/.config/ccshare/session.json` (mode 0600).

**Session shows as offline in the browser** — the daemon heartbeats every 20 seconds and
the dot goes amber after 45. Check the terminal running `ccshare` is still alive.

**Guest messages seem to vanish** — the session is probably in moderated mode; look for
them in the host's approval tray.

**Sign-in says "Invalid login credentials"** — an account created with a magic link has no
password yet. Use "forgot your password? email me a sign-in link" to get in once, then set
a password on the account page.

**Sign-in says "Email not confirmed"** — click the confirmation link sent at sign-up. If
the email never arrives, you may have hit Supabase's built-in email rate limit; wait an
hour or configure custom SMTP.
