#!/usr/bin/env node
/**
 * Speaks JSON-RPC to `maestro mcp` as a real client would, against the compiled binary.
 *
 * stdout is the protocol. Anything else written there — a banner, a stray console.log, a
 * log line that forgot it was supposed to go to stderr — corrupts the stream and the
 * client disconnects with a parse error that names nothing useful. That is a failure mode
 * no unit test can see, because it only exists once the server is a subprocess and stdout
 * is a pipe rather than a test harness.
 *
 *   pnpm run build:binary && node scripts/mcp-protocol-check.mjs [path-to-binary]
 */
import { spawn } from "node:child_process";

const binary = process.argv[2] ?? "./dist/maestro";
const toolCall = (id, name, args = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

const requests = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "gate", version: "1" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  // Advertising a tool is not the same as it working through the protocol, and this
  // phase's stated exit is "change an agent's model from a Claude Code session". So the
  // check does that: read the playbook, rebind an agent, read it back.
  toolCall(3, "get_playbook"),
  toolCall(4, "set_agent_model", {
    agentId: "security",
    providerId: "ollama",
    model: "glm-5.3:cloud",
  }),
  toolCall(5, "get_playbook"),
];

const child = spawn(binary, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] });
let out = "";
let err = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (err += d));
child.stdin.end(`${requests.map((r) => JSON.stringify(r)).join("\n")}\n`);

const code = await new Promise((r) => child.on("close", r));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log(`\nmcp protocol — ${binary}\n`);

const lines = out.split("\n").filter(Boolean);
const parsed = [];
let impure = 0;
for (const line of lines) {
  try {
    const msg = JSON.parse(line);
    if (msg.jsonrpc !== "2.0") impure++;
    else parsed.push(msg);
  } catch {
    impure++;
    console.log(`  ---- non-protocol line on stdout: ${line.slice(0, 120)}`);
  }
}

check(
  "stdout carries only JSON-RPC",
  impure === 0,
  `${lines.length} line(s), ${impure} not protocol`,
);
check("the server exited cleanly", code === 0, `exit ${code}`);

const init = parsed.find((m) => m.id === 1);
check("initialize succeeded", Boolean(init?.result?.serverInfo), init?.error?.message ?? "");

const tools = parsed.find((m) => m.id === 2)?.result?.tools ?? [];
check("tools are advertised", tools.length > 0, `${tools.length} tool(s)`);

// The set the plan names, so dropping one is caught here rather than by a user whose
// Claude Code session suddenly cannot trigger a review.
const REQUIRED = [
  "list_reviews",
  "get_review",
  "get_findings",
  "explain_finding",
  "dismiss_finding",
  "trigger_review",
  "get_playbook",
  "set_agent_model",
  "update_persona",
  "run_eval",
];
const names = new Set(tools.map((t) => t.name));
const missing = REQUIRED.filter((t) => !names.has(t));
check("every planned tool is present", missing.length === 0, missing.join(", "));

// The three calls above, checked for what they actually did.
const resultOf = (id) => {
  const msg = parsed.find((m) => m.id === id);
  const text = msg?.result?.content?.[0]?.text;
  try {
    return text ? JSON.parse(text) : msg?.result;
  } catch {
    return text;
  }
};

// `get_playbook` answers `{ version, id, document: { … agents … } }`. Read from the real
// response rather than from a guess about it — the first version of this check looked for
// `agents` and `doc.agents`, found neither, and reported a failure that was mine.
const modelOf = (playbook) =>
  playbook?.document?.agents?.find((a) => a.id === "security")?.model?.model;

const before = resultOf(3);
const changed = resultOf(4);
const after = resultOf(5);

check(
  "get_playbook returns a playbook with agents",
  Boolean(modelOf(before)),
  `security bound to ${modelOf(before)}`,
);
check(
  "set_agent_model reports success",
  changed?.ok !== false,
  JSON.stringify(changed ?? "").slice(0, 120),
);
check(
  "the change is visible on the next read",
  modelOf(after) === "glm-5.3:cloud",
  `security now bound to ${modelOf(after)}`,
);

if (err.trim()) console.log(`\n  stderr (logs belong here):\n${err.trim().slice(0, 300)}`);
console.log(failures ? `\n${failures} failed\n` : "\nmcp protocol verified against the binary\n");
process.exit(failures ? 1 : 0);
