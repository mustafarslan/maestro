# Maestro

Multi-agent pull request review. Maestro watches GitHub for new and updated PRs, spins up an
ephemeral isolated environment per PR, runs a crew of specialist review agents against it in
parallel, and has a triage agent merge their findings into **one** consolidated review comment.

The review pipeline is not hardcoded. It is a **versioned playbook** — a graph, a set of agents
with editable personas and per-agent model bindings, router rules, and an environment spec —
stored in the database and (from Phase 6) edited visually. The engine is an interpreter over that
graph, so adding a reviewer or repointing one at a different LLM provider is a config change.

## Status

Phase 0 of 10 complete. See the implementation plan for the full roadmap.

- [x] **Phase 0** — foundation: store, migrations, job queue, playbook schema + graph validation, CLI, single-binary build
- [x] **Phase 1** — LLM provider layer: 4 adapters, own agent loop with budgets, cost accounting, conformance suite
- [x] **Phase 2** — graph engine, Docker sandbox with egress allowlist, agent tools, first real reviews
- [ ] Phase 3 — GitHub App, webhooks, consolidated review posting
- [ ] Phase 4 — MCP server
- [ ] Phase 5 — full crew, router, triage, Linear, minimal UI
- [ ] Phase 6 — Playbook Studio (React Flow editor, persona editor, model picker)
- [ ] Phase 7 — concurrency, caching, cancel-on-push, incremental review
- [ ] Phase 8 — observability build-out
- [ ] Phase 9 — measurement and the quality loop
- [ ] Phase 10 — hardening and release

## Develop

Requires Node 22.14+, pnpm, Docker, and [Bun](https://bun.sh) for the binary build.

```sh
pnpm install
pnpm typecheck        # tsc -b across the workspace
pnpm test             # vitest
pnpm build:binary     # -> dist/maestro (single self-contained executable)
```

## Try it

```sh
node apps/cli/dist/index.js init      # or: ./dist/maestro init
./dist/maestro doctor
./dist/maestro playbook nodes         # the closed node registry the canvas may draw
./dist/maestro playbook export pb.yaml
./dist/maestro playbook import pb.yaml --activate

./dist/maestro llm providers            # credential status per provider
echo $KEY | ./dist/maestro llm key set anthropic
./dist/maestro llm models               # fetch + cache each provider's live model list
./dist/maestro llm test                 # conformance suite against real providers

./dist/maestro review ~/code/my-app --base HEAD~1
```

## Layout

| Package | Purpose |
| --- | --- |
| `packages/core` | store interface, portable SQLite driver, migrations, job queue, spans, logging |
| `packages/playbook` | playbook schema, graph validation, node registry, prompt layering, versioned store |
| `packages/llm` | provider adapters, agent loop, budgets, pricing/capabilities, conformance suite |
| `packages/sandbox` | Docker driver, two-phase isolation, egress allowlist proxy, toolchain detection, reaper |
| `packages/agents` | read-only agent tool surface, Finding schema, agent runner |
| `packages/engine` | graph interpreter, deterministic router, triage, review rendering, persistence |
| `apps/cli` | `maestro` entrypoint |

## Design notes

**Portable SQLite.** The compiled binary runs on Bun (`bun:sqlite`); `npm i -g` runs on Node
(`node:sqlite`). Both ship the driver in the runtime, which matters because a native addon like
`better-sqlite3` does not survive `bun build --compile`. `packages/core/src/store/driver.ts`
normalises the two APIs behind one interface.

**Prompt layering.** An agent's system prompt is a fixed preamble (untrusted-content rules, tool
contract) + the editable persona slot + a fixed output contract. The wrapper lives in code so no
persona edit — including one made in the Studio — can remove the injection defenses.

**Teardown is not a graph node.** It is a guaranteed finalizer the engine runs on every terminal
state, so no drawable graph can leak containers.

**Maestro owns the agent loop.** The Vercel AI SDK is used for per-call provider normalisation
only — its own retry and multi-step helpers are switched off. Owning the loop is what makes
per-agent budgets, honest token accounting, and the terminal-tool contract possible. Providers are
*instances*, not a fixed list: `openai-compatible` covers Ollama, vLLM, LM Studio and OpenRouter
with one config row each.

**Two security postures, asserted not assumed.** `prepare` is the only phase with a network,
and it goes through an allowlist proxy that blocks both CONNECT and plain HTTP (npm and pip use
both). `analyze` runs with `--network none`, a read-only rootfs, all capabilities dropped, no
secrets and no docker socket. `packages/sandbox/src/docker.integration.test.ts` asserts each of
those against real containers, because a typo in a `docker run` flag is otherwise silent.

Node installs run with `--ignore-scripts`: lifecycle scripts are arbitrary code from a stranger's
dependency tree, and in practice they are also the main thing that fails behind an allowlist.

**Pricing is data with provenance.** `packages/llm/src/pricing.ts` carries a `fetchedAt` stamp and
a source per provider, because those numbers go straight into a PR comment's metrics block. Cached
and uncached input tokens are billed disjointly so cached tokens are never charged twice.
