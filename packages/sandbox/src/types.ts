import type { EnvSpec } from "@maestro/playbook";
import type { Toolchain } from "./toolchain.js";

export interface ExecResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface PrepareRequest {
  reviewId: string;
  /** Host path to a checkout. The driver copies it in; the source is never mutated. */
  sourcePath: string;
  spec: EnvSpec;
  signal?: AbortSignal;
}

export interface PreparedEnvironment {
  id: string;
  reviewId: string;
  imageId: string;
  toolchain: Toolchain;
  /** Commands agents are permitted to run, after `auto` expansion. */
  allowedCommands: string[];
  setupResults: ExecResult[];
  egressLog: { host: string; allowed: boolean }[];
  /** True when the dependency layer was reused instead of reinstalled. */
  cacheHit?: boolean;
}

/** One agent's isolated view of the prepared snapshot. */
export interface Sandbox {
  id: string;
  agentId?: string;
  containerId: string;
  exec(command: string, opts?: { timeoutSec?: number }): Promise<ExecResult>;
  readFile(path: string, maxBytes?: number): Promise<string>;
  destroy(): Promise<void>;
}

export interface SandboxDriver {
  readonly name: string;
  available(): Promise<boolean>;
  prepare(req: PrepareRequest): Promise<PreparedEnvironment>;
  /** Each agent gets its own container off the shared snapshot, so concurrent agents
   *  running builds cannot clobber one another's working directory. */
  analyze(env: PreparedEnvironment, opts: { agentId?: string; spec: EnvSpec }): Promise<Sandbox>;
  /** Destroys containers, volumes AND snapshot images — images are where disk goes. */
  reap(opts?: {
    reviewId?: string;
    olderThanMs?: number;
  }): Promise<{ containers: number; images: number }>;
}
