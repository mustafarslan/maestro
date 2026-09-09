import {
  Background,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AgentDef,
  api,
  type Issue,
  type PlaybookDiff,
  type PlaybookDoc,
  type PlaybookResponse,
  type ProvidersResponse,
} from "./api";

/** Pinned nodes are structural: the editor must not let them be removed or rewired away. */
const PINNED = new Set(["prepare-env", "post"]);

function FlowNode({ data }: NodeProps) {
  const d = data as { label: string; kind: string; pinned: boolean; disabled: boolean };
  return (
    <div
      className={`node-box ${d.kind === "agent" ? "agent" : ""} ${d.pinned ? "pinned" : ""} ${d.disabled ? "disabled" : ""}`}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ fontWeight: 600 }}>{d.label}</div>
      <div className="node-kind">
        {d.kind}
        {d.pinned ? " · pinned" : ""}
        {d.disabled ? " · disabled" : ""}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { maestro: FlowNode };

export function Studio({ providers }: { providers: ProvidersResponse | null }) {
  const [data, setData] = useState<PlaybookResponse | null>(null);
  const [doc, setDoc] = useState<PlaybookDoc | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  /** Per-agent "test connection" results, keyed by agent id. */
  const [tests, setTests] = useState<
    Record<string, { state: "running" | "done"; message: string }>
  >({});

  /**
   * One real round trip through the provider this agent is bound to.
   *
   * A reachability check that does not call the model would pass for a model that cannot
   * use tools, and a review agent bound to one of those fails minutes into a review with
   * an error nobody connects back to this screen. So the check is the same conformance
   * round trip `maestro llm test` runs, and it reports the tool result specifically.
   */
  const testBinding = async (agentId: string, providerId: string, model: string) => {
    setTests((t) => ({ ...t, [agentId]: { state: "running", message: "calling the provider…" } }));
    try {
      const res = await api.testProvider(providerId, model);
      const message = !res.ok
        ? (res.error ?? "failed")
        : res.report?.observed.tools === false
          ? "reachable, but this model cannot call tools — unusable for a review agent"
          : `${res.report?.checks.filter((c) => c.passed).length ?? 0}/${res.report?.checks.length ?? 0} checks passed` +
            `, ${((res.report?.costCents ?? 0) / 100).toFixed(4)} spent`;
      setTests((t) => ({ ...t, [agentId]: { state: "done", message } }));
    } catch (err) {
      setTests((t) => ({ ...t, [agentId]: { state: "done", message: String(err) } }));
    }
  };

  const load = useCallback(() => {
    api.playbook().then((d) => {
      setData(d);
      if (d.active) setDoc(structuredClone(d.active.doc));
    });
  }, []);
  useEffect(load, [load]);

  const dirty = useMemo(
    () => Boolean(doc && data?.active && JSON.stringify(doc) !== JSON.stringify(data.active.doc)),
    [doc, data],
  );

  // Validate against the server, not in the browser: the same rules must apply to every
  // client, and the engine must never receive a graph the editor considered acceptable.
  useEffect(() => {
    if (!doc || !dirty) {
      setIssues([]);
      return;
    }
    const timer = setTimeout(() => {
      api.validatePlaybook(doc).then((r) => setIssues(r.ok ? [] : (r.issues ?? [])));
    }, 400);
    return () => clearTimeout(timer);
  }, [doc, dirty]);

  /**
   * Whether an edge the user is drawing is one the validator would accept.
   *
   * The same rule, deliberately: the ports a node produces must intersect the ports the
   * target accepts, a sink produces nothing, and nothing may join itself. The registry
   * carrying those ports already arrives with the playbook, so the canvas can answer
   * before the edge exists rather than letting the graph become invalid and reporting it
   * at publish.
   *
   * If this and `validateGraph` ever disagree, the validator is right — it is what the
   * engine runs on — and this only decides what the mouse will let go of.
   */
  const connectionAllowed = useCallback(
    (from: string | null, to: string | null): { ok: boolean; reason: string } => {
      if (!doc || !data || !from || !to) return { ok: false, reason: "incomplete connection" };
      if (from === to) return { ok: false, reason: "a node cannot feed itself" };

      const kindOf = (id: string) => doc.graph.nodes.find((n) => n.id === id)?.kind;
      const specOf = (id: string) => data.nodeRegistry.find((n) => n.kind === kindOf(id));
      const source = specOf(from);
      const target = specOf(to);
      if (!source || !target) return { ok: false, reason: "unknown node" };

      if (source.outputs.length === 0) {
        return { ok: false, reason: `'${source.kind}' is a sink and produces nothing` };
      }
      if (!source.outputs.some((o) => target.inputs.includes(o))) {
        return {
          ok: false,
          reason: `'${source.kind}' emits ${source.outputs.join("|")} which '${target.kind}' does not accept (${target.inputs.join("|")})`,
        };
      }
      return { ok: true, reason: "" };
    },
    [doc, data],
  );

  const { nodes, edges } = useMemo(() => {
    if (!doc) return { nodes: [] as Node[], edges: [] as Edge[] };
    const agentById = new Map(doc.agents.map((a) => [a.id, a]));
    return {
      nodes: doc.graph.nodes.map((n): Node => {
        const agent = n.agentId ? agentById.get(n.agentId) : undefined;
        return {
          id: n.id,
          type: "maestro",
          position: n.position,
          data: {
            label: agent?.name ?? n.id,
            kind: n.kind,
            pinned: PINNED.has(n.kind),
            disabled: Boolean(agent && !agent.enabled),
          },
        };
      }),
      edges: doc.graph.edges.map(
        (e): Edge => ({
          id: `${e.from}->${e.to}`,
          source: e.from,
          target: e.to,
          animated: true,
          // Selectable so it can be removed with Backspace; the deletion is applied to the
          // playbook in `onEdgesDelete` rather than only to the canvas, or the graph and
          // the picture would disagree.
          selectable: true,
        }),
      ),
    };
  }, [doc]);

  const agent = doc?.agents.find((a) => a.id === selectedAgent) ?? null;

  const updateAgent = (id: string, patch: Partial<AgentDef>) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      const target = next.agents.find((a) => a.id === id);
      if (target) Object.assign(target, patch);
      return next;
    });
  };

  const updateModel = (id: string, patch: Partial<AgentDef["model"]>) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      const target = next.agents.find((a) => a.id === id);
      if (target) Object.assign(target.model, patch);
      return next;
    });
  };

  /**
   * A gate node: filter findings before triage.
   *
   * The engine has run gates since it was written — `applyGate` drops findings below a
   * severity or confidence floor, or in an excluded category — and the node registry lists
   * `gate` as something the canvas may draw. The Studio could not add one, so the only way
   * to get a gate was to hand-edit exported YAML. Same shape as `automaticTriggers` and
   * `thinkingBudget`: the engine honours it and nothing could set it.
   *
   * Inserted between the agents and triage, which is the only position its ports allow:
   * it takes Finding[] and returns Finding[].
   */
  const addGate = () => {
    setDoc((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      let n = 1;
      while (next.graph.nodes.some((x) => x.id === `gate-${n}`)) n++;
      const nodeId = `gate-${n}`;
      const triage = next.graph.nodes.find((x) => x.kind === "triage");

      next.graph.nodes.push({
        id: nodeId,
        kind: "gate",
        // A gate that filters nothing is the honest default: it is added empty and the
        // thresholds are set below, rather than guessing a floor on the user's behalf.
        failurePolicy: "skip-with-note",
        config: { excludeCategories: [] },
        position: { x: 700, y: 20 },
      });

      // Every agent now feeds the gate, and the gate feeds triage. Rewiring by hand is not
      // yet possible on the canvas, so adding a gate has to leave a valid graph.
      if (triage) {
        for (const edge of next.graph.edges) {
          if (edge.to === triage.id && edge.from !== nodeId) edge.to = nodeId;
        }
        next.graph.edges.push({ from: nodeId, to: triage.id });
      }
      return next;
    });
  };

  const removeGate = (nodeId: string) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      const triage = next.graph.nodes.find((x) => x.kind === "triage");
      // Reconnect whatever fed the gate straight to triage, or removing it would leave
      // every agent orphaned and the graph invalid.
      for (const edge of next.graph.edges) {
        if (edge.to === nodeId && triage) edge.to = triage.id;
      }
      next.graph.edges = next.graph.edges.filter((e) => e.from !== nodeId);
      next.graph.nodes = next.graph.nodes.filter((x) => x.id !== nodeId);
      return next;
    });
  };

  const updateNode = (nodeId: string, patch: Record<string, unknown>) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      const node = next.graph.nodes.find((x) => x.id === nodeId);
      if (node) Object.assign(node, patch);
      return next;
    });
  };

  const addAgent = () => {
    setDoc((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      let n = 1;
      while (next.agents.some((a) => a.id === `agent-${n}`)) n++;
      const id = `agent-${n}`;
      const template = next.agents[0];
      next.agents.push({
        id,
        name: `Agent ${n}`,
        persona: "Describe what this reviewer should look for, and what it should ignore.",
        model: template
          ? structuredClone(template.model)
          : {
              providerId: "anthropic",
              model: "claude-sonnet-5",
              maxSteps: 30,
              costCapCents: 150,
              fallback: [],
            },
        tools: template ? [...template.tools] : ["read_file", "grep", "git_diff"],
        enabled: true,
      });
      const nodeId = `n-${id}`;
      const y = 20 + next.graph.nodes.filter((x) => x.kind === "agent").length * 120;
      next.graph.nodes.push({
        id: nodeId,
        kind: "agent",
        agentId: id,
        failurePolicy: "skip-with-note",
        config: {},
        position: { x: 460, y },
      });
      // Wire it in immediately: an unconnected node is an invalid graph, and presenting
      // the user with a validation error for something they just added is unhelpful.
      const router = next.graph.nodes.find((x) => x.kind === "router");
      const triage = next.graph.nodes.find((x) => x.kind === "triage");
      if (router) next.graph.edges.push({ from: router.id, to: nodeId });
      if (triage) next.graph.edges.push({ from: nodeId, to: triage.id });
      next.router.rules.push({ agentId: id, include: ["**"], exclude: [] });
      return next;
    });
  };

  const removeAgent = (id: string) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      next.agents = next.agents.filter((a) => a.id !== id);
      const nodeIds = new Set(next.graph.nodes.filter((n) => n.agentId === id).map((n) => n.id));
      next.graph.nodes = next.graph.nodes.filter((n) => !nodeIds.has(n.id));
      next.graph.edges = next.graph.edges.filter((e) => !nodeIds.has(e.from) && !nodeIds.has(e.to));
      next.router.rules = next.router.rules.filter((r) => r.agentId !== id);
      return next;
    });
    setSelectedAgent(null);
  };

  const save = async () => {
    if (!doc) return;
    setSaving(true);
    setSaved(null);
    try {
      const result = await api.savePlaybook(doc, "edited in Studio");
      if (!result.ok) {
        setIssues(result.issues ?? []);
      } else {
        setSaved(`published v${result.version}`);
        load();
      }
    } finally {
      setSaving(false);
    }
  };

  if (!doc || !data) return <div className="empty">loading playbook…</div>;

  const modelsFor = (providerId: string) =>
    (providers?.models ?? []).filter((m) => m.providerId === providerId).map((m) => m.id);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="panel">
        <div className="panel-head">
          Pipeline
          <span className="muted">
            v{data.active?.version} · {doc.agents.length} agents
          </span>
          <div className="spacer" />
          {saved ? <span className="muted">{saved}</span> : null}
          {dirty ? <span className="badge running">unsaved</span> : null}
          <button type="button" onClick={addAgent}>
            Add agent
          </button>
          <button
            type="button"
            onClick={addGate}
            disabled={doc.graph.nodes.some((n) => n.kind === "gate")}
          >
            Add gate
          </button>
          <button
            type="button"
            className="primary"
            onClick={save}
            disabled={!dirty || saving || issues.length > 0}
          >
            {saving ? "Publishing…" : "Publish version"}
          </button>
        </div>
        <div className="panel-body">
          {issues.length ? (
            <div className="issues">
              {issues.map((i) => (
                <div className="issue" key={`${i.code}-${i.message}`}>
                  <strong>{i.code}</strong> {i.message}
                </div>
              ))}
            </div>
          ) : null}
          <div className="flow-wrap">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              proOptions={{ hideAttribution: true }}
              // Rewiring, which the plan asks for and the canvas could not do. A
              // connection is refused while it is being drawn rather than accepted and
              // rejected at publish: the ports are typed, the browser already has the
              // registry that types them, and letting somebody draw an invalid graph and
              // learn about it two clicks later would satisfy the letter of the
              // requirement and be worse than not having it.
              isValidConnection={(c) => connectionAllowed(c.source, c.target).ok}
              onConnect={(c) => {
                const verdict = connectionAllowed(c.source, c.target);
                if (!verdict.ok) {
                  setIssues([{ code: "port-type", message: verdict.reason }]);
                  return;
                }
                setIssues([]);
                setDoc((prev) => {
                  if (!prev || !c.source || !c.target) return prev;
                  const next = structuredClone(prev);
                  if (next.graph.edges.some((e) => e.from === c.source && e.to === c.target)) {
                    return next;
                  }
                  next.graph.edges.push({ from: c.source, to: c.target });
                  return next;
                });
              }}
              onEdgesDelete={(removed) => {
                setDoc((prev) => {
                  if (!prev) return prev;
                  const next = structuredClone(prev);
                  for (const e of removed) {
                    next.graph.edges = next.graph.edges.filter(
                      (x) => !(x.from === e.source && x.to === e.target),
                    );
                  }
                  return next;
                });
              }}
              onNodeClick={(_e, node) => {
                const graphNode = doc.graph.nodes.find((n) => n.id === node.id);
                setSelectedAgent(graphNode?.agentId ?? null);
              }}
            >
              <Background />
              <Controls />
            </ReactFlow>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Teardown is not a node — it always runs, so no graph can leak containers.
          </div>
        </div>
      </div>

      <div className="split">
        <div className="panel scroll">
          <div className="panel-head">Agents</div>
          <table>
            <tbody>
              {doc.agents.map((a) => (
                <tr
                  key={a.id}
                  className={`clickable ${selectedAgent === a.id ? "selected" : ""}`}
                  onClick={() => setSelectedAgent(a.id)}
                >
                  <td>
                    <div style={{ fontWeight: 550, opacity: a.enabled ? 1 : 0.5 }}>{a.name}</div>
                    <div className="muted mono" style={{ fontSize: 11 }}>
                      {a.model.providerId}/{a.model.model}
                    </div>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <span className={`badge ${a.enabled ? "done" : "skipped"}`}>
                      {a.enabled ? "on" : "off"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel scroll">
          {!agent ? (
            <div className="empty">Select an agent to edit its persona and model</div>
          ) : (
            <>
              <div className="panel-head">
                {agent.name}
                <div className="spacer" />
                <button
                  type="button"
                  onClick={() => updateAgent(agent.id, { enabled: !agent.enabled })}
                >
                  {agent.enabled ? "Disable" : "Enable"}
                </button>
                <button type="button" onClick={() => removeAgent(agent.id)}>
                  Remove
                </button>
              </div>
              <div className="panel-body">
                <div className="grid3">
                  <label className="field">
                    <span className="field-label">Provider</span>
                    <select
                      value={agent.model.providerId}
                      onChange={(e) => updateModel(agent.id, { providerId: e.target.value })}
                    >
                      {(providers?.providers ?? [{ id: agent.model.providerId }]).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  {/* The control is chosen at render time — a live catalogue gives a
                      dropdown, an unqueried provider a free-text box — so this label is
                      associated by id rather than by wrapping. */}
                  <div className="field">
                    <label className="field-label" htmlFor={`model-${agent.id}`}>
                      Model
                    </label>
                    {modelsFor(agent.model.providerId).length ? (
                      <select
                        id={`model-${agent.id}`}
                        value={agent.model.model}
                        onChange={(e) => updateModel(agent.id, { model: e.target.value })}
                      >
                        {modelsFor(agent.model.providerId).map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                        {modelsFor(agent.model.providerId).includes(agent.model.model) ? null : (
                          <option value={agent.model.model}>{agent.model.model}</option>
                        )}
                      </select>
                    ) : (
                      <input
                        id={`model-${agent.id}`}
                        value={agent.model.model}
                        onChange={(e) => updateModel(agent.id, { model: e.target.value })}
                        placeholder="run 'maestro llm models' to populate"
                      />
                    )}
                  </div>
                  <label className="field">
                    <span className="field-label">Max steps</span>
                    <input
                      type="number"
                      value={agent.model.maxSteps}
                      onChange={(e) => updateModel(agent.id, { maxSteps: Number(e.target.value) })}
                    />
                  </label>
                </div>

                <div className="grid2">
                  <label className="field">
                    <span className="field-label">Cost cap (cents)</span>
                    <input
                      type="number"
                      value={agent.model.costCapCents}
                      onChange={(e) =>
                        updateModel(agent.id, { costCapCents: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Temperature</span>
                    <input
                      type="number"
                      step="0.1"
                      value={agent.model.temperature ?? ""}
                      placeholder="provider default"
                      onChange={(e) =>
                        updateModel(agent.id, {
                          temperature: e.target.value === "" ? undefined : Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Thinking budget (tokens)</span>
                    <input
                      type="number"
                      step="1000"
                      value={agent.model.thinkingBudget ?? ""}
                      placeholder="off"
                      onChange={(e) =>
                        updateModel(agent.id, {
                          thinkingBudget:
                            e.target.value === "" ? undefined : Number(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>

                <div className="row" style={{ alignItems: "center", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => testBinding(agent.id, agent.model.providerId, agent.model.model)}
                    disabled={tests[agent.id]?.state === "running"}
                  >
                    {tests[agent.id]?.state === "running" ? "Testing…" : "Test connection"}
                  </button>
                  {/* Said before the click, not after: this makes a real call, and a
                      button that quietly spends money is not a button. */}
                  <span className="muted" style={{ fontSize: 12 }}>
                    {tests[agent.id]?.message ??
                      "one real round trip — checks the credential, the model name and whether it can call tools"}
                  </span>
                </div>

                <label className="field">
                  <span className="field-label">
                    Persona — Maestro always wraps this in a fixed preamble and output contract,
                    which cannot be edited
                  </span>
                  <textarea
                    value={agent.persona}
                    onChange={(e) => updateAgent(agent.id, { persona: e.target.value })}
                  />
                </label>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">Environment</div>
        <div className="panel-body">
          <div className="grid3">
            <label className="field">
              <span className="field-label">Image</span>
              <input
                value={doc.envSpec.image}
                onChange={(e) =>
                  setDoc({ ...doc, envSpec: { ...doc.envSpec, image: e.target.value } })
                }
              />
            </label>
            <label className="field">
              <span className="field-label">CPUs</span>
              <input
                type="number"
                value={doc.envSpec.cpus}
                onChange={(e) =>
                  setDoc({ ...doc, envSpec: { ...doc.envSpec, cpus: Number(e.target.value) } })
                }
              />
            </label>
            <label className="field">
              <span className="field-label">Memory</span>
              <input
                value={doc.envSpec.memory}
                onChange={(e) =>
                  setDoc({ ...doc, envSpec: { ...doc.envSpec, memory: e.target.value } })
                }
              />
            </label>
          </div>
          <div className="grid3">
            <label className="field">
              <span className="field-label">Analyze timeout (s)</span>
              <input
                type="number"
                value={doc.envSpec.timeouts.analyzeSec}
                onChange={(e) =>
                  setDoc({
                    ...doc,
                    envSpec: {
                      ...doc.envSpec,
                      timeouts: { ...doc.envSpec.timeouts, analyzeSec: Number(e.target.value) },
                    },
                  })
                }
              />
            </label>
            <label className="field">
              <span className="field-label">Egress allowlist (prepare only)</span>
              <input
                value={doc.envSpec.egressAllowlist.join(", ")}
                onChange={(e) =>
                  setDoc({
                    ...doc,
                    envSpec: {
                      ...doc.envSpec,
                      egressAllowlist: e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
            </label>
            <label className="field">
              <span className="field-label">Review every pull request automatically</span>
              <select
                value={doc.router.automaticTriggers === false ? "no" : "yes"}
                onChange={(e) =>
                  setDoc({
                    ...doc,
                    router: { ...doc.router, automaticTriggers: e.target.value === "yes" },
                  })
                }
              >
                <option value="yes">Yes — on open, push and ready-for-review</option>
                <option value="no">No — only when someone comments @maestro review</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">Min confidence to post</span>
              <input
                type="number"
                step="0.05"
                value={doc.triage.minConfidence}
                onChange={(e) =>
                  setDoc({
                    ...doc,
                    triage: { ...doc.triage, minConfidence: Number(e.target.value) },
                  })
                }
              />
            </label>
          </div>
        </div>
      </div>

      {doc.graph.nodes
        .filter((n) => n.kind === "gate")
        .map((gate) => (
          <div className="panel" key={gate.id}>
            <div className="panel-head">
              Gate — drops findings before triage
              <div className="spacer" />
              <button type="button" onClick={() => removeGate(gate.id)}>
                Remove
              </button>
            </div>
            <div className="panel-body">
              <div className="grid2">
                <label className="field">
                  <span className="field-label">Minimum severity to keep</span>
                  <select
                    value={(gate.config as { minSeverity?: string }).minSeverity ?? ""}
                    onChange={(e) =>
                      updateNode(gate.id, {
                        config: {
                          ...gate.config,
                          minSeverity: e.target.value || undefined,
                        },
                      })
                    }
                  >
                    <option value="">any</option>
                    {["critical", "high", "medium", "low", "info"].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Minimum confidence to keep</span>
                  <input
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    placeholder="any"
                    value={(gate.config as { minConfidence?: number }).minConfidence ?? ""}
                    onChange={(e) =>
                      updateNode(gate.id, {
                        config: {
                          ...gate.config,
                          minConfidence: e.target.value === "" ? undefined : Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span className="field-label">Categories to drop outright</span>
                  <input
                    placeholder="style, nitpick"
                    value={(
                      (gate.config as { excludeCategories?: string[] }).excludeCategories ?? []
                    ).join(", ")}
                    onChange={(e) =>
                      updateNode(gate.id, {
                        config: {
                          ...gate.config,
                          excludeCategories: e.target.value
                            .split(",")
                            .map((c) => c.trim())
                            .filter(Boolean),
                        },
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span className="field-label">
                    If this node fails — the plan calls for this per node, and nothing could set it
                  </span>
                  <select
                    value={gate.failurePolicy}
                    onChange={(e) => updateNode(gate.id, { failurePolicy: e.target.value })}
                  >
                    <option value="skip-with-note">Skip it and note it in the comment</option>
                    <option value="fail-review">Fail the whole review</option>
                  </select>
                </label>
              </div>
            </div>
          </div>
        ))}

      <VersionDiff />

      <div className="panel">
        <div className="panel-head">Versions</div>
        <table>
          <tbody>
            {data.versions.map((v) => (
              <tr key={v.id}>
                <td>
                  v{v.version} <span className="muted">{v.notes}</span>
                </td>
                <td className="muted">{new Date(v.createdAt).toLocaleString()}</td>
                <td style={{ textAlign: "right" }}>
                  {v.id === data.active?.id ? (
                    <span className="badge done">active</span>
                  ) : (
                    <button type="button" onClick={() => api.activate(v.id).then(load)}>
                      Roll back
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * What the active version changed, or what rolling back would undo.
 *
 * Publishing was a one-way door before this: the Versions list below offers a roll back and
 * nothing said what rolling back would do. A persona is prose edited by hand, so the lines
 * that moved are the answer — "v7 vs v8" on its own is not one.
 */
function VersionDiff() {
  const [diff, setDiff] = useState<PlaybookDiff | null>(null);

  useEffect(() => {
    api
      .playbookDiff()
      .then(setDiff)
      .catch(() => setDiff(null));
  }, []);

  if (!diff || diff.from === null || diff.to === null) return null;
  if (!diff.changes.length) {
    return (
      <div className="panel">
        <div className="panel-head">
          Changes in v{diff.to}
          <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
            nothing differs from v{diff.from}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">
        Changes in v{diff.to}
        <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
          against v{diff.from}
        </span>
      </div>
      <div className="panel-body" style={{ display: "grid", gap: 12 }}>
        {diff.changes.map((c) => (
          <div key={c.path}>
            <div style={{ fontWeight: 550, fontSize: 13 }}>
              {c.path} <span className="muted">{c.kind}</span>
            </div>
            {c.lines ? (
              <pre
                style={{
                  margin: "4px 0 0",
                  fontSize: 12,
                  overflowX: "auto",
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                {/* Keyed by sign and content: an array index as a key is what the lint
                    rule objects to, and a diff line is identified by what it says. */}
                {c.lines.map((l) => (
                  <div
                    key={`${l.sign}${l.text}`}
                    style={{ color: l.sign === "+" ? "var(--ok, #3fb950)" : "var(--warn)" }}
                  >
                    {l.sign} {l.text}
                  </div>
                ))}
              </pre>
            ) : (
              <div className="muted" style={{ fontSize: 12, overflowX: "auto" }}>
                {(c.before ?? "").slice(0, 160)} → {(c.after ?? "").slice(0, 160)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
