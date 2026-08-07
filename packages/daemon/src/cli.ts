#!/usr/bin/env node
import { resolve } from "node:path";
import { PermissionMode, SessionMode } from "@ccshare/protocol";
import { Command } from "commander";
import {
  loginWithBrowser,
  loginWithPassword,
  logout,
  makeClient,
  requireSession,
} from "./auth.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { runMirror } from "./runner/mirror.js";
import { runSharedSession } from "./runner/shared.js";

const program = new Command();

program
  .name("ccshare")
  .description(
    "Multiplayer Claude Code — share live sessions from this machine",
  )
  .version("0.0.1");

program
  .command("login")
  .description("Log in with your ccshare email and password")
  .option("--email <email>", "skip the email prompt")
  .option("--github", "use GitHub OAuth via the browser instead")
  .action(async (opts: { email?: string; github?: boolean }) => {
    const client = makeClient();
    if (opts.github) await loginWithBrowser(client);
    else await loginWithPassword(client, opts.email);
    const { data } = await client.auth.getUser();
    console.log(`Logged in as ${data.user?.email}`);
  });

program
  .command("logout")
  .description("Log out and forget the stored session")
  .action(async () => {
    await logout(makeClient());
    console.log("Logged out.");
  });

program
  .command("whoami")
  .description("Show the logged-in account")
  .action(async () => {
    const client = makeClient();
    await requireSession(client);
    const { data } = await client.auth.getUser();
    console.log(data.user?.email ?? "unknown");
  });

program
  .command("watch")
  .description("Mirror new `claude` TUI sessions to the workspace (read-only)")
  .action(async () => {
    const client = makeClient();
    await requireSession(client);
    await runMirror(client);
  });

program
  .command("start", { isDefault: true })
  .description("Start a shared session in a directory (default: cwd)")
  .argument("[dir]", "project directory", ".")
  .option(
    "--resume <claudeSessionId>",
    "resume an existing Claude Code session",
  )
  .option("--mode <mode>", "equal | moderated", "moderated")
  .option("--model <model>", "model override")
  .option(
    "--permission-mode <mode>",
    "default | plan | acceptEdits | bypassPermissions",
    "default",
  )
  .action(
    async (
      dir: string,
      opts: {
        resume?: string;
        mode: string;
        model?: string;
        permissionMode: string;
      },
    ) => {
      const client = makeClient();
      await requireSession(client);
      await runSharedSession(client, {
        cwd: resolve(dir),
        mode: SessionMode.parse(opts.mode),
        model: opts.model,
        permissionMode: PermissionMode.parse(opts.permissionMode),
        resume: opts.resume,
      });
    },
  );

program.parseAsync().catch((err: unknown) => {
  log.error(String(err instanceof Error ? err.message : err));
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  console.error(`  Web app: ${config.appUrl}`);
  process.exit(1);
});
