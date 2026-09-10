import { z } from "zod";

/**
 * A Procedural Graph over the agent's tool vocabulary.
 *
 * From arXiv:2609.09153. A knowledge graph organises facts into (entity, relation, entity)
 * triplets to answer *what is*; a procedural graph organises a task's procedure into
 * (procedure, relation, procedure) triplets to answer *what to do next*. Nodes are the
 * tools an agent can call plus the states it can be in; an edge says the target is
 * admissible after the source, and carries text describing when, how, and what to avoid.
 *
 * The point is that the guidance is *localized*. The paper's clearest result is not that a
 * graph helps — injecting the whole graph made one benchmark worse than no graph at all —
 * but that the two-hop neighbourhood of wherever the agent currently is helps, and the
 * whole graph does not. A rule stated once at the top of a forty-step run is not the same
 * thing as the same rule restated at the step where it applies.
 *
 * Maestro is an unusually good fit for the localization half: matching the last action to
 * a node is an exact string match against eight tool names, so the paper's lossy fall-back
 * to the full graph — the configuration its own ablation shows doing harm — barely fires.
 *
 * Deliberately not a schema field yet. It is parsed out of `GraphNode.config`, the untyped
 * bag, exactly as `GateConfigSchema` is, so an experiment that does not pay for itself
 * leaves no migration behind.
 */

/** The relation vocabulary. Four labels, as in the paper's own experiments. */
export const PG_RELATIONS = ["LEADS_TO", "REQUIRES", "PROVIDES_INPUT_FOR", "CONVERGES_TO"] as const;

export const ProceduralNodeSchema = z.object({
  /** A tool name, or a state such as `Start`. */
  id: z.string().min(1),
  type: z.enum(["ACTION", "STATE"]).default("ACTION"),
  description: z.string().default(""),
});

export const ProceduralEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  relation: z.enum(PG_RELATIONS).default("LEADS_TO"),
  /** When this transition applies. Absent means unconditionally. */
  condition: z.string().optional(),
  /** How to take it. The one attribute the paper finds is always worth populating. */
  guidance: z.string().min(1),
  /** What goes wrong here. */
  pitfalls: z.string().optional(),
});

export const ProceduralGraphSchema = z.object({
  nodes: z.array(ProceduralNodeSchema).min(1),
  edges: z.array(ProceduralEdgeSchema).default([]),
});

export type ProceduralNode = z.infer<typeof ProceduralNodeSchema>;
export type ProceduralEdge = z.infer<typeof ProceduralEdgeSchema>;
export type ProceduralGraph = z.infer<typeof ProceduralGraphSchema>;

/** The marker for the first step, before any action has been taken. */
export const PG_START = "Start";

/**
 * Reads a graph out of an agent node's `config`, or returns undefined.
 *
 * Undefined rather than throwing, and for a graph that fails to parse as much as for one
 * that is absent: a malformed experiment must degrade to the behaviour without it, not
 * fail a review. `applyGate` treats a malformed gate config the same way, for the same
 * reason.
 *
 * `onInvalid` is the difference between degrading and disappearing. Silence here is the
 * bug class this repository has recorded most often — a configuration written at one end
 * and honoured at neither — and it would be worse than usual, because the review still
 * succeeds and looks exactly like a review that was never meant to have a graph. Nothing
 * else can say so: `validateGraph` is in `@maestro/playbook`, which cannot see this schema
 * without the schema field the experiment deliberately does not have yet.
 *
 * It fires only for a graph that is *present* and wrong. Absent is not a mistake.
 */
export function proceduralGraphFrom(
  config: Record<string, unknown> | undefined,
  onInvalid?: (reason: string) => void,
): ProceduralGraph | undefined {
  const raw = config?.proceduralGraph;
  if (raw === undefined) return undefined;
  const parsed = ProceduralGraphSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  onInvalid?.(
    parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
  );
  return undefined;
}

/**
 * The guidance for one step: the outgoing neighbourhood of wherever the agent is, up to
 * `hops` transitions ahead, serialized for the prompt.
 *
 * `active` is every tool called on the turn just finished — plural because Maestro's loop
 * dispatches `response.toolCalls` in parallel, so there is frequently no single active
 * node. The paper assumes one action per step and says nothing about this; the union of
 * the neighbourhoods is the reading that degrades to its behaviour when there is only one
 * call, which is the property worth keeping.
 *
 * Returns undefined when nothing matches, rather than falling back to the whole graph.
 * That fall-back is in the paper and its own ablation is the argument against it: full
 * graph guidance scored 54.48 on ALFWorld against 72.58 for no graph at all. Saying
 * nothing is the better failure.
 */
export function guidanceFor(
  graph: ProceduralGraph,
  active: readonly string[],
  opts: { hops?: number } = {},
): string | undefined {
  const hops = opts.hops ?? 2;
  const known = new Set(graph.nodes.map((n) => n.id));
  const roots = [...new Set(active.filter((a) => known.has(a)))];
  if (!roots.length) return undefined;

  const out = new Map<string, ProceduralEdge[]>();
  for (const e of graph.edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);

  // Breadth-first, recording the hop each edge was reached at, so the serialization can
  // separate "do this next" from "this is where that leads".
  const byHop: ProceduralEdge[][] = [];
  const seen = new Set<string>();
  let frontier = roots;
  for (let hop = 0; hop < hops && frontier.length; hop++) {
    const edges: ProceduralEdge[] = [];
    const next: string[] = [];
    for (const node of frontier) {
      for (const e of out.get(node) ?? []) {
        const key = `${e.from} ${e.to} ${e.relation}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(e);
        next.push(e.to);
      }
    }
    if (edges.length) byHop.push(edges);
    frontier = [...new Set(next)];
  }
  if (!byHop.length) return undefined;

  const describe = (id: string) => graph.nodes.find((n) => n.id === id)?.description ?? "";
  const lines: string[] = [];
  for (const root of roots) {
    const d = describe(root);
    lines.push(`Active node: [${root}]${d ? ` - ${d}` : ""}`);
  }
  byHop.forEach((edges, i) => {
    lines.push(i === 0 ? "Immediate transitions:" : `Subsequent horizon (hop ${i + 1}):`);
    for (const e of edges) {
      const when = e.condition ? ` (when: ${e.condition})` : "";
      lines.push(`- [${e.from}] to [${e.to}]${when}`);
      lines.push(`  * Guidance: ${e.guidance}`);
      if (e.pitfalls) lines.push(`  * Avoid: ${e.pitfalls}`);
    }
  });
  return lines.join("\n");
}
