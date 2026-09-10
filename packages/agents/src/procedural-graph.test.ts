import { describe, expect, it } from "vitest";
import {
  guidanceFor,
  PG_START,
  type ProceduralGraph,
  proceduralGraphFrom,
} from "./procedural-graph.js";

const graph: ProceduralGraph = {
  nodes: [
    { id: PG_START, type: "STATE", description: "nothing read yet" },
    { id: "git_diff", type: "ACTION", description: "the change itself" },
    { id: "read_file", type: "ACTION", description: "the code around it" },
    { id: "grep", type: "ACTION", description: "other callers" },
    { id: "run_command", type: "ACTION", description: "evidence" },
    { id: "submit_findings", type: "ACTION", description: "the output" },
  ],
  edges: [
    {
      from: PG_START,
      to: "git_diff",
      relation: "LEADS_TO",
      guidance: "Read the diff before anything else.",
    },
    {
      from: "git_diff",
      to: "read_file",
      relation: "LEADS_TO",
      condition: "the diff names a file you have not read",
      guidance: "Read each changed file once, whole.",
      pitfalls: "Do not read one file in overlapping windows.",
    },
    {
      from: "read_file",
      to: "grep",
      relation: "LEADS_TO",
      guidance: "Find the other callers of what changed.",
    },
    { from: "grep", to: "run_command", relation: "LEADS_TO", guidance: "Confirm a suspicion." },
    {
      from: "run_command",
      to: "submit_findings",
      relation: "CONVERGES_TO",
      guidance: "Submit with the output attached.",
    },
  ],
};

describe("localizing to the active node", () => {
  it("returns the two-hop outgoing neighbourhood, separated by hop", () => {
    const out = guidanceFor(graph, ["git_diff"]) ?? "";

    expect(out).toContain("Active node: [git_diff]");
    expect(out).toContain("[git_diff] to [read_file]");
    expect(out).toContain("Read each changed file once, whole.");
    expect(out).toContain("Avoid: Do not read one file in overlapping windows.");
    // Two hops ahead, and labelled as such: the paper's argument for a neighbourhood over
    // a single edge is that a step is chosen partly by where it leads.
    expect(out).toContain("Subsequent horizon (hop 2)");
    expect(out).toContain("[read_file] to [grep]");
    // Three hops is not two.
    expect(out).not.toContain("[grep] to [run_command]");
  });

  it("unions the neighbourhoods when a turn called several tools at once", () => {
    // Maestro dispatches `response.toolCalls` in parallel, so there is frequently no
    // single active node. The paper assumes one action per step and says nothing about
    // this; a real run in this repository issued git_diff and list_dir on one turn and
    // read_file and git_log on the next.
    const out = guidanceFor(graph, ["git_diff", "grep"]) ?? "";
    expect(out).toContain("Active node: [git_diff]");
    expect(out).toContain("Active node: [grep]");
    expect(out).toContain("[git_diff] to [read_file]");
    expect(out).toContain("[grep] to [run_command]");
  });

  it("says nothing rather than falling back to the whole graph", () => {
    // The fall-back is in the paper and its own ablation is the argument against it: full
    // graph guidance scored 54.48 on ALFWorld against 72.58 for no graph at all. An
    // unmatched step gets silence, which is the cheaper failure.
    expect(guidanceFor(graph, ["git_blame"])).toBeUndefined();
    expect(guidanceFor(graph, [])).toBeUndefined();
  });

  it("says nothing for a node with nowhere to go", () => {
    expect(guidanceFor(graph, ["submit_findings"])).toBeUndefined();
  });

  it("localizes the first step at Start, which has no prior tool call", () => {
    const out = guidanceFor(graph, [PG_START]) ?? "";
    expect(out).toContain("Read the diff before anything else.");
  });

  it("does not repeat an edge reachable by two paths", () => {
    const diamond: ProceduralGraph = {
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }].map((n) => ({
        ...n,
        type: "ACTION" as const,
        description: "",
      })),
      edges: [
        { from: "a", to: "b", relation: "LEADS_TO", guidance: "g1" },
        { from: "a", to: "c", relation: "LEADS_TO", guidance: "g2" },
        { from: "b", to: "d", relation: "LEADS_TO", guidance: "shared" },
        { from: "c", to: "d", relation: "LEADS_TO", guidance: "shared" },
      ],
    };
    const out = guidanceFor(diamond, ["a"]) ?? "";
    expect(out.match(/\* Guidance: shared/g)).toHaveLength(2);
    // Both are real edges from different sources; what must not repeat is one edge.
    expect(out.match(/\[b\] to \[d\]/g)).toHaveLength(1);
  });
});

describe("reading a graph out of a node's config", () => {
  it("returns undefined when the node carries none", () => {
    expect(proceduralGraphFrom(undefined)).toBeUndefined();
    expect(proceduralGraphFrom({})).toBeUndefined();
  });

  it("degrades to no guidance rather than failing the review on a malformed one", () => {
    // The same posture as `applyGate` on a malformed gate config. A broken experiment
    // must cost the guidance, never the review.
    expect(proceduralGraphFrom({ proceduralGraph: { nodes: [] } })).toBeUndefined();
    expect(proceduralGraphFrom({ proceduralGraph: "not a graph" })).toBeUndefined();
    expect(
      proceduralGraphFrom({
        // An edge with no guidance is the one field the paper finds always worth having.
        proceduralGraph: { nodes: [{ id: "a" }], edges: [{ from: "a", to: "a" }] },
      }),
    ).toBeUndefined();
  });

  it("parses a well-formed one and defaults what it may", () => {
    const parsed = proceduralGraphFrom({
      proceduralGraph: {
        nodes: [{ id: "git_diff" }, { id: "read_file" }],
        edges: [{ from: "git_diff", to: "read_file", guidance: "read it" }],
      },
    });
    expect(parsed?.nodes[0]).toEqual({ id: "git_diff", type: "ACTION", description: "" });
    expect(parsed?.edges[0]?.relation).toBe("LEADS_TO");
  });
});
