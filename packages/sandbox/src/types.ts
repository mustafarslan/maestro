import type { EgressEnforcement, EnvSpec } from "@maestro/playbook";

/**
 * What the prepare phase's network actually was, which is not the same as what was asked
 * for. `EgressEnforcement` is a setting with two values; this adds the third thing that
 * can be true — there was no network at all, because nothing needed one. Deliberately not
 * a third setting: nobody configures "none", it is earned by having no setup commands.
 */
export type EgressPosture = EgressEnforcement | "none";

import type { Toolchain } from "./toolchain.js";

export interface ExecResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /**
   * The caller cancelled this, rather than the command running out of time.
   *
   * Distinct from `timedOut` because they mean opposite things to whoever reads the
   * review: a timeout is a statement about the repository's command, and a cancellation
   * is a statement about Maestro. Conflating them told a reviewer their build had hung
   * when in fact somebody had pushed a new commit.
   */
  aborted?: boolean;
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
  egressLog: { host: string; allowed: boolean; count: number }[];
  /**
   * Whether that log records a control or a convention.
   *
   * The review comment says which. An "advisory" run means a tool ignoring HTTP_PROXY
   * could have reached anything, so reporting the two identically would overstate what
   * the allowlist proved.
   */
  egressEnforcement?: EgressPosture;
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
  /**
   * Destroys containers, volumes, snapshot images AND review networks.
   *
   * Images are where disk goes; networks are what enforcement added. A driver that
   * sweeps only containers leaves both behind, and a review that dies between creating
   * its isolated network and tearing it down leaks one every time.
   */
  reap(opts?: {
    reviewId?: string;
    olderThanMs?: number;
    /**
     * Reviews whose containers must be left alone.
     *
     * Part of the contract, not of one driver: an unscoped sweep matches every managed
     * container including the ones a running daemon is using, and `maestro reap` during a
     * review destroyed it. The Docker driver has honoured this since that was found; the
     * interface did not declare it, so the daemon only typechecked because it happened to
     * hold the concrete class. A second driver written faithfully against this interface
     * would have reintroduced the bug, and the conformance suite could not have known.
     */
    protectReviewIds?: string[];
  }): Promise<{ containers: number; images: number; networks: number }>;
}
