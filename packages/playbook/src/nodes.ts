/**
 * The closed node registry.
 *
 * Maestro is deliberately NOT a general workflow builder. A fixed set of node types
 * with typed ports is what lets the canvas be validated at save time and keeps the
 * engine's execution semantics knowable. Adding a node type is a code change; adding
 * an *agent* is not.
 */
export type PortType = "Checkout" | "RouteDecision" | "Finding[]" | "Review";

export type NodeKind = "prepare-env" | "router" | "agent" | "gate" | "triage" | "post";

export interface NodeSpec {
  kind: NodeKind;
  inputs: PortType[];
  outputs: PortType[];
  /** Pinned nodes cannot be added, removed or renamed in the editor. */
  pinned: boolean;
  /**
   * How many of this node a graph may contain.
   *
   * `at-most-one` exists because the engine reads `byKind(k)[0]` for router and triage:
   * a second one was drawable, passed validation, and then silently never ran. A canvas
   * that lets you build something the engine quietly ignores is worse than one that
   * refuses it.
   */
  cardinality: "exactly-one" | "at-most-one" | "any";
  description: string;
}

export const NODE_SPECS: Record<NodeKind, NodeSpec> = {
  "prepare-env": {
    kind: "prepare-env",
    inputs: [],
    outputs: ["Checkout"],
    pinned: true,
    cardinality: "exactly-one",
    description: "Clone at head SHA, detect toolchain, install deps, snapshot the image.",
  },
  router: {
    kind: "router",
    inputs: ["Checkout"],
    outputs: ["RouteDecision"],
    pinned: false,
    // Optional — without one every agent runs — but never more than one.
    cardinality: "at-most-one",
    description: "Decide which agents apply and at what budget tier.",
  },
  agent: {
    kind: "agent",
    inputs: ["Checkout", "RouteDecision"],
    outputs: ["Finding[]"],
    pinned: false,
    cardinality: "any",
    description: "A specialist reviewer running in its own container.",
  },
  gate: {
    kind: "gate",
    inputs: ["Finding[]"],
    outputs: ["Finding[]"],
    pinned: false,
    cardinality: "any",
    description: "Filter findings by severity/confidence before triage.",
  },
  triage: {
    kind: "triage",
    inputs: ["Finding[]"],
    outputs: ["Review"],
    pinned: false,
    // Triage is the fan-in: two of them would produce two reviews for one comment.
    cardinality: "at-most-one",
    description: "Dedupe, calibrate and rank findings into one review.",
  },
  post: {
    kind: "post",
    inputs: ["Review"],
    outputs: [],
    pinned: true,
    cardinality: "exactly-one",
    description: "Publish one consolidated review comment.",
  },
};

/**
 * Teardown is intentionally absent from this registry. It is a guaranteed finalizer the
 * engine runs on every terminal state, so no drawable graph can leak containers.
 */
export const FINALIZER = "teardown" as const;
