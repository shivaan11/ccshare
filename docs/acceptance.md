# Manual acceptance checklist (real Claude — costs tokens)

Run per milestone-closing PR and before calling v1 done. Two people, two
machines (or two browsers + one machine for a first pass).

## Setup (once per person)

- [ ] Sign in at https://ccshare-eight.vercel.app (magic link or GitHub) —
      lands on the session list, workspace membership auto-attached via invite
- [ ] `pnpm install && pnpm --filter ccshare build` in the repo, then
      `node packages/daemon/dist/cli.js login` (or `pnpm --filter ccshare dev login`)
- [ ] `ccshare whoami` prints your email

## Watch (M1)

- [ ] Host: run `ccshare` in a repo → prints session URL; session appears
      "live" in the web list with host attribution
- [ ] Host types a prompt in the terminal → guest's browser shows the user
      message, token-streamed response, tool cards, diffs, thinking
- [ ] Guest reloads mid-turn → full catch-up, no gaps or duplicates
- [ ] `ccshare watch` + a plain `claude` TUI session → appears as read-only
      mirror in the list
- [ ] Ctrl-C the daemon → session shows "ended"; replay works with daemon offline

## Drive (M2)

- [ ] Guest sends a message from the browser (equal mode) → Claude answers it,
      attribution chip shows the author
- [ ] Both send while Claude is working → messages queue visibly, inject in
      order on turn end
- [ ] Guest hits stop mid-turn → turn interrupts within ~1s
- [ ] Permission prompt appears in both browsers; either can answer (equal);
      decision + decider render in the transcript; terminal y/N also still works
- [ ] Kill the daemon mid-turn, `ccshare --resume <claude session id>` →
      transcript continues, browsers reconnect (G3)

## Moderate (M3)

- [ ] Host flips mode to moderated → guest's message parks in the approval
      tray; approve → it reaches Claude; reject → it never does (verify in the
      event log: no user_message event)
- [ ] Guest interrupt still works in moderated mode
- [ ] Model + permission-mode changes work mid-session; settings_change lines
      appear in the transcript
- [ ] Presence avatars + typing show; draft sharing shows ghost text and the
      per-user toggle hides it

## Handoff & hardening (M4)

- [ ] Ended shared session → footer shows both resume commands; each works
      (context intact)
- [ ] Mirror session → promote command shown; after exiting the TUI it resumes
      as a full multiplayer session
- [ ] `pnpm rls-check` passes against the local stack
- [ ] Full quantdesk pairing session end-to-end: plan mode → code → tests →
      commit, both people driving
