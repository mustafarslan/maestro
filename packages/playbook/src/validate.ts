import { NODE_SPECS, type PortType } from "./nodes.js";
import { type PlaybookDocument, PlaybookDocumentSchema } from "./schema.js";

export interface ValidationIssue {
  code: string;
  message: string;
  /** Node/edge/agent the issue attaches to, so the editor can highlight it inline. */
  target?: string;
}

export class PlaybookInvalidError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(`playbook invalid: ${issues.map((i) => i.message).join("; ")}`);
    this.name = "PlaybookInvalidError";
  }
}

/**
 * Graph invariants enforced at save time. An invalid playbook cannot be published,
 * which is what keeps the engine free of defensive checks at execution time.
 */
export function validateGraph(doc: PlaybookDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { nodes, edges } = doc.graph;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  if (byId.size !== nodes.length) {
    issues.push({ code: "duplicate-node-id", message: "node ids must be unique" });
  }

  // ── Cardinality of pinned structural nodes ────────────────────────────────
  for (const spec of Object.values(NODE_SPECS)) {
    if (spec.cardinality === "any") continue;
    const count = nodes.filter((n) => n.kind === spec.kind).length;

    if (spec.cardinality === "exactly-one" && count !== 1) {
      issues.push({
        code: "cardinality",
        message: `graph must contain exactly one '${spec.kind}' node (found ${count})`,
        target: spec.kind,
      });
    }
    // The engine executes only the first of these, so a second is silent dead work.
    if (spec.cardinality === "at-most-one" && count > 1) {
      issues.push({
        code: "cardinality",
        message: `graph may contain at most one '${spec.kind}' node (found ${count}); only the first would run`,
        target: spec.kind,
      });
    }
  }

  // ── Edge endpoints exist, and ports are type-compatible ───────────────────
  for (const e of edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    const label = `${e.from} -> ${e.to}`;
    if (!from) {
      issues.push({
        code: "dangling-edge",
        message: `edge ${label}: unknown source`,
        target: label,
      });
      continue;
    }
    if (!to) {
      issues.push({
        code: "dangling-edge",
        message: `edge ${label}: unknown target`,
        target: label,
      });
      continue;
    }
    if (e.from === e.to) {
      issues.push({ code: "self-loop", message: `edge ${label}: self-loop`, target: label });
      continue;
    }
    const produced = NODE_SPECS[from.kind].outputs;
    const accepted = NODE_SPECS[to.kind].inputs;
    if (produced.length === 0) {
      issues.push({
        code: "port-type",
        message: `edge ${label}: '${from.kind}' is a sink and produces nothing`,
        target: label,
      });
      continue;
    }
    if (!produced.some((p: PortType) => accepted.includes(p))) {
      issues.push({
        code: "port-type",
        message: `edge ${label}: '${from.kind}' emits ${produced.join("|")} which '${to.kind}' does not accept (${accepted.join("|")})`,
        target: label,
      });
    }
  }

  // ── Acyclic (DFS with colouring) ──────────────────────────────────────────
  const adjacency = new Map<string, string[]>();
  for (const n of nodes) adjacency.set(n.id, []);
  for (const e of edges) adjacency.get(e.from)?.push(e.to);

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>(nodes.map((n) => [n.id, WHITE]));
  const stack: string[] = [];
  let cycleFound = false;

  const visit = (id: string): void => {
    if (cycleFound) return;
    colour.set(id, GREY);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const c = colour.get(next);
      if (c === GREY) {
        const from = stack.indexOf(next);
        issues.push({
          code: "cycle",
          message: `graph contains a cycle: ${[...stack.slice(from), next].join(" -> ")}`,
        });
        cycleFound = true;
        return;
      }
      if (c === WHITE) visit(next);
    }
    stack.pop();
    colour.set(id, BLACK);
  };
  for (const n of nodes) if (colour.get(n.id) === WHITE) visit(n.id);

  // ── Reachability: every node on a path from the source to the sink ────────
  const source = nodes.find((n) => n.kind === "prepare-env");
  const sink = nodes.find((n) => n.kind === "post");
  if (source && sink && !cycleFound) {
    const forward = new Set<string>();
    const walk = (id: string) => {
      if (forward.has(id)) return;
      forward.add(id);
      for (const next of adjacency.get(id) ?? []) walk(next);
    };
    walk(source.id);

    const reverse = new Map<string, string[]>();
    for (const n of nodes) reverse.set(n.id, []);
    for (const e of edges) reverse.get(e.to)?.push(e.from);
    const backward = new Set<string>();
    const walkBack = (id: string) => {
      if (backward.has(id)) return;
      backward.add(id);
      for (const prev of reverse.get(id) ?? []) walkBack(prev);
    };
    walkBack(sink.id);

    if (!forward.has(sink.id)) {
      issues.push({
        code: "unreachable-sink",
        message: `no path from '${source.id}' to '${sink.id}': the review could never post`,
        target: sink.id,
      });
    }
    for (const n of nodes) {
      if (!forward.has(n.id) || !backward.has(n.id)) {
        issues.push({
          code: "orphan-node",
          message: `node '${n.id}' is not on a path from '${source.id}' to '${sink.id}'`,
          target: n.id,
        });
      }
    }
  }

  // ── Referential integrity: nodes and router rules must name real agents ───
  const agentIds = new Set(doc.agents.map((a) => a.id));
  for (const n of nodes) {
    if (n.kind !== "agent") continue;
    if (!n.agentId) {
      issues.push({
        code: "missing-agent-ref",
        message: `agent node '${n.id}' has no agentId`,
        target: n.id,
      });
    } else if (!agentIds.has(n.agentId)) {
      issues.push({
        code: "unknown-agent-ref",
        message: `agent node '${n.id}' references unknown agent '${n.agentId}'`,
        target: n.id,
      });
    }
  }
  for (const rule of doc.router.rules) {
    if (!agentIds.has(rule.agentId)) {
      issues.push({
        code: "unknown-agent-ref",
        message: `router rule references unknown agent '${rule.agentId}'`,
        target: rule.agentId,
      });
    }
  }

  // ── Routing mode: refuse the setting that does nothing ───────────────────
  // `mode: "llm"` and `router.model` describe optional LLM refinement of the routing
  // decision. The router is deterministic and reads neither, so selecting "llm" changed
  // nothing at all and the playbook looked like it was doing something it was not. A
  // knob nobody implemented has to fail loudly rather than silently behave as its
  // opposite; the field stays so an existing playbook still parses and the message says
  // what to do.
  if (doc.router.mode !== "deterministic") {
    issues.push({
      code: "unimplemented-router-mode",
      message:
        `router.mode '${doc.router.mode}' is not implemented: routing is deterministic ` +
        "(path globs, diff size, skip rules). Set mode to 'deterministic'.",
      target: "router.mode",
    });
  }
  if (doc.router.model) {
    // Binding a model here reads as "the router will call it", and it never does. Worse,
    // it is the one binding that would cost money on every pull request, so leaving it
    // accepted-and-ignored is the least honest of the possible behaviours.
    issues.push({
      code: "unimplemented-router-mode",
      message:
        "router.model is only used by LLM routing refinement, which is not implemented. " +
        "Remove it; the deterministic router calls no model.",
      target: "router.model",
    });
  }

  // ── Command allowlist deny-patterns: config is an attack surface too ──────
  const denied = /(?:^|[\s;|&])(curl|wget|nc|ncat|ssh|scp)\b|[|&;`$(){}<>]|\.\.\//;
  for (const cmd of doc.envSpec.allowedCommands) {
    if (cmd === "auto") continue;
    if (denied.test(cmd)) {
      issues.push({
        code: "unsafe-command",
        message: `allowedCommands entry '${cmd}' contains a shell metacharacter or network tool`,
        target: cmd,
      });
    }
  }

  return issues;
}

/** Parse + validate in one step. Throws PlaybookInvalidError with every issue at once. */
export function parsePlaybook(input: unknown): PlaybookDocument {
  const doc = PlaybookDocumentSchema.parse(input);
  const issues = validateGraph(doc);
  if (issues.length) throw new PlaybookInvalidError(issues);
  return doc;
}

export function safeParsePlaybook(
  input: unknown,
): { ok: true; doc: PlaybookDocument } | { ok: false; issues: ValidationIssue[] } {
  const parsed = PlaybookDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        code: "schema",
        message: `${i.path.join(".") || "(root)"}: ${i.message}`,
        target: i.path.join("."),
      })),
    };
  }
  const issues = validateGraph(parsed.data);
  return issues.length ? { ok: false, issues } : { ok: true, doc: parsed.data };
}
