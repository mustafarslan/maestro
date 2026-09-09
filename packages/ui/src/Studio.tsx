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
          <button onClick={addAgent}>Add agent</button>
          <button
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
                <button onClick={() => updateAgent(agent.id, { enabled: !agent.enabled })}>
                  {agent.enabled ? "Disable" : "Enable"}
                </button>
                <button onClick={() => removeAgent(agent.id)}>Remove</button>
              </div>
              <div className="panel-body">
                <div className="grid3">
                  <div className="field">
                    <label>Provider</label>
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
                  </div>
                  <div className="field">
                    <label>Model</label>
                    {modelsFor(agent.model.providerId).length ? (
                      <select
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
                        value={agent.model.model}
                        onChange={(e) => updateModel(agent.id, { model: e.target.value })}
                        placeholder="run 'maestro llm models' to populate"
                      />
                    )}
                  </div>
                  <div className="field">
                    <label>Max steps</label>
                    <input
                      type="number"
                      value={agent.model.maxSteps}
                      onChange={(e) => updateModel(agent.id, { maxSteps: Number(e.target.value) })}
                    />
                  </div>
                </div>

                <div className="grid2">
                  <div className="field">
                    <label>Cost cap (cents)</label>
                    <input
                      type="number"
                      value={agent.model.costCapCents}
                      onChange={(e) =>
                        updateModel(agent.id, { costCapCents: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>Temperature</label>
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
                  </div>
                </div>

                <div className="field">
                  <label>
                    Persona — Maestro always wraps this in a fixed preamble and output contract,
                    which cannot be edited
                  </label>
                  <textarea
                    value={agent.persona}
                    onChange={(e) => updateAgent(agent.id, { persona: e.target.value })}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">Environment</div>
        <div className="panel-body">
          <div className="grid3">
            <div className="field">
              <label>Image</label>
              <input
                value={doc.envSpec.image}
                onChange={(e) =>
                  setDoc({ ...doc, envSpec: { ...doc.envSpec, image: e.target.value } })
                }
              />
            </div>
            <div className="field">
              <label>CPUs</label>
              <input
                type="number"
                value={doc.envSpec.cpus}
                onChange={(e) =>
                  setDoc({ ...doc, envSpec: { ...doc.envSpec, cpus: Number(e.target.value) } })
                }
              />
            </div>
            <div className="field">
              <label>Memory</label>
              <input
                value={doc.envSpec.memory}
                onChange={(e) =>
                  setDoc({ ...doc, envSpec: { ...doc.envSpec, memory: e.target.value } })
                }
              />
            </div>
          </div>
          <div className="grid3">
            <div className="field">
              <label>Analyze timeout (s)</label>
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
            </div>
            <div className="field">
              <label>Egress allowlist (prepare only)</label>
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
            </div>
            <div className="field">
              <label>Min confidence to post</label>
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
            </div>
          </div>
        </div>
      </div>

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
                    <button onClick={() => api.activate(v.id).then(load)}>Roll back</button>
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
