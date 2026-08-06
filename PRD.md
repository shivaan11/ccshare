# ccshare — Product Requirements

**Status:** Draft v1 · pre-build
**Owners:** Shivaan Sood, Anmol Sinha
**Last updated:** 2026-08-06

Multiplayer Claude Code: a web surface where two people watch and drive the same
Claude Code session in real time — Google Docs-style simultaneous work, for agentic
coding. Sessions execute on the host's own machine, on the host's own Claude
subscription; the cloud only coordinates.

This document states *what* is being built and how success is measured.
[DESIGN.md](DESIGN.md) covers implementation detail; where they disagree, DESIGN.md is
the implementation truth and this file is the intent. Development conventions live in
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## 1. Problem

Two people building a project together (concretely: quantdesk) each run Claude Code
locally. Today, collaboration means screen-sharing a terminal or pasting transcripts —
one person drives, the other dictates. There is no way to:

- watch a partner's Claude Code session live,
- send messages into it, interrupt it, or answer its permission prompts remotely,
- keep a shared, browsable archive of the sessions that built the project.

Cloud AI-pairing products exist, but they run the agent on *their* compute with *their*
billing, losing everything that makes a local Claude Code setup yours: the real working
copy, local MCP servers (browser, databases, CLIs authenticated via OS keychain),
skills, hooks, `CLAUDE.md`, permission allowlists — and subscription pricing.

## 2. Goals

### 2.1 Primary

| # | Goal | Measured by |
|---|---|---|
| G1 | A session hosted on machine A is fully drivable from machine B's browser | Guest can send messages, interrupt, and answer permission prompts; p50 event latency under ~1s |
| G2 | Execution stays local; billing stays with the host | Claude Code runs only on the host's machine via their logged-in CLI; no Anthropic credentials ever leave the host machine |
| G3 | Sessions survive disruption | Daemon killed mid-turn and restarted → session resumes with transcript intact; browsers reconnect and catch up automatically |
| G4 | Moderation is enforceable, not advisory | In moderated mode, no guest-authored input reaches Claude without a recorded host approval event (enforced in the daemon, auditable in the event log) |
| G5 | The archive is the record | Any workspace member can open and replay any past session, including while the host is offline |
| G6 | Solo workflow is untouched | Normal `claude` TUI usage works exactly as before; mirrored TUI sessions are additionally watchable read-only |

### 2.2 Explicit non-goals

- **Cloud execution.** No Claude Code in containers, no OAuth tokens on servers. (The
  protocol is runner-agnostic so a cloud runner could be added later; v1 does not build it.)
- **Simultaneous dual input surfaces on one session.** A session's input is owned either
  by the TUI or by the daemon at any moment; handoff between them is via resume.
- **A public product.** This is a trusted-workspace tool. No open signup funnels, no
  public share links.

## 3. Users & trust model

Two users in one **workspace** (Shivaan, Anmol). Sessions are shared to the workspace;
anyone in the workspace can view and (per mode) control them.

**The trust model is explicit and must be stated in the UI:** joining someone's session
with control rights means influencing an agent that executes commands on their machine.
Equal mode is consenting-cofounders territory. Invites are per-person to the workspace;
there are no public or link-only sessions. Adding a person to the workspace is adding
them to this trust boundary.

## 4. Architecture overview

The cloud is a **coordination plane, not an execution plane.**

```
Shivaan's Mac                                          Anmol's Mac
┌─────────────────────────┐                  ┌─────────────────────────┐
│ ccshare daemon           │                  │ ccshare daemon           │
│  ├─ headless Claude Code │                  │  ├─ headless Claude Code │
│  │   (Agent SDK, logged- │                  │  │   (his login/plan)    │
│  │    in CLI, his plan)  │                  │  └─ TUI mirror (tail     │
│  └─ TUI mirror (tail     │                  │      ~/.claude jsonl)    │
│      ~/.claude jsonl)    │                  └────────────┬────────────┘
└────────────┬────────────┘                               │
             │  events up · control down (outbound websockets only)
             ▼                                             ▼
        ┌─────────────────────────────────────────────────────┐
        │ Supabase                                            │
        │  Auth (GitHub OAuth) · Postgres (registry + event   │
        │  log) · Realtime (relay: streams, presence, control)│
        │  Storage (image attachments) · RLS everywhere       │
        └──────────────────────────┬──────────────────────────┘
                                   ▼
        ┌─────────────────────────────────────────────────────┐
        │ Next.js web app on Vercel                           │
        │  session list · live multiplayer view · replay      │
        └─────────────────────────────────────────────────────┘
```

- **Symmetric daemons.** Both users run the daemon. Whoever shares a session is its
  **host**: it executes on their machine, against their checkout, on their subscription.
  Session cards show `hosted by <user> · <user>'s plan`.
- **No Railway in v1.** The daemon is the compute; Supabase is the relay. Railway is
  reserved for a possible future cloud runner.
- **Runner-agnostic protocol.** A runner (today: local daemon) emits session events and
  consumes control events. The web app and schema never assume where the runner lives.

### 4.1 Session tiers

| Tier | Started by | Host input | Guest input | Mechanism |
|---|---|---|---|---|
| Solo TUI | `claude` in terminal | TUI | — | untouched |
| Mirrored | `claude` + daemon running | TUI | read-only watch | daemon tails `~/.claude/projects/…/<session>.jsonl` |
| Shared | `ccshare` in a repo dir | web UI | web UI (per mode) | headless via Claude Agent SDK, streaming input |

**Handoff (promote/demote):** Claude Code sessions are resumable by ID. Exiting the TUI
and promoting resumes the same session headless as a shared session with context
intact; ending a shared session leaves it resumable solo via `claude --resume`. One
input owner at a time; handoff is explicit.

## 5. Requirements

### 5.1 Daemon / CLI (`ccshare`, TypeScript, npm)

- R1. `ccshare login` — device-link auth: opens the web app, user confirms, daemon
  stores a Supabase refresh token locally (`~/.config/ccshare/`). The daemon acts *as
  the host user* (user JWT + RLS, not a service key).
- R2. `ccshare` in a directory — starts a shared session: spawns headless Claude Code
  via the Claude Agent SDK (streaming input mode, partial message events on), registers
  the session, prints the web URL.
- R3. `ccshare --resume <id>` — resume a previous Claude Code session as a shared
  session (this is also the promote path for TUI sessions).
- R4. `ccshare watch` — mirror mode: watches `~/.claude/projects/` transcript JSONL
  files and streams live TUI sessions to the workspace read-only.
- R5. Event pipeline: normalize SDK/transcript events → append to Postgres event log +
  broadcast on the session's Realtime channel. Token-level text deltas are broadcast
  (coalesced, ~30Hz) but not persisted; final messages are persisted whole.
- R6. Control consumption: execute `send_message`, `interrupt`, `permission_answer`,
  `set_mode` (session mode), `set_permission_mode`, `set_model`, honoring the session's
  moderation policy (§5.3). All mutations are recorded as events with author identity.
- R7. Permission routing: the SDK's `canUseTool` callback publishes a
  `permission_request` event and blocks until a `permission_decision` control event
  resolves it. The host's existing local allowlists/settings still apply first (things
  auto-allowed locally never surface as prompts).
- R8. Resilience: reconnect with backoff; heartbeat drives the session's live/offline
  status; on daemon restart, resume the Claude session by ID and continue the event log
  without gaps (event `seq` is authoritative).
- R9. Message attribution: injected user messages are prefixed with the author
  (`[anmol]: …`) so Claude knows who is speaking; author identity is also stored
  structurally on the event.

### 5.2 Web app (Next.js on Vercel)

- R10. Auth via Supabase — email magic link (zero-config default) plus GitHub OAuth
  once registered. Workspace membership gates everything.
- R11. Session list: live sessions first (host, project/cwd, mode, who's viewing),
  then archived, per project. Opening an archived or offline-host session shows a
  full read-only replay.
- R12. Live session view renders the **full agent stream**: token-streamed assistant
  text, thinking, every tool call with inputs/outputs (collapsible), file diffs rendered
  properly, todo-list state, permission prompts, and status (working/idle/waiting).
  Large tool outputs are truncated in the stream with full payloads on expand.
- R13. Composer: send messages; messages sent while Claude is working **queue visibly**
  ("queued · anmol") and inject as the next user turn. A separate, deliberate
  **Interrupt** control stops the current turn. Slash commands (`/foo`) pass through to
  the session's skill/command system. Images can be pasted/dropped (Supabase Storage)
  and attached to messages.
- R14. Session controls: model picker and permission-mode toggle
  (default / plan / accept-edits), at start and mid-session; session mode toggle
  (equal ⇄ moderated, host-only).
- R15. Permission prompt cards: rendered inline with tool name + input summary;
  answerable per mode rules; the decision and decider are shown in the transcript.
- R16. Presence & awareness: avatars of connected viewers, "X is typing…", and **live
  draft sharing** (see each other's in-progress composer text) with a per-user toggle
  to keep drafts private.
- R17. Approval tray (moderated mode): host sees pending guest actions (messages,
  setting changes) and approves/rejects; guests see the pending state of their own
  actions. Nothing pending is ever silently dropped.
- R18. Responsive enough to read and approve from a phone browser; desktop is the
  primary target.

### 5.3 Modes & concurrency

Two per-session modes, host-switchable live:

| Guest action | Equal | Moderated |
|---|---|---|
| Send message / slash command / image | executes (queues if mid-turn) | pending → host approval |
| Answer permission prompt | either party, first decision wins | host only |
| Change model / permission mode | executes | pending → host approval |
| Interrupt | allowed | allowed |
| Promote/demote, end session | host only | host only |

Moderation is enforced in the **daemon** (the trust boundary), not just hidden in the UI.

### 5.4 Data model & realtime (Supabase)

Postgres (all tables RLS'd to workspace membership):

```
workspaces(id, name)
workspace_members(workspace_id, user_id, role)
sessions(id, workspace_id, host_user_id, kind: shared|mirror, status: live|ended,
         mode: equal|moderated, title, cwd, model, claude_session_id,
         created_at, ended_at)
events(id, session_id, seq, type, author_user_id?, payload jsonb, created_at)
         -- append-only; seq strictly increasing per session
pending_actions(id, session_id, requested_by, action jsonb,
                status: pending|approved|rejected, decided_by, decided_at)
attachments(id, session_id, uploader_id, storage_path, mime)
```

Event types (durable): `user_message`, `assistant_message`, `thinking`, `tool_use`,
`tool_result`, `permission_request`, `permission_decision`, `status_change`,
`mode_change`, `settings_change`, `session_started`, `session_ended`.

Realtime channels per session:
- **stream** — durable events as they append, plus ephemeral coalesced text deltas;
- **presence** — viewers, typing, shared drafts;
- **control** — browser → daemon actions (daemon is the sole consumer; policy in §5.3).

Late join / reconnect: load durable events from Postgres by `seq`, then tail the stream
channel. This same path is replay (just without the tail).

## 6. Success criteria

Full v1 ships before daily use begins — nothing below is released piecemeal. The
phases are **integration checkpoints within one continuous build**, ordered so that
each layer of a distributed system (daemon ↔ Supabase ↔ browsers) is proven before the
next is debugged on top of it. Each phase gates the next.

### Phase 1 — Watch
Daemon streams a real session; the other person watches it live in the browser
(read-only), with catch-up on join and replay after end. TUI mirror included (R4).

### Phase 2 — Drive (equal mode)
Both users send messages, queue mid-turn, interrupt, and answer permission prompts from
the browser. G1 latency met. Daemon-restart recovery (G3) demonstrated.

### Phase 3 — Moderate & polish
Moderated mode with approval tray (G4 auditability). Model/permission-mode controls,
slash commands, images, draft sharing with toggle, presence.

### Phase 4 — Hardened v1
Promote/demote handoff flows. Session browser polish. Both users onboarded
(login + daemon installed) and a full quantdesk pairing session run end-to-end as
acceptance test. Then: dogfood on quantdesk daily.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Headless (SDK) sessions diverge behaviorally from the TUI (feature gaps, e.g. some slash commands) | Document divergences; handoff-to-TUI via resume is the escape hatch for anything the SDK can't do |
| Anthropic changes SDK/CLI event formats or transcript JSONL | Pin versions; normalize into our own event schema at the daemon boundary so breakage is contained to one adapter |
| Permission prompt pending while host is AFK blocks the session | Prompt state is loud in UI; interrupt always available; notifications are a fast-follow (§9) |
| Transcripts (containing code) live in Supabase | RLS to workspace only; no public links; at-rest encryption of payloads is an open question (§8) |
| Realtime payload/rate limits vs. huge tool outputs and token streams | Truncate stream payloads with Postgres holding full content; coalesce deltas; chunk oversized events |
| Guest control = code execution on host machine | Explicit trust model (§3), moderated mode as default for new sessions, full audit trail in event log |

## 8. Open questions

- Default mode for new sessions: equal or moderated? (Leaning moderated-by-default,
  flip to equal per session.)
- Notifications when input is needed (permission pending, approval pending) — push?
  email? Deferred, but the schema should not preclude it.
- Retention: keep everything forever, or archive/compact old event payloads?
- Should mirrored sessions surface permission prompts remotely (feasible via a
  PreToolUse hook that defers to the web)? Deferred — mirror is read-only in v1.
- At-rest encryption of event payloads (host-side key) if the transcript archive grows
  sensitive.

## 9. Out of scope for v1

- Cloud runner (Railway) and any always-on/laptop-asleep story
- Remote session start (guest spawning sessions on the host's machine)
- Third-party/public sharing; more than one workspace per user
- Human-to-human side chat (use iMessage/Discord)
- Terminal client for shared sessions; native mobile apps
- Push/email notifications
- Voice, cursors-over-code, or editing files directly in the web UI
