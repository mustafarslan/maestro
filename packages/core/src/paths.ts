import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Maestro keeps everything under one root so an uninstall is `rm -rf`.
 * MAESTRO_HOME exists so tests (and parallel dev daemons) get their own tree.
 */
export function maestroHome(): string {
  return process.env.MAESTRO_HOME ?? join(homedir(), ".maestro");
}

export function dbPath(): string {
  return process.env.MAESTRO_DB ?? join(maestroHome(), "maestro.db");
}

export function socketPath(): string {
  return process.env.MAESTRO_SOCKET ?? join(maestroHome(), "maestro.sock");
}

export function workspacesDir(): string {
  return join(maestroHome(), "workspaces");
}

export function logsDir(): string {
  return join(maestroHome(), "logs");
}
