#!/usr/bin/env node
/**
 * The two adapters with no local stand-in, against their real endpoints.
 *
 *   node scripts/live-provider-check.mjs
 *
 * `anthropic` and `google` are the only providers this project has never called for
 * real — everything else has been exercised against Ollama Cloud. A successful
 * completion needs a credential nobody here has, but most of what could be wrong does
 * not: the base URL, the header names, the API version, the request the SDK builds, and
 * what the adapter does with the answer.
 *
 * So this sends a real request with a deliberately invalid key and asserts on the
 * refusal. The same technique `live-linear-check.mjs` uses, for the same reason: the
 * service tells you a great deal before it authenticates you.
 *
 * What a pass establishes:
 *   - the endpoint resolves, TLS completes, and the service answers
 *   - it answers with a refusal of the credential — 401 for Anthropic, and 400 for Google,
 *     which is a real difference in their conventions rather than a guess — and not 404,
 *     which would mean the adapter is calling a path that does not exist, nor a 400 about
 *     anything other than the key, which would mean it sent something unparseable
 *   - the adapter maps that to a ProviderError that is NOT retryable, which is what
 *     stops the agent loop burning its whole budget re-sending a request that will be
 *     refused every time
 *
 * What it does not establish: that a real key produces a real completion. That needs a
 * key, and `maestro llm test --provider anthropic` is the one-minute check for it.
 *
 * Advisory by nature — these are somebody else's services and their availability is not
 * this build's business — so it is not in the gate.
 */
import { Provider, ProviderError } from "../packages/llm/dist/index.js";

const INVALID = "sk-ant-not-a-real-key-000000000000000000000000";

const cases = [
  { id: "anthropic", kind: "anthropic", model: "claude-opus-5", apiKey: INVALID },
  { id: "google", kind: "google", model: "gemini-2.5-flash", apiKey: "not-a-real-key" },
];

let bad = 0;
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  bad++;
};

for (const c of cases) {
  const provider = new Provider({ id: c.id, kind: c.kind, apiKey: c.apiKey });
  let err;
  try {
    await provider.chat({ model: c.model, messages: [{ role: "user", content: "hi" }] });
    fail(`${c.id}: an invalid key was accepted, which cannot be right`);
    continue;
  } catch (e) {
    err = e;
  }

  if (!(err instanceof ProviderError)) {
    // A TypeError or a raw SDK error here means the adapter did not map the failure at
    // all, and the loop's retry policy has nothing to read.
    fail(
      `${c.id}: ${err?.constructor?.name ?? typeof err} rather than ProviderError — ${err?.message}`,
    );
    continue;
  }

  const { status, retryable } = err.opts;
  const detail = `status=${status ?? "none"} retryable=${retryable}`;

  if (status === undefined) {
    // No status means the request never reached the service: DNS, TLS, or a base URL
    // that is wrong in a way no unit test would catch.
    fail(`${c.id}: no HTTP status — the request did not reach the service (${err.message})`);
    continue;
  }
  if (status === 404) {
    fail(`${c.id}: 404 — the adapter is calling a path this service does not have (${detail})`);
    continue;
  }
  // Google answers a bad key with 400, not 401 — established by running this, not by
  // assuming. So a 400 has to be read: one that names the credential is a refusal, and
  // any other 400 means the service could not parse what the adapter sent, which is the
  // failure this check exists to catch.
  const aboutTheKey = /api key|credential|unauthenticated|invalid authentication/i.test(
    err.message,
  );
  if (status === 400 && !aboutTheKey) {
    fail(
      `${c.id}: 400 that is not about the credential — the service could not parse what the adapter sent (${err.message.slice(0, 140)})`,
    );
    continue;
  }
  if (status !== 401 && status !== 403 && !(status === 400 && aboutTheKey)) {
    console.log(`  ?  ${c.id}: unexpected ${detail} — ${err.message.slice(0, 120)}`);
    continue;
  }
  if (retryable) {
    fail(
      `${c.id}: a rejected credential was marked retryable, so the loop would re-send it until the budget ran out (${detail})`,
    );
    continue;
  }

  console.log(`  ok ${c.id.padEnd(10)} refused the invalid key with ${detail}`);
}

console.log(
  bad
    ? `\n${bad} problem(s) — these are real requests, so a network fault looks the same as a defect`
    : "\nboth adapters reach their service and map a refusal correctly (no key needed)",
);
process.exit(bad ? 1 : 0);
