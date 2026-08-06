import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The publishable key is public by design (RLS is the security boundary), so it
// ships as a default; env vars override for local-stack development.
const DEFAULT_SUPABASE_URL = "https://uvzdbfrkyiadeiqimjrn.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "sb_publishable_37poRvOxWwZ_fYgGbBoa4A_hlPxVb6n";

const DEFAULT_APP_URL = "https://ccshare-eight.vercel.app";

function loadDevEnv(): void {
  // pnpm --filter ccshare dev runs with cwd = packages/daemon
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // absent is fine
    }
  }
}
loadDevEnv();

export const config = {
  supabaseUrl: process.env.CCSHARE_SUPABASE_URL ?? DEFAULT_SUPABASE_URL,
  supabaseAnonKey:
    process.env.CCSHARE_SUPABASE_ANON_KEY ?? DEFAULT_SUPABASE_ANON_KEY,
  appUrl: process.env.CCSHARE_APP_URL ?? DEFAULT_APP_URL,
  configDir:
    process.env.CCSHARE_CONFIG_DIR ?? join(homedir(), ".config", "ccshare"),
  // Fixed callback ports registered in the Supabase auth redirect allowlist.
  loginPorts: [41741, 41742, 41743],
  heartbeatIntervalMs: 20_000,
  deltaFlushMs: 80,
  // Streamed payloads above this are truncated; full content goes to event_blobs.
  maxStreamedPayloadBytes: 64_000,
};

export function ensureConfigDir(): string {
  if (!existsSync(config.configDir)) {
    mkdirSync(config.configDir, { recursive: true, mode: 0o700 });
  }
  return config.configDir;
}

export function sessionFilePath(): string {
  return join(ensureConfigDir(), "session.json");
}

export function spoolDir(): string {
  const dir = join(ensureConfigDir(), "spool");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
