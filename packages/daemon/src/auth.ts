import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import readline from "node:readline/promises";
import {
  createClient,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { config, sessionFilePath } from "./config.js";
import { log } from "./log.js";

// The daemon is simply *the user*: a normal Supabase session under normal RLS
// (DESIGN §7). Sessions persist to ~/.config/ccshare/session.json (0600).

function fileStorage() {
  const path = sessionFilePath();
  const data = new Map<string, string>();
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        string
      >;
      for (const [k, v] of Object.entries(parsed)) data.set(k, v);
    } catch {
      // corrupt store — treat as logged out
    }
  }
  const persist = () => {
    writeFileSync(path, JSON.stringify(Object.fromEntries(data)), {
      mode: 0o600,
    });
    chmodSync(path, 0o600);
  };
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
      persist();
    },
    removeItem: (key: string) => {
      data.delete(key);
      persist();
    },
  };
}

export function makeClient(): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: "pkce",
      storage: fileStorage(),
      storageKey: "ccshare-auth",
    },
  });
}

export async function requireSession(client: SupabaseClient): Promise<Session> {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) {
    throw new Error("Not logged in. Run `ccshare login` first.");
  }
  return data.session;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  log.info(`If your browser didn't open, visit:\n  ${url}`);
}

async function listenOnLoginPort(server: http.Server): Promise<number> {
  for (const port of config.loginPorts) {
    const ok = await new Promise<boolean>((resolve) => {
      const onError = () => resolve(false);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve(true);
      });
    });
    if (ok) return port;
  }
  throw new Error(
    `All login callback ports in use (${config.loginPorts.join(", ")})`,
  );
}

// Browser flow: GitHub OAuth via PKCE with a localhost callback.
export async function loginWithBrowser(client: SupabaseClient): Promise<void> {
  const server = http.createServer();
  const port = await listenOnLoginPort(server);
  const redirectTo = `http://127.0.0.1:${port}/auth/callback`;

  const code = new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      const c = url.searchParams.get("code");
      const err = url.searchParams.get("error_description");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        c
          ? "<body style='font-family:monospace'>ccshare: logged in — you can close this tab.</body>"
          : `<body style='font-family:monospace'>ccshare: login failed: ${err ?? "no code"}</body>`,
      );
      if (c) resolve(c);
      else reject(new Error(err ?? "OAuth callback carried no code"));
    });
  });

  const { data, error } = await client.auth.signInWithOAuth({
    provider: "github",
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error || !data.url) {
    server.close();
    throw new Error(`Could not start OAuth flow: ${error?.message}`);
  }
  openBrowser(data.url);

  try {
    const authCode = await code;
    const { error: exchangeError } =
      await client.auth.exchangeCodeForSession(authCode);
    if (exchangeError) throw new Error(exchangeError.message);
  } finally {
    server.close();
  }
}

// TTY flow: email OTP — works even before the GitHub OAuth app exists.
export async function loginWithEmail(
  client: SupabaseClient,
  email: string,
): Promise<void> {
  const { error } = await client.auth.signInWithOtp({ email });
  if (error) throw new Error(`Could not send code: ${error.message}`);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const token = (
    await rl.question(`Enter the 6-digit code sent to ${email}: `)
  ).trim();
  rl.close();
  const { error: verifyError } = await client.auth.verifyOtp({
    email,
    token,
    type: "email",
  });
  if (verifyError)
    throw new Error(`Verification failed: ${verifyError.message}`);
}

export async function logout(client: SupabaseClient): Promise<void> {
  await client.auth.signOut().catch(() => undefined);
  rmSync(sessionFilePath(), { force: true });
}
