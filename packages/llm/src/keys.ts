import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { maestroHome } from "@maestro/core";

const exec = promisify(execFile);
const SERVICE = "maestro";

/**
 * Secret storage.
 *
 * Shells out to the OS keychain rather than using a library: `keytar` and friends are
 * native addons and do not survive `bun build --compile`. Falls back to a 0600 file so
 * a fresh install always works, including on a headless box.
 */
export interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
  readonly backend: string;
}

function filePath(): string {
  return join(maestroHome(), "secrets.json");
}

/**
 * Reads the store, treating an unreadable file as empty rather than throwing.
 *
 * A truncated or hand-edited secrets.json would otherwise crash every command that
 * resolves a key, with a JSON parse error that names neither the file nor the fix. An
 * empty store degrades to "no key configured", which the callers already handle and which
 * says something true.
 */
function readAll(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Writes the store atomically.
 *
 * Every key lives in one JSON object, so a partial write does not corrupt one entry — it
 * destroys all of them. Writing a temp file in the same directory and renaming makes the
 * replacement atomic on POSIX: a crash leaves either the old file or the new one, never
 * a half-written one. The temp file is created 0600 so the secret is never briefly
 * readable by anyone else.
 */
function writeAll(path: string, data: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Nothing useful to do; the original file is intact either way.
    }
    throw err;
  }
}

const fileStore: SecretStore = {
  backend: "file",
  async get(account) {
    return readAll(filePath())[account];
  },
  async set(account, secret) {
    const path = filePath();
    const data = readAll(path);
    data[account] = secret;
    writeAll(path, data);
  },
  async delete(account) {
    const path = filePath();
    if (!existsSync(path)) return;
    const data = readAll(path);
    delete data[account];
    writeAll(path, data);
  },
};

const macKeychain: SecretStore = {
  backend: "keychain",
  async get(account) {
    try {
      const { stdout } = await exec("security", [
        "find-generic-password",
        "-s",
        SERVICE,
        "-a",
        account,
        "-w",
      ]);
      return stdout.trim() || undefined;
    } catch {
      return undefined; // not found is the common case, not an error
    }
  },
  async set(account, secret) {
    // -U updates in place when the entry already exists.
    await exec("security", [
      "add-generic-password",
      "-s",
      SERVICE,
      "-a",
      account,
      "-w",
      secret,
      "-U",
    ]);
  },
  async delete(account) {
    try {
      await exec("security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
    } catch {
      // already absent
    }
  },
};

const secretTool: SecretStore = {
  backend: "secret-tool",
  async get(account) {
    try {
      const { stdout } = await exec("secret-tool", [
        "lookup",
        "service",
        SERVICE,
        "account",
        account,
      ]);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  },
  async set(account, secret) {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "secret-tool",
        ["store", "--label", `${SERVICE} ${account}`, "service", SERVICE, "account", account],
        (err) => (err ? reject(err) : resolve()),
      );
      child.stdin?.end(secret);
    });
  },
  async delete(account) {
    try {
      await exec("secret-tool", ["clear", "service", SERVICE, "account", account]);
    } catch {
      // already absent
    }
  },
};

async function available(cmd: string, args: string[]): Promise<boolean> {
  try {
    await exec(cmd, args, { timeout: 5_000 });
    return true;
  } catch (err) {
    // A non-zero exit still proves the binary exists; only ENOENT means unavailable.
    return (err as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}

let cached: SecretStore | undefined;

export async function secretStore(): Promise<SecretStore> {
  if (cached) return cached;
  if (process.env.MAESTRO_SECRETS === "file") {
    cached = fileStore;
  } else if (process.platform === "darwin" && (await available("security", ["-h"]))) {
    cached = macKeychain;
  } else if (process.platform === "linux" && (await available("secret-tool", ["--help"]))) {
    cached = secretTool;
  } else {
    cached = fileStore;
  }
  return cached;
}

/** Environment variables win, so CI and one-off runs need no keychain interaction. */
export async function resolveApiKey(providerId: string, kind: string): Promise<string | undefined> {
  const envNames: Record<string, string[]> = {
    anthropic: ["ANTHROPIC_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
    "openai-compatible": [],
  };
  const specific = process.env[`MAESTRO_KEY_${providerId.toUpperCase().replaceAll("-", "_")}`];
  if (specific) return specific;
  for (const name of envNames[kind] ?? []) {
    if (process.env[name]) return process.env[name];
  }
  return (await secretStore()).get(providerId);
}
