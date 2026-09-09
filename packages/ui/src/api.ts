/** The admin API is token-guarded; the token arrives in the URL and stays in memory. */
const params = new URLSearchParams(location.search);
export const TOKEN = params.get("token") ?? localStorage.getItem("maestro.token") ?? "";
if (TOKEN) localStorage.setItem("maestro.token", TOKEN);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const api = {
  reviews: () => request<{ reviews: ReviewRow[] }>("/api/reviews"),
  review: (id: string) => request<ReviewDetail>(`/api/reviews/${id}`),
  playbook: () => request<PlaybookResponse>("/api/playbook"),
  savePlaybook: (document: unknown, notes?: string) =>
    request<{ ok: boolean; version?: number; issues?: Issue[] }>("/api/playbook", {
      method: "POST",
      body: JSON.stringify({ document, notes }),
    }),
  validatePlaybook: (document: unknown) =>
    request<{ ok: boolean; issues?: Issue[] }>("/api/playbook/validate", {
      method: "POST",
      body: JSON.stringify({ document }),
    }),
  activate: (versionId: string) =>
    request<{ ok: boolean }>("/api/playbook/activate", {
      method: "POST",
      body: JSON.stringify({ versionId }),
    }),
  providers: () => request<ProvidersResponse>("/api/providers"),
  stats: () => request<StatsResponse>("/api/stats"),
  feedback: () => request<FeedbackResponse>("/api/findings/feedback"),
  environments: () => request<{ environments: EnvironmentRow[] }>("/api/environments"),
  evalScores: () => request<EvalResponse>("/api/eval"),
  testProvider: (providerId: string, model: string) =>
    request<ProviderTestResponse>("/api/providers/test", {
      method: "POST",
      body: JSON.stringify({ providerId, model }),
    }),
};

export interface Issue {
  code: string;
  message: string;
  target?: string;
}

export interface ReviewRow {
  id: string;
  owner: string;
  repo: string;
  pr_number: number;
  title: string | null;
  author: string | null;
  state: string;
  cost_cents: number;
  created_at: string;
  finished_at: string | null;
  head_sha: string;
}

export interface TaskRow {
  id: string;
  node_id: string;
  kind: string;
  agent_id: string | null;
  state: string;
  error: string | null;
  cost_cents: number;
  output_json: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface FindingRow {
  id: string;
  agent_id: string;
  file: string | null;
  line_start: number | null;
  category: string;
  severity: string;
  confidence: number;
  title: string;
  body: string;
  status: string;
  agreement_count: number;
  suppressed_reason: string | null;
}

export interface SpanRow {
  id: string;
  name: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
}

export interface ReviewDetail {
  review: ReviewRow & {
    error: string | null;
    playbook_version_id: string;
    base_ref: string | null;
  };
  tasks: TaskRow[];
  findings: FindingRow[];
  spans: SpanRow[];
  llmCalls: {
    provider_id: string;
    model: string;
    steps: number;
    tokens_in: number;
    tokens_out: number;
    cost_cents: number;
  }[];
}

export interface PlaybookDoc {
  name: string;
  description: string;
  graph: { nodes: GraphNode[]; edges: { from: string; to: string }[] };
  agents: AgentDef[];
  router: {
    mode: string;
    rules: { agentId: string; include: string[]; exclude: string[] }[];
    skipAuthors: string[];
    /** False means reviews only happen when somebody comments `@maestro review`. */
    automaticTriggers: boolean;
  };
  triage: {
    minConfidence: number;
    maxInlineComments: number;
    agreementBoost: number;
    persona: string;
    model: ModelBinding;
  };
  envSpec: EnvSpec;
  schemaVersion: number;
}

export interface GraphNode {
  id: string;
  kind: string;
  agentId?: string;
  failurePolicy: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

export interface ModelBinding {
  providerId: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Extended thinking. In the schema and forwarded by the runner; the picker had no field. */
  thinkingBudget?: number;
  maxSteps: number;
  costCapCents: number;
  fallback: { providerId: string; model: string }[];
}

export interface AgentDef {
  id: string;
  name: string;
  persona: string;
  model: ModelBinding;
  tools: string[];
  enabled: boolean;
}

export interface EnvSpec {
  image: string;
  cpus: number;
  memory: string;
  pids: number;
  tmpfs: string;
  timeouts: { prepareSec: number; analyzeSec: number; commandSec: number };
  setup: string[];
  allowedCommands: string[];
  egressAllowlist: string[];
  secrets: string;
  trust: string;
  writableWorkdir: boolean;
}

export interface PlaybookResponse {
  active: { id: string; version: number; doc: PlaybookDoc } | null;
  versions: { id: string; version: number; notes: string | null; createdAt: string }[];
  nodeRegistry: {
    kind: string;
    inputs: string[];
    outputs: string[];
    pinned: boolean;
    description: string;
  }[];
}

export interface ProvidersResponse {
  providers: { id: string; kind: string; baseUrl?: string; enabled: boolean }[];
  models: { providerId: string; id: string; capabilities: Record<string, boolean> }[];
}

export interface StatsResponse {
  queue: Record<string, number>;
  reviews: { state: string; n: number }[];
  environments: { state: string; n: number }[];
  spend: { provider_id: string; model: string; cost_cents: number; calls: number }[];
}

/** Accepted-vs-dismissed per agent: the post-hoc signal precision is measured from. */
export interface FeedbackResponse {
  byAgent: { agent_id: string; status: string; n: number }[];
  /** Per-agent acceptance, computed server-side so the UI and the API agree. */
  quality: {
    agentId: string;
    posted: number;
    accepted: number;
    dismissed: number;
    open: number;
    acceptanceRate?: number;
  }[];
}

/** One container a review started. Kept after teardown, so a leak has a history. */
export interface EnvironmentRow {
  id: string;
  review_id: string;
  kind: string;
  agent_id: string | null;
  container_id: string | null;
  image_id: string | null;
  state: string;
  lease_until: string | null;
  ttl_at: string;
  created_at: string;
  destroyed_at: string | null;
  repo: string;
  pr_number: number;
  review_state: string;
  /** Decided by the server: the UI keeps no state vocabulary of its own. */
  live: boolean;
}

/** Recorded golden-set scores, and the version-versus-version comparison built from them. */
export interface EvalResponse {
  scores: {
    fixture: string;
    playbookVersionId?: string;
    misses: string[];
    precision?: number;
    recall?: number;
    costCents: number;
    agentsRun: number;
  }[];
  comparisons: {
    playbookVersionId: string;
    runs: number;
    precision?: number;
    recall?: number;
    falsePositives: number;
    costCents: number;
  }[];
}

/** One real round trip through a provider. Costs a little; answers the whole question. */
export interface ProviderTestResponse {
  ok: boolean;
  error?: string;
  report?: {
    providerId: string;
    model: string;
    checks: { name: string; passed: boolean; detail: string; durationMs: number }[];
    observed: { tools?: boolean };
    passed: boolean;
    costCents: number;
  };
}
