# ccshare — Design

**Status:** Draft v1 · matches PRD.md v1
**Last updated:** 2026-08-06

This document is the implementation truth. [PRD.md](PRD.md) states intent; where they
disagree, this file wins and the PRD should be corrected. Conventions for working on
this codebase live in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 1. Principles

1. **The cloud coordinates; it never executes.** Claude Code runs only on a host's
   machine via their logged-in CLI. Supabase holds identity, the event log, and the
   realtime relay. Nothing else.
2. **One event schema, everywhere.** The daemon normalizes Agent SDK messages and
   transcript JSONL into a single protocol event union. The web app's live view and
   replay view are the same reducer over the same events — replay is just live without
   the tail.
3. **Single writer per session.** Only the host's daemon writes `events` and mutates
   session/control state. Guests (and the host's own browser) only *request* actions.
   This is what makes moderation enforceable (PRD G4) and the event log trustworthy.
4. **Runner-agnostic protocol.** A runner emits events and consumes control requests.
   Today the runner is the local daemon; a cloud runner (Railway) could implement the
   same interface later with zero schema or web-app changes.
5. **Boundaries are validated.** Every payload crossing a boundary (SDK → daemon,
   daemon → DB, DB → browser) is parsed with zod schemas from `packages/protocol`.
   Anthropic format drift breaks one adapter, not the system.

## 2. Components & repo layout

pnpm workspace monorepo:

```
ccshare/
├─ apps/
│  └─ web/                    # Next.js (App Router) on Vercel
├─ packages/
│  ├─ protocol/               # zod schemas: events, control, env; event reducer; generated DB types
│  └─ daemon/                 # `ccshare` CLI + runners (npm-published, runs via npx)
├─ supabase/                  # config.toml, migrations/, seed.sql (Supabase CLI project)
├─ .github/workflows/         # ci.yml
├─ PRD.md · DESIGN.md · CONTRIBUTING.md · CLAUDE.md · README.md
```

Stack: TypeScript strict everywhere (ESM), Node ≥ 20, pnpm. Web: Next.js 15+/React 19,
Tailwind + shadcn/ui, `@supabase/supabase-js` + `@supabase/ssr`, TanStack Virtual for
the transcript, shiki for code, a diff component for Edit tool calls. Daemon:
`@anthropic-ai/claude-agent-sdk`, commander (CLI), chokidar (mirror), pino (logs),
tsup (bundling). Shared: zod.

## 3. Protocol

### 3.1 Durable events (`events` table)

Append-only log, one row per event, ordered by a **daemon-assigned `seq`** (monotonic
per session; primary key `(session_id, seq)`). `seq` is authoritative order — never
timestamps. Discriminated union (zod) with types:

| Type | Payload (essentials) | Source |
|---|---|---|
| `session_started` | cwd, model, permission_mode, mode, host | daemon |
| `user_message` | author, text, attachments[], via: web\|tui | daemon |
| `assistant_message` | message id, content blocks (text, tool_use refs) | SDK `assistant` |
| `thinking` | message id, final thinking text | SDK |
| `tool_use` | tool_use id, tool name, input (truncated over 64 KB, `truncated: true`) | SDK |
| `tool_result` | tool_use id, output (same truncation), is_error | SDK `user` |
| `permission_request` | request_id, tool, input summary, suggestions | daemon (`canUseTool`) |
| `permission_decision` | request_id, decision, decided_by, updated_input? | daemon |
| `turn_result` | usage tokens, duration, cost estimate, stop reason | SDK `result` |
| `status_change` | working \| idle \| awaiting_permission \| interrupted | daemon |
| `settings_change` | model / permission_mode / session mode, changed_by | daemon |
| `control_note` | queued/approved/rejected message markers for the transcript | daemon |
| `session_ended` | reason | daemon |

Full (untruncated) tool payloads over the cap are stored in a companion
`event_blobs(session_id, seq, content)` row fetched on expand.

### 3.2 Ephemeral stream (Realtime broadcast only, never persisted)

- `delta` — token deltas for in-flight assistant text/thinking, coalesced to ≤ 30 Hz,
  keyed `(message_id, offset)`. UI renders provisional text; the durable
  `assistant_message` replaces it on completion (idempotent by message id).
- `presence` (Realtime presence) — `{user, typing, draft_text?, draft_shared}`.
  Drafts throttled to 5 Hz, capped 2 KB. Draft sharing defaults **on** (trusted
  two-person workspace), per-user toggle to private, persisted per user.

### 3.3 Control plane (`control_requests` table)

Guests and the host's browser never act directly — they INSERT a control request; the
**daemon is the sole state-machine writer** (it UPDATEs status). Durable table rather
than broadcast so every action is ordered, auditable, and survives reconnects.

```
kind: send_message | interrupt | permission_decision | set_model
    | set_permission_mode | set_session_mode | approve | reject | cancel
status: pending → applied | needs_approval → approved+applied | rejected
      | superseded | failed
```

Daemon subscribes to `postgres_changes` INSERTs on its sessions, runs the policy
function, and either applies, parks as `needs_approval` (host's Approval Tray), or
rejects. `approve`/`reject`/`cancel` are themselves control requests targeting a prior
request's id. In equal mode, the first `permission_decision` for a request_id wins;
later ones are marked `superseded`.

Policy is one pure function in the daemon:

```ts
authorize(req: ControlRequest, session: SessionState, actor: Role):
  'apply' | 'queue_for_approval' | 'reject'
```

implementing exactly the PRD §5.3 matrix. It is table-driven-tested to 100%.

### 3.4 Realtime channels (private channels, RLS-authorized)

| Channel | Lanes | Producers → consumers |
|---|---|---|
| `session:{id}` | broadcast `event` (durable events as appended), broadcast `delta`, presence | daemon → browsers; browsers ↔ browsers (presence) |
| `postgres_changes` | `control_requests` (INSERT/UPDATE), `sessions` (UPDATE) | DB → daemon (inserts), DB → browsers (status/list) |

**Catch-up rule (browser):** subscribe to `session:{id}` first, buffer, then fetch
`events where seq > last_seen` from Postgres, then drain the buffer, dedup by seq.
Replay = the fetch without the subscribe.

## 4. Data model & security (Supabase)

### 4.1 Schema (DDL sketch — real source is `supabase/migrations/`)

```sql
workspaces(id uuid pk, name text, created_at)
workspace_members(workspace_id fk, user_id fk auth.users, role owner|member,
                  pk(workspace_id, user_id))
sessions(id uuid pk, workspace_id fk, host_user_id fk, kind shared|mirror,
         status live|ended, mode equal|moderated, title, cwd, model,
         permission_mode, claude_session_id, last_heartbeat_at,
         created_at, ended_at)
events(session_id fk, seq bigint, type, author_user_id?, payload jsonb,
       created_at, pk(session_id, seq))
event_blobs(session_id, seq, content jsonb, pk(session_id, seq))
control_requests(id uuid pk, session_id fk, requested_by fk, kind, payload jsonb,
                 status, decided_by?, decided_at?, created_at)
attachments(id uuid pk, session_id fk, uploader_id fk, storage_path, mime, bytes)
```

### 4.2 RLS matrix (every table has RLS on; helper `is_member(workspace_id)`)

| Table | SELECT | INSERT | UPDATE |
|---|---|---|---|
| workspaces / members | members | service role only (invite API route) | service role |
| sessions | members | host (`host_user_id = auth.uid()`) | host only |
| events / event_blobs | members | host only | never (append-only) |
| control_requests | members | members, with `requested_by = auth.uid()` and session live | host only (daemon state machine) |
| attachments + Storage objects | members | members | never |

Realtime private-channel authorization: `realtime.messages` policies allow read/write
on topic `session:{id}` only to members of that session's workspace.

Consequences worth naming: a guest cannot forge transcript rows (host-only INSERT on
`events`), cannot approve their own requests (host-only UPDATE), and a compromised
anon key alone grants nothing (RLS + user JWTs everywhere; the service role key exists
only inside Vercel server routes for workspace management).

## 5. Daemon (`packages/daemon`)

### 5.1 CLI surface

```
ccshare login          # PKCE OAuth via browser; stores session in ~/.config/ccshare/
ccshare [--dir .]      # start a shared session in cwd; prints web URL
ccshare --resume <id>  # resume a Claude session as shared (the promote path)
ccshare watch          # mirror daemon: streams live TUI sessions read-only
ccshare sessions       # list my live/recent sessions
ccshare logout
```

v1 process model: **one process per shared session** (`ccshare` stays in the
foreground, Ctrl-C ends the session gracefully); `ccshare watch` is a separate
long-running process. A multiplexing background service is deferred.

### 5.2 Module layout

```
src/
├─ cli.ts              # commander entry
├─ auth.ts             # PKCE flow + file-backed session store (chmod 600)
├─ runner/
│  ├─ shared.ts        # Agent SDK runner (streaming input, one Query per session)
│  ├─ mirror.ts        # chokidar tail of ~/.claude/projects/**/[uuid].jsonl
│  └─ adapter.ts       # SDK message / transcript line → protocol events (ONLY place
│                      #   that knows Anthropic formats)
├─ policy.ts           # authorize() — pure, table-tested
├─ queue.ts            # message queue: hold while turn in flight, release on result
├─ transport.ts        # supabase client; EventWriter (seq counter, insert+broadcast,
│                      #   offline spool); control subscriber
├─ state.ts            # per-session state machine, heartbeat (20 s)
└─ log.ts              # pino, human-pretty in TTY
```

### 5.3 Shared-session runner (Agent SDK wiring)

- `query({ prompt: asyncMessageIterable, options })` with:
  `cwd`, `model`, `permissionMode`, `resume: claudeSessionId?`,
  `includePartialMessages: true`, `settingSources: ['user','project','local']`
  (so the host's CLAUDE.md, skills, slash commands, MCP servers, and allowlists all
  load exactly as in the TUI), and `canUseTool` for permission routing.
- **Input:** the async iterable is fed by `queue.ts`. Messages are injected only when
  no turn is in flight (deterministic daemon-side queueing; queued items are visible
  and cancellable via `control_note` events + `cancel` requests). Author prefix
  `[name]: ` is prepended to the text; identity is also structured on the event.
- **Interrupt:** `query.interrupt()`. **Settings:** `query.setModel()`,
  `query.setPermissionMode()` where supported by the SDK version; fallback is
  end-turn + re-`query` with `resume` and new options (context is preserved by
  resume). The adapter hides which path was taken.
- **Permissions:** `canUseTool(tool, input, { suggestions })` → emit
  `permission_request` → block on a promise resolved by the winning
  `permission_decision` control request → return allow (with optional
  `updatedInput`) / deny. No timeout — matches TUI behavior; interrupt is the
  escape hatch. Local auto-allowed tools never surface (the SDK only calls
  `canUseTool` for prompts the host's settings don't already decide).
- **Turn end:** SDK `result` → `turn_result` event (tokens, duration, cost estimate)
  → release queue.

### 5.4 Mirror runner

Watches `~/.claude/projects/<cwd-slug>/*.jsonl`. New file → register `kind='mirror'`
session; appended lines → adapter → events. Liveness is heuristic: `status='live'`
while the file changed within 60 s, else marked idle/ended. Mirror sessions are
read-only end to end (no control consumption at all). Promote = user exits TUI and
runs `ccshare --resume <id>` (the UI shows the command; we cannot reliably detect a
still-running TUI, so promote instructs, never forces).

### 5.5 Resilience

- **EventWriter** assigns seq from an in-memory counter initialized to
  `max(seq)` on start/resume; unique PK is the safety net.
- **Offline spool:** if Supabase is unreachable, events append to an ndjson spool file
  and flush in order on reconnect (exponential backoff 1 s → 30 s, jittered). The
  Claude session keeps running through relay outages.
- **Crash/restart:** `ccshare --resume` continues the same Claude session and the same
  event log (seq continues; no gaps, no dupes thanks to the PK).
- **Heartbeat:** `sessions.last_heartbeat_at` every 20 s; browsers render offline
  after 45 s and fall back to read-only.

## 6. Web app (`apps/web`)

### 6.1 Routes

```
/                 session list (live first: host, project, mode, viewers; then archive)
/s/[id]           session view (live or replay — same component)
/settings         profile, draft-sharing default, devices
/auth/*           Supabase OAuth callback (GitHub)
```

Server components fetch initial state (session row + recent events) with the user's
cookie-bound Supabase client; the session view then hydrates a client-side store.

### 6.2 State: one reducer, live and replay

`packages/protocol/reducer.ts`: `(SessionState, ProtocolEvent) → SessionState`,
building: message list, open tool calls, todo state, pending permission requests,
queue contents, settings, status, cumulative usage. The live view folds the realtime
stream into the same reducer the replay view folds the fetched log into. Deltas apply
to a provisional overlay keyed by message id, discarded when the durable event lands.
Property test: incremental folding ≡ batch replay for any event sequence.

### 6.3 Session view composition

- **Transcript** (virtualized): message groups with author chips (name/avatar; host
  badge), streaming text, thinking (collapsed by default), tool cards by type —
  Edit/Write → diff view, Bash → terminal-styled output, Read/Grep → collapsed
  summary; truncated payloads expand via `event_blobs` fetch.
- **PermissionCard** inline: tool + input summary, Allow / Deny (+ suggestion chips);
  disabled with "waiting for {host}" for guests in moderated mode; shows decider after.
- **Composer**: textarea with slash-command passthrough, image paste/drop (uploads to
  Storage, attaches paths), queue indicator ("queued · will send when Claude finishes"
  with cancel), Interrupt as a separate deliberate button, moderated-mode pending
  state ("waiting for approval").
- **ApprovalTray** (host, moderated sessions): pending control requests with
  approve/reject; badge count in the header.
- **StatusBar**: status, model, permission mode, session mode toggle (host),
  cumulative tokens/duration, host online/offline.
- **PresenceBar**: viewer avatars, typing, shared drafts (ghost text under composer).

### 6.4 API routes (Vercel, service-role — deliberately few)

- `POST /api/workspace/invite` — add member by email (workspace owner only).
- `POST /api/device/…` — none needed: daemon auth is pure Supabase PKCE (below).
Everything else goes straight from client to Supabase under RLS.

## 7. Auth

- **Web:** Supabase Auth via `@supabase/ssr` cookie sessions. **Email magic link is
  the zero-config default** (Supabase's built-in mailer; rate limits are fine for a
  two-person workspace); **GitHub OAuth** is offered additionally once its OAuth app
  is registered in the dashboard (GitHub has no API for creating OAuth apps, so that
  step is manual).
- **Daemon:** standard PKCE against the same Supabase project: `ccshare login`
  starts a localhost listener on the first free port of the fixed set
  `41741/41742/41743` (each `http://127.0.0.1:{port}/auth/callback` is allowlisted
  in Supabase auth config — fixed ports avoid relying on wildcard redirect
  matching), opens the browser to sign in, exchanges the code for a session, and
  persists it via a file storage adapter at `~/.config/ccshare/session.json`
  (chmod 600). supabase-js auto-refreshes. The daemon is simply *the user*, under the
  same RLS as the browser — no service keys, no custom token system.
- **Anthropic:** untouched. The Agent SDK uses the host's existing Claude Code CLI
  login. ccshare never sees, stores, or transmits Anthropic credentials (PRD G2).

## 8. Failure modes

| Failure | Behavior |
|---|---|
| Host laptop sleeps / daemon killed | Heartbeat lapses → UI shows offline, read-only; `ccshare --resume` continues session and log seamlessly |
| Daemon loses network | Claude keeps working; events spool to disk; flush in order on reconnect |
| Browser loses network | Channel resubscribe + seq catch-up fetch; dedup by seq |
| Turn fails (SDK error result) | `turn_result` with error stop reason rendered in transcript; queue released |
| Permission pending, host AFK | Loud UI state; interrupt available to anyone; notifications deferred (PRD §8) |
| Oversized tool output | Truncated in event, full in `event_blobs`, expand on demand |
| Supabase outage | Sessions keep executing locally; relay resumes via spool; browsers stale until then |
| Anthropic format drift | Contained to `runner/adapter.ts`; golden fixture tests catch it on SDK upgrades |

## 9. Testing strategy

- **Unit (Vitest):** `policy.ts` (full matrix), reducer (property: fold ≡ replay),
  adapter golden tests against recorded SDK-stream fixtures (`fixtures/*.ndjson`),
  queue semantics, EventWriter seq/spool.
- **Integration:** `supabase start` locally; RLS assertions with two real user JWTs
  (guest cannot insert events / approve own requests / read foreign workspaces);
  migration apply-from-zero in CI.
- **E2E (Playwright, milestone M4):** two browser contexts + a daemon against a fake
  SDK runner (adapter behind an interface makes Claude itself mockable): watch,
  drive, queue, interrupt, moderate, replay.
- Real-Claude runs are manual acceptance (they cost tokens): scripted checklist per
  milestone in `docs/acceptance.md`.

## 10. Build checkpoints (one continuous build — not releases)

| M | Delivers | Proves |
|---|---|---|
| M1 | protocol + migrations + daemon (EventWriter, shared runner, adapter) + web read-only live view & replay + `watch` mirror | the spine: SDK → events → relay → reducer → UI |
| M2 | control plane end-to-end in equal mode: send, queue, interrupt, permissions; daemon resume/spool | single-writer control loop + resilience (G1, G3) |
| M3 | moderated mode + ApprovalTray; model/permission-mode controls; slash commands; images; presence/typing/drafts | policy enforcement (G4) + full feature surface |
| M4 | promote/demote flows, session browser polish, Playwright suite, onboarding (login + npx) | hardened v1; full quantdesk pairing session as acceptance |

## 11. Deferred designs (slots exist, nothing built)

- **Cloud runner:** a Railway container implementing the runner interface (§1.4) —
  needs repo provisioning + an Anthropic auth story; schema/web untouched.
- **Notifications:** `permission_request`/`needs_approval` events are already durable
  triggers; delivery channel (web push/email) TBD.
- **Multiplexing daemon service, terminal client, third-party invites, at-rest payload
  encryption:** listed in PRD §8–9.
