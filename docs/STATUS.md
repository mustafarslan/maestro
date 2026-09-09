# Status

An honest account of what has been verified against reality, and what has not. Kept separate from
the README so the claims in that file stay short and true.

## Phases against the plan

Every phase's stated exit criterion, checked against the code rather than from memory. "Built"
means the code exists and is tested; "verified" means it has been run against the real thing.
The gap between those two columns is the honest summary of this project's state.

| Phase | Exit criterion | Built | Verified |
| --- | --- | --- | --- |
| 0 Foundation | compiled binary opens SQLite, migrates, validates the default playbook, enqueues and claims a job; `doctor` reports Docker/git/config/migrations | yes | yes — every clean-checkout gate run, and the store driver's contract is now checked on **both** runtimes rather than only the one vitest happens to use (128) |
| 1 Provider layer | `maestro llm test --all` does a tool-calling round trip and a schema-constrained output per provider; `maestro llm models` lists the live catalog | yes | Ollama Cloud live, through both the `openai-compatible` and `openai` adapters; `anthropic` and `google` fixtures only |
| 2 Engine + agents | real findings on a real diff; sandbox network-isolated during analyze and torn down; persona/model edits and a second agent node change behaviour with no code change | yes | yes — findings on this repository and on `notabase`; isolation asserted in `docker.integration.test.ts` |
| 3 GitHub | PR opened → comment within minutes; nothing left behind; two quick pushes yield one comment for the newer SHA | yes | webhook path verified by signing real payloads against the running daemon; **never driven by GitHub itself** |
| 3 GitHub App | manifest flow in `init` | yes — `maestro github-app create/installed/show` | manifest shape, code exchange, 0600 storage, the `fromEnv` fallback, `serve`'s secret resolution and both `identity()` branches are tested against mocks; **no App has been created on GitHub, so the redirect and the conversion endpoint are unexercised** |
| 4 MCP | trigger a review, read findings and change a model from a Claude Code session | yes — all 10 planned tools plus `list_providers`, `review_stats`, `validate_playbook` | yes, and now against the **compiled binary**: `scripts/mcp-protocol-check.mjs` speaks JSON-RPC to it as a client would and runs in the gate |
| 5 Full crew + minimal UI | one comment, ≥3 agents, no duplicates, metrics block, watchable in the browser | yes | yes, against Ollama Cloud |
| 6 Playbook Studio | add an agent, write its persona, bind a different provider, raise memory, publish — next PR uses it, in-flight reviews finish on their pinned version | yes — React Flow canvas, persona editor, model picker with live catalog, **test connection**, env spec form, versions, per-repo assignment | publish/rollback/pin verified; test connection verified against Ollama |
| 7 Concurrency | 10 PRs across 3 repos complete; kill and restart mid-run with no leaks or duplicates | yes — fairness, limits, cache reuse, cancel-on-push, incremental, lease recovery, reaper, **spend caps** | scheduler test runs all 40 tasks with real concurrency; **not 40 real containers** |
| 8 Observability | click a failed task and read the error, the prompt and the playbook version | yes — live board, waterfall, environments, providers, quality | yes |
| 9 Measurement | `maestro eval` scores; UI shows acceptance by agent **and a version-versus-version comparison** | yes — both, the second added after this audit found only the CLI and MCP could reach `compareVersions` | scoring verified on fixtures; no long-run acceptance history exists yet |
| 10 Hardening | installer, multi-platform release, Compose, abuse controls, injection suite, docs | yes — `install.sh`, release CI, Compose, signature + association + body-size + spend controls, `injection.test.ts`, five docs | installer and Compose run locally; **no multi-platform release has been downloaded and run** |

What that leaves, in order of how much it would tell us:

1. **A delivery sent by GitHub.** Both halves of the API are now verified live by
   `scripts/live-github-check.mjs`: the read paths, and — with `--write` — posting a comment,
   finding it again by its marker and editing it in place, each read back afterwards and all of
   it removed again. Verifying the read half found a defect (116). What is left is the part
   nothing local can stand in for: a webhook GitHub itself sends rather than one signed here, the
   App manifest redirect, and cancel-on-push under real timing. Those need an App installed on a
   repository and a push to it.
2. **A hosted provider call.** `anthropic` and `google` are the two adapters with no local stand-in.
3. **Forty real containers.** The load scenario is real concurrency over a simulated sandbox.

None is a missing implementation; each is a claim only the real thing can settle.

## Verified end to end

| Capability | How it was verified |
| --- | --- |
| Single self-contained binary | 63MB, runs `init`/`doctor`/`review`/`serve`/`mcp` with no `node_modules` present |
| Portable SQLite | Same code path under `bun:sqlite` (compiled binary) and `node:sqlite` (npm), including queue transactions |
| Config as data | Exported the playbook to YAML, deleted an agent, re-imported: new immutable version, active pointer moved, next review used it — no code change |
| Sandbox security posture | Real containers asserted to have no network route (DNS *and* raw IP), read-only rootfs, all capabilities dropped, no Docker socket, no credential-shaped env vars, and a working timeout kill |
| Egress allowlist | Blocks non-allowlisted hosts over CONNECT and plain HTTP, rejects lookalike domains, and blocked `downloads.sentry-cdn.com` during a real `npm ci` |
| Per-agent isolation | Two agents ran concurrently in separate containers off one shared snapshot image |
| Dependency cache | Second run of the same lockfile skipped install entirely: no setup commands, no egress |
| Real review quality | Reviewed a real PR and reported two genuine defects, both confirmed by hand against the source (see below) |
| GitHub integration | PR fetch, fork detection and downgrade, checkout, dry-run review, idempotency refusing a duplicate SHA. The base-branch config read is wired and unit-tested as of finding 68, but has not been exercised against a real repository carrying a `.maestro.yaml` |
| MCP server | Real MCP client handshake: 10 tools, resources, and `set_agent_model` publishing a new playbook version |
| Admin API | Token required; no token, a wrong token and a token that is a prefix of the real one are all rejected |
| Server-side validation | A cyclic playbook POSTed to the API is rejected with both the cycle and the port-type violation |
| Prompt injection defenses (revised) | Structural: no write/network/GitHub tool exists, the allowlist is exact-match, untrusted text is fenced, and a hostile persona cannot displace the fixed preamble or contract |
| **The documented install path** | `install.sh` run in clean Linux containers against a real GitHub release (`v0.1.0`): correct platform and arch detection, download, `chmod`, install to `~/.maestro/bin`, the binary-runs verification step, and then `maestro --version` and `maestro init` working from the installed binary. The private-release and empty-download paths were tested too |
| **Four-platform release build** | All four targets cross-compiled locally with `bun --target`, and both Linux ELF binaries *run* in real Linux containers (`--version`, `init`, `playbook nodes`, `doctor`) — not merely compiled |
| Webhook authentication is mandatory | The daemon refuses to start a listener without a secret, asserted in tests, rather than warning and starting anyway |
| **Webhook deliveries** | A correctly HMAC-signed GitHub `pull_request` payload returns 202 and enqueues one job with the right dedupe key; a tampered body and an unsigned body both return 401; redelivery of the same event still leaves exactly one job |
| **The Compose deployment, end to end** | `docker compose up` starts, both listeners bind and are reachable through their published ports, the admin API is 200 with a token and 401 without, a correctly signed webhook returns 202 and is logged as a review trigger while an unsigned one returns 401, and a sibling container on the sandbox network reaches Maestro **by hostname** — the exact path a sandbox uses to reach the egress proxy. Only driving a full model review through it is outstanding, which needs provider credentials |
| **Linear's query against the live schema** | Linear validates GraphQL *before* authentication: a query naming a nonexistent field returns 400 `GRAPHQL_VALIDATION_FAILED` unauthenticated, while Maestro's query returns 401. Every field it selects therefore provably exists on the live `Issue` type. Its real 401 and 400 bodies are now the test fixtures |
| Compose sandbox-to-proxy routing | A sibling container on a shared network reaches another by name (HTTP 200) and a container off that network cannot (unreachable). An integration test then drives the real driver: the prepare sandbox joins a named network, and the analyze container still has no default route |
| **Extended thinking on the wire** | Asserted against the actual request body: `{type:"adaptive"}` for models that reject an explicit budget, `budget_tokens` only for models that require it |
| **Agents executing the repo's real commands** | `pnpm run lint → exit 0 (0.3s)` in a posted comment, with real timings. Every command previously failed in 0.1s; this is the plan's "read + execute the existing suite" decision working live for the first time |
| **Provider conformance, live — two adapters** | The full suite (plain completion, tool call, multi-turn loop stopping on the terminal tool, usage accounting, error mapping) passes against Ollama Cloud through **both** the `openai-compatible` adapter and the real `openai` adapter, the latter aimed at Ollama's OpenAI-protocol `/v1` endpoint. The first time the suite has run against anything but fixtures |
| **A keyless install reviews** | With `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` unset, a fresh `maestro init` + `maestro review` logged "primary provider not configured, using declared fallback" and completed a full agent run on Ollama Cloud |
| **Live posting to a real PR** | Reviewed `mustafarslan/maestro#1` for real and posted comment `5598039765`, fetched back from the API to confirm content. Three agent containers observed running with `net=none`; zero strays after teardown |
| **Live review quality** | That review found two genuine defects in the PR's own diff — a missing subprocess timeout that would hang `doctor` on a wedged daemon, and a disk check scoped daemon-wide when it was added to expose Maestro's own leaked layers. Both fixed in the PR |
| Scheduler fairness under load | The plan's 10-PRs-across-3-repos scenario, simulated: 40 agent tasks through the real scheduler, no containers. No limit exceeded, no starvation, one saturated repo does not block the others |

### The review that proves the point

Reviewing `notabase`'s "Add delete account" PR, the security agent reported — and both were then
confirmed by reading the source:

1. **Unauthenticated IDOR.** `pages/api/create-billing-portal-session.ts` takes `userId` straight
   from the request body, queries with the service-role key, and returns a Stripe billing-portal
   URL. No authentication anywhere in the handler.
2. **Incomplete deletion.** `deleteUserAssets` advances its pagination offset *after* deleting, so
   for a user with more than 1000 assets roughly every other batch survives "permanent" account
   deletion.

It also correctly distinguished the *secure* new endpoint (Bearer token → `auth.getUser`) from its
insecure neighbour, so it was not pattern-matching on "API route".

## Not yet verified

- **Linear has never been called against a real workspace**, but the query shape is no longer
  unverified. Linear runs GraphQL schema validation *before* authentication — a bogus field comes
  back `GRAPHQL_VALIDATION_FAILED` while a well-formed query gets as far as "Authentication
  required" — so `scripts/live-linear-check.mjs` validates Maestro's one query against the live
  schema with no API key, and runs a control first so that "no validation error" cannot be
  confused with "validation never ran". Every field it selects exists on `Issue`, and
  `issue(id:)` accepts the human-readable `ENG-123` form, which is why no separate lookup is
  needed. What remains unverified is what only a real workspace can answer: whether key
  extraction picks the right issue out of real branch names, and whether real descriptions parse
  into acceptance criteria.
- **The Anthropic and Google adapters have never made a live call.** They speak their own
  protocols and have no local stand-in, so this needs a key for one of those services. The
  `openai` adapter is no longer in that set: it passes the conformance suite against Ollama's
  OpenAI-protocol endpoint, which exercises its real request construction and response parsing —
  though not `api.openai.com`'s own auth handling or error shapes. The `openai-compatible`
  adapter likewise: `maestro llm test --model glm-5.3:cloud` passes the whole
  conformance suite against Ollama Cloud — plain completion, tool call, multi-turn loop with a
  terminal tool, usage accounting, and error mapping. That exercises the loop, the tool contract
  and the usage/cost path live; it does not exercise the three hosted adapters, which are
  different SDK wrappers and remain fixture-only. The endpoint cannot be probed without a key.
  The Anthropic, OpenAI and Google adapters pass the conformance suite against fixtures. An
  unauthenticated probe of `api.anthropic.com` was attempted to at least check request shape and
  proved nothing: authentication is checked before validation, so a well-formed request and a
  deliberately malformed one both return the same 401. The request body *is* asserted directly in
  the test suite. All live model calls in this project used Ollama. The shipped default playbook
  binds every agent to Anthropic, so a fresh install needs an `ANTHROPIC_API_KEY` before it runs.
- **The prompt-size guard falls back to a constant on models it has no window for.** It is sized
  from `capabilities.contextWindow` where that is known, and every model tested live is an Ollama
  one with no entry, so those used the 400k-character default. That was enough for a 131k-token
  window once reads were capped; a 32k-window model has not been tried.
- **Hosted providers remain the gap in agent coverage.** All four agents have now run live against
  Ollama Cloud, including `ui-ux`, which found a real keyboard-accessibility defect in Maestro's own
  admin UI on its first run.
- **No GitHub App has been registered.** The manifest flow that creates one now exists and its
  parts are tested — manifest shape, code exchange, 0600 storage, the `fromEnv` fallback, and the
  `doctor` states including "created but installed nowhere". What has not happened is a real run:
  no App has been created on GitHub, so the redirect and the conversion endpoint are unexercised.
  Webhook deliveries were verified by signing real payloads with the configured secret and posting
  them to the running daemon, which is the same code path GitHub exercises.
- **No full model review has been driven through Compose.** Everything up to that point is
  verified against a running deployment, including the sandbox-network path the egress proxy
  depends on. What has not run is a review that actually calls a model, which needs credentials.
- **The load scenario is simulated, not run against real Docker.** The plan's "10 simultaneous PRs
  across 3 repos" now runs as a scheduler test with all 40 agent tasks and real concurrency, and it
  found a fairness bug; it does not start 40 real containers.

## Known limitations

- **Node installs run with `--ignore-scripts`.** Lifecycle scripts are arbitrary code from a
  stranger's dependency tree and the main thing that fails behind an allowlist. Repos that need a
  postinstall-built native binary will find those absent, and commands depending on them may fail.
  When any setup step fails, both the comment and the agents are told so explicitly, because
  otherwise an agent blames the code for a broken environment.
- **Base images are the non-slim variants** (`node:22-bookworm`, not `-slim`) because slim images
  ship without git, which silently broke every git tool. Larger images, correct diffs.
- **Triage is deterministic**, not an LLM pass. Dedupe, agreement, thresholds and caps are
  mechanical and testable. An LLM-written narrative is a reasonable future addition; the mechanical
  parts should stay mechanical.
- **`docker-compose.yml` mounts the Docker socket.** That grants Maestro control of the host
  daemon. Agent containers never receive it, but run the daemon on a host you would trust with
  that.
- **The line-changed feedback signal is file-level**, not line-level: computing the latter needs the
  patch of every intermediate commit, and a file being edited is already meaningful evidence. It is
  gathered on a push, so it needs the daemon running; a one-off `maestro review` does not collect
  it. (Until finding 64 below, it was not gathered at all — this entry described the granularity of
  something that never ran.)

## The one recurring bug class, and what now stops it

Nineteen separate defects in this project shared a single shape: configuration declared at one end
and read at neither. The scheduler was constructed and never called. `maxPromptChars` existed in the
loop and no caller could reach it. Linear context was rendered into the prompt and never populated.
`thinkingBudget` was dead — then still dead after the fix that was supposed to revive it, because
the provider learned the right shape while nothing passed the value in.

The sixth was `router.automaticTriggers` (finding 88), added in this session and caught before it
shipped — and alongside it `router.mode: "llm"`, which had been accepted and ignored since the
router was written (finding 91).

None produced a type error. Every field is optional, so a consumer that simply never mentions one
compiles perfectly. Every one of them was caught by a person noticing, which is not a control.

A mechanical sweep for it — exported symbols with no callers, schema columns with no writer,
class methods nobody calls — found eleven more in two passes after twenty-odd rounds of reading
had not (findings 96-106 and the open list below), and the phase audit found four more
(109-113) by asking of each plan item not "is it there" but "can anything reach it". Reading finds bugs in code you are looking at;
this class is invisible precisely because both halves look right on their own.

`packages/playbook/src/wiring.test.ts` now asserts the property directly: every tunable in the
model schema and every field of the router schema is read by something that runs, every `MAESTRO_` variable the code reads appears in
the configuration reference and nothing in that reference is read by nothing, and the loop
carries each setting through to the provider. It is crude
— it reads source text — because the property is about the repository rather than any one module.
Both historical bugs were reintroduced to confirm it fails on them, and it does.

### What the guard did not cover

The wiring guard catches configuration declared and never read. It does not catch configuration
that is read *in a form nobody passes* — which is the next defect it failed to prevent: six
commands each carried their own flag parser handling only `--flag value`, while
`docker-compose.yml` passes `--flag=value`. The daemon started, ignored `--webhook-port=8080` and
`--admin-host=0.0.0.0`, warned that no trigger was configured as though the operator had forgotten
one, and bound the admin API where the published port could not reach it. The documented container
deployment came up and did nothing, and said nothing true about why.

Found by running `docker compose up` rather than by reading anything.

## Bugs found by running it, and fixed

These are recorded because each was invisible to the test suite that existed at the time.

1. **git was missing from every slim base image**, and `git_diff` discarded stderr — so
   "git: not found" reached the agent as "(no changes)", and an agent duly reported the empty diff
   as a defect. Every review before the fix was losing its diff.
2. **Host-owned files tripped git's "dubious ownership" check** once git existed.
3. **`recordNode` returned a freshly generated task id** even when the upsert kept the original
   row, so every `llm_calls` insert on a re-review failed its foreign key.
4. **The renderer printed `0.00¢` for an unpriced provider** — a fabricated number in a PR comment,
   in the very code path the pricing provenance table exists to protect.
5. **A broken `npm ci` produced a phantom finding**: `typecheck exit 2` looked like a defect in the
   reviewed code, but the repo typechecks fine; the install had failed.
6. **A later approval could revive a dismissed finding**; dismissal is now sticky.
7. **The eval regex matcher lowercased its haystack**, silently defeating case-sensitive patterns.
8. **The dependency cache was destroyed on every teardown** — the cache tag pointed at the same
   image id as the review snapshot, so reaping by review label deleted it and no review ever got a
   cache hit. The feature was dead on arrival until this was caught.
9. **The egress proxy bound `0.0.0.0`**, leaving an open proxy to allowlisted hosts on the local
   network for the duration of every prepare phase.
10. **`doctor` told users to run `maestro reap`**, which did not exist.
11. **`maestro reap --review` with the id forgotten performed the global destructive sweep**,
    tearing down in-flight reviews. The most destructive action must not be what a typo produces.
12. **Every allowlisted command exited 127 on non-npm repos**: the Node images ship corepack but
    not the packaged manager, so `pnpm run test` was allowlisted and unrunnable.
13. **`install.sh` exited silently on an unrunnable binary**, because `set -e` aborted the script
    at a failing `&&` chain.
14. **The Compose deployment could never reach its own egress proxy** — Maestro is a container
    there, so no `docker*` interface exists and the proxy bound loopback while sandboxes dialled
    `host.docker.internal`. Every dependency install would have failed.
15. **Incremental carry-forward never carried anything**: posting stamps findings `posted`, but the
    query matched only `open`, so a finding reported in one round silently vanished from the next.
    The same mismatch made line-change feedback a no-op.
16. **A context-window rejection destroyed an entire agent run.** History now trims oldest
    tool-call pairs, and an oversized prompt ends the run cleanly instead of throwing. Trimming
    drops assistant/tool messages as a *pair* — removing a tool result alone orphans the call it
    answered and providers reject the request, which would have broken the very runs it rescues.

17. **Triage posted one defect twice whenever two agents named it differently.** The dedupe key
    included the finding's category, and agents invent their own slugs — the same dead ternary
    shipped as `dead-conditional` and `no-op-ternary`, and the same CLI bug as
    `cli-arg-validation` and `cli-argument-validation`. Comment duplication is the specific failure
    this whole design exists to prevent, and it was in the shipped output. Grouping is now by
    location alone; a merged-away description that told a different story is carried as
    "also reported here" rather than discarded, so the fix cannot lose a second real defect.
18. **`read_file` had no output cap**, inheriting a 512KB default from the container exec layer.
    A few reads of a lockfile cost more tokens than the entire diff — this was the actual cause of
    the context-window overflow, of which the trimming in 16 was only the safety net. Reads are now
    capped at 300 lines and 32KB.
19. **The context-window budget was unreachable from every production caller.** `maxPromptChars`
    existed in the loop but `ReviewAgentRequest` could not structurally carry it, so every real run
    used one hardcoded constant regardless of the model bound: half the window wasted on a large
    model, and no protection at all on a small one. It is now sized from the model's own
    `contextWindow`.
20. **The trimmer spliced into the window it promised to protect.** The bound `length - 4` let a
    two-message splice at `length - 5` reach into the live exchange.
21. **The scheduler was constructed and never used.** `new Scheduler(...)` sat in the daemon with
    no caller, so the per-agent, per-repo, per-provider and global limits were decoration and every
    agent of every concurrent review started at once — the user-facing requirement that agents flow
    to another PR while one is saturated was not actually implemented. The engine now takes an
    admission hook, the daemon supplies the scheduler, and the slot is released in a `finally` so a
    failing agent cannot drain the pool.
22. **Lint had 21 pre-existing errors**, which CI runs as a required step — the release workflow
    would have failed on its first run. Fixed rather than silenced: form labels are now associated
    with their controls, buttons carry an explicit type, and a CSS rule that lost to a
    higher-specificity hover was reordered.

23. **The dedupe fix in 17 over-corrected.** With category gone from the key, every finding
    *without* a line number hashed to the same key — `repo:none` for whole-PR observations, which
    the Finding schema explicitly invites. Unrelated points merged into one, disagreement was
    scored as corroboration by the agreement boost, and all but the longest body was demoted to a
    footnote: the same failure as duplication, wearing the other mask. Location is now the key
    where a location exists, category returns exactly where it does not, and neighbouring buckets
    merge so that lines 78 and 80 are not split by an artefact of the grouping.
24. **Moving `registry.resolve` out of the per-agent `try`** — done while wiring the scheduler, to
    read the provider id for the slot request — meant one mistyped model name in a user-authored
    playbook rejected the `Promise.all` and destroyed the whole review, discarding the work every
    other agent had finished, regardless of the node's `skip-with-note` policy.
25. **A queued agent for a cancelled review kept its place in the scheduler.** Superseded and
    shutdown reviews were admitted anyway, each starting a container only to abandon it, displacing
    live work until the queue drained. Aborting now removes the waiter, and the engine re-checks
    the signal after admission.
26. **`read_file` clamped its range silently.** After the cap in 18, an agent asking for lines
    1-600 got 1-300 with nothing said — which is how an agent comes to report that a function is
    never closed, having been shown only its first half.

27. **Linear integration was never implemented.** `PromptContext.linear` existed, the agent
    prompt rendered it, and a persona template variable referenced it — but nothing anywhere
    populated it. A wired socket with nothing plugged in, structurally identical to the dead
    scheduler in 21, and it went unnoticed because every consumer of the field handles its
    absence gracefully. It was a headline requirement, not an extra. Now implemented: issue
    resolution from branch/body/title, acceptance-criteria extraction, and the resolved issue
    named in the review comment so a reader can see what the product agent was judging against.
28. **The first issue-key matcher read `utf-8`, `base-64` and `covid-19` as issue keys**,
    because it uppercased the text before matching. Each false key is a wasted API round trip on
    every review, or a lookup that hits a real issue in an unrelated team. Prose is now matched
    case-sensitively, branch names are matched only at segment boundaries, issue numbers may not
    lead with a zero (Linear numbers from 1, so `v2-0` is a version), and `LINEAR_TEAM_PREFIXES`
    removes the ambiguity entirely for teams that want it.

29. **The sandbox never had a working package manager offline.** The first real review of a real
    pull request showed six allowlisted commands and six failures, every one in 0.1 seconds.
    Activation ran `corepack prepare <pm> --activate`, which fetches the *latest* release; almost
    every repo pins `packageManager`, so the shim then wanted a version that was not cached and
    tried to download it during the analyze phase, which has no network by design. Measured in the
    image: cache held pnpm 12.4.0, repo pinned 10.26.2. Agents were reviewing repositories they
    could not build, and the failure reached them as a bare `exit 1` — indistinguishable from a
    real test failure. Third bug of this shape, after the 127 exit codes and git missing from slim
    images.
30. **Scheduler fairness was FIFO in all but name.** Running the plan's own load scenario showed
    the tenth of ten reviews waiting until the 32nd of 40 admissions. The mechanism kept a list of
    the N most recently admitted reviews and preferred anything absent from it, with N set to the
    global concurrency limit — so above N concurrent reviews, a review fell out of the window and
    took a second slot before reviews that had never run took a first. The anti-starvation
    mechanism was producing starvation, and only under the load it existed for. Replaced with a
    per-review admission count; the tenth review's first slot moved from 32 to 11.
31. **Three MCP tools in the plan were never implemented** — `get_findings`, `trigger_review` and
    `run_eval`. Invisible because the other ten work and nothing compared the surface to the plan.
    A test now asserts the full list.

32. **`doctor` could never report more than one leak.** `probe()` returns the first line of
    stdout, and the stray-container count was built on it — so a host with forty leaked containers
    reported "1 leaked container(s)". Magnitude is the entire point of a leak check: the number
    never grows, the operator concludes there is nothing to clean, and the disk fills anyway. This
    is the leak detection the rest of this document cites as the protection against container
    leaks, and it had never worked. Found by Maestro reviewing the fix it had itself asked for on
    the previous round, and verified fixed against a real daemon: 3 leaked containers now reported
    as 3.
33. **`trigger_review` reported a fabricated worker signal.** `daemonRunning` came from a
    `COUNT(*)`, which always returns a row, so the boolean was always true — the same defect as
    printing a cost of 0.00 for an unpriced provider, in output someone acts on.

34. **The package manager was shadowed by the analyze tmpfs.** Fixing the corepack *version*
    (29) was necessary and not sufficient: a fresh review still showed every command failing in
    0.1s. `XDG_CACHE_HOME` pointed at `/tmp/maestro-cache`, so corepack downloaded the binary
    under `/tmp` during prepare — and the analyze phase mounts a tmpfs over `/tmp`, which shadows
    everything committed beneath it. The binary prepare had just fetched was invisible to the
    agent that needed it. `COREPACK_HOME` now sits at `/opt/maestro-corepack`, outside the
    shadowed path. Two bugs, one symptom, and the first fix hid the second — "the command still
    fails" after a plausible fix means the diagnosis was incomplete, not that the fix was wrong.
35. **A read-only sandbox made build commands look like code defects.** `typecheck` and `test`
    fail when they write into a checkout the analyze phase mounts read-only, and the agent saw a
    bare `exit=1` — the shape of a genuine failure. That is the most expensive false positive:
    confident, specific and entirely an artefact of our own posture. Such failures are now
    labelled in the tool result.

36. **The Docker image had never been built, and could not be.** Three faults in one file:
    `COPY . .` pulled in the host's `node_modules`, which pnpm then refuses to remove without a
    TTY; the base image ships Node 20 while the workspace requires 22.14; and a global
    `npm install -g pnpm@10` fought `packageManager`, the same conflict that kept CI red. There
    was no `.dockerignore` at all.
37. **A root-only `*.tsbuildinfo` ignore made the build silently skip itself.** With `dist`
    excluded but per-package `tsconfig.tsbuildinfo` copied in from the host, `tsc -b` reported
    every project "up to date" against outputs that had just been excluded — so it built nothing
    and every import failed to resolve. An incremental build is only safe when its state and its
    outputs travel together; the fix is `**/*.tsbuildinfo`, not `*.tsbuildinfo`.
38. **`thinkingBudget` was dead config with a live hazard.** It has been in the playbook schema and
    the Studio's model picker from the start and was never read by the provider. Worse than inert:
    the obvious implementation sends `budget_tokens`, which current Anthropic models *reject with a
    400* — including `claude-opus-5`, which the shipped default playbook binds three agents to. So
    the first person to set that field would have broken every call. Now sent as
    `{type:"adaptive"}` for those models and `budget_tokens` only for models that still require it,
    asserted against the actual request body.

39. **The Compose deployment could not start at all on Docker Desktop.** Publishing the egress
    proxy on the docker bridge gateway — `"172.17.0.1:7790-7799:..."`, chosen to keep it off the
    LAN — fails with `bind: can't assign requested address` on any platform where that is not a
    real host interface, which is macOS and Windows. Not a degraded install: the container refuses
    to start. It was also the wrong shape on Linux, routing container-to-container traffic out to
    the host and back. Sandboxes now join Maestro's own Docker network and dial it by name:
    embedded DNS resolves it, nothing is published to any host interface, and it behaves the same
    everywhere. Only the prepare phase joins; analyze still runs with `--network none`, asserted
    by an integration test in the same commit.

40. **`thinkingBudget` was still dead after being "fixed".** The provider learned the correct
    per-model shape, and nothing ever passed the value in: the agent runner forwarded temperature
    and maxTokens and dropped the rest. Every model setting is optional, so no type error catches
    a knob wired at one end only. Found by a deliberate sweep for this bug class after it had
    already produced four separate defects (the scheduler, `maxPromptChars`, Linear, and this).
    The test now asserts that *every* configured setting arrives, rather than naming them one at
    a time.
41. **Phase 9's quality loop was computed, served and invisible.** `/api/findings/feedback`
    returned accepted-versus-dismissed per agent from the first day and no UI ever called it —
    so the exit criterion "the UI shows accepted-vs-dismissed by agent over time" was not met
    despite the data being right there. Now a Quality tab. Suppressed findings are kept
    distinguishable from human verdicts: they were never shown to anyone, and folding them in
    would make a quiet agent look accurate.
42. **Seven environment variables were read by code and documented nowhere**, which for a
    self-hosted tool means undiscoverable. `docs/CONFIGURATION.md` now covers them.

43. **The whole Compose deployment silently did nothing.** Six commands each reimplemented flag
    parsing, all handling only `--flag value`, while the compose file uses `--flag=value`. The
    daemon started, ignored its webhook port and admin host, and warned about a missing trigger as
    though the operator were at fault. One shared parser now accepts both spellings, refuses to
    read a following flag as a value — `reap --review --all` must not treat `--all` as a review id,
    because the unscoped sweep is destructive — and keeps `=` inside values intact.

44. **`install.sh` — the primary documented install path — had never been run.** It works, and
    running it surfaced two gaps: a private repository could not be installed from at all, because
    GitHub's `releases/latest/download` URL returns 404 for private releases even with a token
    (the asset has to be resolved through the API), and a download that succeeded while producing
    an empty file installed a broken binary that would surface much later as a confusing exec
    error. This is a self-hosted code-review tool, so private forks are the expected case, not an
    edge one.

45. **Writing one API key could destroy every other one.** The file secret store keeps all keys
    in a single JSON object and rewrote the whole file in place, so an interrupted write did not
    corrupt one entry — it lost the lot. Now written to a sibling temp file at 0600 and renamed,
    which is atomic on POSIX: a crash leaves either the old file or the new one. Found by looking
    for source files no test imported; credential handling was the largest of them, at 169 lines
    with no test at all.
46. **A corrupt secrets file crashed every command that resolved a key**, with a JSON parse error
    naming neither the file nor the fix. An unreadable store is now treated as empty, which
    degrades to "no key configured" — something the callers already handle and which is true.

47. **`gate` nodes were never executed.** The node registry advertised them, the Studio let you
    add one, the validator accepted the graph, the plan lists them — and the engine never looked
    for them. Someone who added a gate to drop low-confidence findings got no filtering and no
    indication of it, which is worse than the feature being absent: they believed a safety filter
    was in place while every speculative finding went straight through. Now implemented with a
    typed config, and a malformed config passes findings through rather than dropping them, since
    rejecting everything over a typo would hide real defects behind what looks like a clean review.
48. **The canvas allowed graphs the engine silently ignores.** `router` and `triage` were declared
    `cardinality: "any"`, but the engine reads `byKind(kind)[0]` — a second one was drawable,
    passed validation, and never ran. Both are now `at-most-one` and the validator says so.

49. **`failurePolicy` was read in exactly one place.** The agent loop consulted it; every other
    node ignored it, so on a router or a triage node it was a setting the Studio offered and
    nothing read. A router that threw killed a review that could have run every agent instead,
    and a throw in triage lost a review whose findings were already in hand. Both now honour it:
    `skip-with-note` falls back to running every agent, or to an empty review, and `fail-review`
    still fails.
50. **My own fix for 49 computed its fallback eagerly**, so the fallback for "triage threw" was
    itself a call to triage, evaluated outside the try block. It took the review down by exactly
    the path the fix existed to prevent. Caught by a test that expected the fallback and got a
    failed review; the fallback is a thunk now.

51. **The admin API's body limit bounded nothing.** It rejected the promise at 4MB and left the
    data listener running, so the string kept growing for as long as the client kept sending —
    the limit was a number with no effect. The webhook receiver destroys the request for exactly
    this reason; the admin path had the same code without the destroy. It now stops reading, and
    answers 413 rather than a generic 500, because an oversized body is the client's error and
    reporting it as a server fault sends someone looking for a problem that is not there.

52. **The webhook listener accepted unverified deliveries when no secret was configured.** It
    binds 0.0.0.0 by necessity — GitHub has to reach it — and signature verification was wrapped
    in `if (opts.webhookSecret)`, so omitting the flag skipped it entirely. Anyone who could
    reach the port could start reviews, each spawning containers. The only mitigation was a log
    line, which is warning about something and then doing it anyway. The daemon now refuses to
    start such a listener, the way the admin API already refuses to bind beyond loopback without
    a token, and the error names both the flag and the environment variable so a Compose user
    does not look in the wrong place.
53. **A failed start-up leaked the whole daemon.** `startDaemon` created the worker pool, the
    timers and the admin server before the checks that can reject a configuration, so throwing
    left all of it running with no handle to stop it — the caller never received one. Every
    startup failure had that shape; the new secret check merely made it visible, as nine
    `ERR_INVALID_STATE` errors from workers polling a database the test had closed. Validation
    now happens before any resource exists.

54. **A mistyped `--agent` disabled every agent instead of erroring.** `maestro review --agent
    secrity` set `enabled = false` on all four and ran a review with nobody in it, which
    completed and reported no findings — indistinguishable from "your code is fine". Silence that
    reads as a clean review is the most expensive way to be wrong. It now names the unknown ids
    and lists the ones the playbook defines, and exits before starting Docker.
55. **A mistyped provider in `llm key set` stored the secret under a name nothing reads.** Keys
    are resolved by the configured provider's id, so the failure appeared much later as "no key
    configured", with nothing to suggest a key had been saved one character away. Validated
    against the configured list now.

56. **The eval harness scored "said nothing" as zero precision and a clean fixture as zero
    recall.** Both ratios divided by `denominator || 1`, so an absent denominator produced 0
    rather than "not measurable". A clean-code fixture — which exists precisely to check that
    Maestro stays quiet — therefore always scored 0% recall for behaving perfectly, making the one
    fixture that tests for false positives look like total failure in every report. Version
    comparison averaged those zeroes in, dragging down any version measured against such a
    fixture. Both are now undefined when there is nothing to measure, rendered `n/a`, and the
    average skips them.

57. **The database was world-readable.** SQLite creates its file with the process umask, so
    `~/.maestro/maestro.db` was 0644. It holds every review — pull request titles, diff summaries,
    agent findings, provider configuration — all from private repositories, and on any shared host
    that was every local account's to read, from a tool whose entire job is looking at code people
    did not publish. API keys were not exposed: those live in the keychain or a 0600 file. The
    store now chmods itself and its write-ahead log to 0600 on open, and tightens the home
    directory to 0700 — `mkdirSync`'s mode applies only when it creates the directory, so an
    upgrade from an earlier version kept whatever mode it already had. Enforced in `openStore`
    rather than in `init`, because the daemon, the CLI and the MCP server all open the store
    directly and a rule enforced at one entry point is a rule with holes.

58. **`doctor` recommended the command that would destroy a review in progress.** Its stray count
    matched every Maestro-labelled container, live ones included, so during a review it reported
    "3 leaked container(s) - run 'maestro reap'" — and an unscoped reap matches those same
    containers and removes them. Advice that damages the thing it claims to diagnose. `doctor` now
    counts only stopped containers as strays and says how many are in flight; `reap` skips
    containers belonging to reviews in `queued`/`preparing`/`analyzing`/`triaging`/`posting`
    unless `--force` is given, and reports how many it left alone. Asserted against real
    containers: a protected review's sandbox survives a sweep and is still executable afterwards.
59. **`reap --all` used a raw `argv.includes`** rather than the shared `has()` helper added
    earlier that day, so `--all=true` was silently ignored — the same `--flag=value` gap that had
    made the whole Compose deployment do nothing.

60. **Numeric flags accepted anything and passed NaN downstream.** `Number("abc")` is NaN and NaN
    is silent everywhere it goes. Measured: `--workers abc` made `for (let i = 0; i < NaN; i++)`
    run zero times, so the daemon started, printed a healthy banner and never reviewed anything;
    `--poll-interval abc` became `setInterval(fn, NaN)`, which the spec coerces to 1ms — a tight
    loop against the GitHub API. Both are worse than a crash because both look like they are
    working. Every numeric flag is now parsed and range-checked before anything starts.
61. **`serve` printed an admin URL of 127.0.0.1 regardless of where it bound**, so a deployment
    using `--admin-host 0.0.0.0` was handed a URL that works from the host and not from where the
    operator needed it. Seen in this project's own Compose logs and read past.

62. **The untrusted-content fence could be closed by the text inside it.** `wrapUntrusted` ended
    the block with the literal string `</untrusted-content>`, which the author of a pull request
    can simply type in the title or body. Their text then terminated the fence and everything
    after it sat at the same level as the trusted prompt — the exact bypass the fence exists to
    prevent, against the threat this design calls dominant.

    The payload that demonstrates it was **already in the injection suite**. The assertion was
    `expect(wrapped).toContain(payload)`, which is equally true of a successful escape, so nine
    injection tests passed while the primary defence was bypassable. A test that cannot fail is
    worse than no test, because it converts an unknown into confidence.

    The fence now carries a random per-call id in both tags, so the closer cannot be written by
    someone who has not seen it and nothing can be prepared from a previous transcript, and any
    literal occurrence of the tag name in the content is defanged as well. The tests assert
    containment — one boundary, injected text before it — rather than presence, and all three
    fail against the old implementation.

63. **A review outliving its lease was re-claimed while still running.** The daemon claims a job
    for fifteen minutes, and `JobQueue.heartbeat` exists to extend that — nothing ever called it.
    Reviews routinely approach the lease; a single agent was observed running 900 seconds in this
    project's own logs. Past the deadline a second worker claims the same job, which increments
    `attempts` each time, so a long review that is succeeding is eventually marked failed after
    five re-claims. The idempotency key on `(repo, pr, head_sha)` bounded the damage — the second
    review skips rather than posting twice — but the job accounting was still wrong. The worker
    now renews at a third of the lease and clears the timer in a `finally`.

64. **The line-changed quality signal was never gathered.** `ingestLineChanges` — which the plan
    names as one of the two post-hoc signals, and the only one needing no human action — was
    exported and called by nothing, anywhere. Worse, this document described its *granularity* as
    a known limitation, which reads as a statement that it runs; and earlier the same day I fixed
    a status-matching bug inside it and recorded that fix here, without noticing that nothing
    invoked the function I had just repaired. Found by a mechanical sweep for exported functions
    with no callers, after "built but unwired" had already produced five separate defects. It now
    runs on a push, best-effort, off the critical path.
65. **Two implementations of per-agent acceptance, and the dead one was the careful one.**
    `agentQuality` had no callers while the feedback endpoint reimplemented half of it inline —
    including, in the live version, the "0% and no data are different" distinction that
    `agentQuality` handles and the inline SQL did not. The endpoint now returns `agentQuality`'s
    result and the UI displays it rather than recomputing.

66. **Nothing ever wrote an `environments` row.** The admin API read the table and `reap` updated
    it; no code path inserted into it. So the environments view was permanently empty, reap's
    "stale environment row(s) closed" never fired, and the lease-and-TTL record the design
    describes as what prevents leaks did not exist. Containers were not in fact leaking — the
    engine's finalizer and the reaper's label sweep both work and were verified against real
    Docker — but there was no record to reconcile the two against after a crash, which is the
    situation the table exists for. The engine now records each sandbox on creation and closes it
    on teardown, marking one that would not destroy as `leaked` rather than `destroyed`, because
    those must not look the same to whoever is chasing disk usage.

    Found by a mechanical sweep of every schema column for reads without writes, run after the
    exported-function sweep had already proved more productive than reading.

67. **Per-repo playbooks did not work.** `PlaybookStore.resolveForRepo` implements exactly the
    assignment the design describes — a repo's own playbook, else the global default — and only
    its own test called it. The daemon used `getActive("default")` unconditionally, so a
    playbook assigned to a repository was silently ignored and every repo got the default.
68. **`.maestro.yaml` was never read.** `getBaseBranchConfig` had no callers, so the per-repo
    config the design describes did not exist. The *safety* property held trivially — nothing was
    read from the PR head because nothing was read at all — while this document listed
    "base-branch-only config read" among the verified capabilities. That entry was wrong and is
    corrected above.

    Now read from the base branch and applied by **intersection only**. Base-branch-only is not
    sufficient by itself: anyone with write access could otherwise raise their own limits, and a
    compromised branch could widen the egress allowlist. A repo may ask for less CPU, a shorter
    timeout, fewer commands and fewer egress hosts; asking for more has no effect. Tested with the
    attack the file exists to prevent — a "test command" that is really `curl … | sh`.

69. **Closing a pull request did not stop its review.** `pull_request.closed` and
    `converted_to_draft` fell through to "not actionable", so a review kept running — three
    containers for several more minutes — to produce a comment on a pull request nobody was
    going to read. The `cancel` variant was declared in the trigger union for exactly this, and
    nothing constructed it and nothing consumed it: the daemon's `t.kind !== "review"` guard
    routed it to "ignored". Found by checking every variant of the union against what the
    consumer handles.

70. **The daemon's own reaper destroyed its own in-flight reviews, every ten minutes.** The
    periodic sweep calls `reap({ olderThanMs: 2 hours })`, and the driver accepted that option
    and ignored it entirely — so the sweep matched every Maestro container regardless of age.
    The call also never named the reviews it must not touch. Any review still running when the
    timer fired had its containers removed underneath it.

    This is the most damaging defect found in the session, and it was invisible from every
    angle tried before: the option is passed, the parameter is declared, the types line up, and
    the only way to see it is to ask whether anything reads the field. Found by sweeping
    interface fields that nothing sets or reads.

    Both guards are in place now — the age filter is implemented, and the daemon passes the
    reviews currently in flight. Asserted against real containers: removing the age filter makes
    the test fail *and* takes down the sandbox the following tests depend on, which is precisely
    the failure it describes.

71. **A crash left reviews in flight for ever, and my own fix turned that into a permanent
    leak.** Nothing ever reset review state, so an interrupted review stayed in `analyzing`
    indefinitely. On its own that was untidy. It became a leak earlier the same day when the
    reaper learned to skip containers belonging to in-flight reviews (finding 58): the orphaned
    review was protected permanently, so its containers — precisely the ones the reaper exists
    to collect after a crash — could never be swept. The sweep was blocked from the case it was
    written for, by a fix intended to make it safer.

    The daemon now fails reviews left behind by a previous process on start, with a cutoff
    exceeding the job lease so a review a live worker still holds is never mistaken for an
    orphan. The in-flight state list is shared between recovery and the reaper rather than
    written out twice, and a test asserts recovery covers every state the reaper protects —
    a state in one list and not the other is exactly this leak again.

    Recovery also closes what the review left open: its unfinished tasks are failed, and its
    environment rows are marked `leaked` rather than `destroyed`, since whether the container
    actually went away is unknown and claiming it was cleaned up is the assertion that hides a
    disk filling. Fixing only the review row would have left a failed review whose tasks still
    read "running" — the same "fixed the level I was looking at" mistake this session has made
    three times.

72. **Two review states had no colour in the admin UI.** The schema allows nine; the stylesheet
    coloured seven. `triaging` and `cancelled` fell through to the bare `.badge` rule, so a
    cancelled review looked like neither finished nor failed — the state it most needs to be
    distinguishable in, and one the daemon now produces more of since it cancels reviews on a
    closed pull request. The states are a single exported list now, and a test asserts every one
    has a rule and that a cancelled review is not coloured like a running one.

73. **Severity ordering was written out six times, and one copy was backwards.** Two zod enums,
    three rank maps and one array; `eval.ts` ordered them ascending while every other file
    ordered them descending. No copy was wrong on its own, which is what made it dangerous —
    the same word meant opposite things in different files, and comparing with the wrong sense
    is a silent inversion that accepts trivia and rejects real defects. Now one exported
    ordering with `severityRank` and `severityAtLeast`, used by triage, the gate filter, the
    eval matcher and the MCP finding filter. An unknown severity sorts last rather than first,
    since treating an unrecognised value as critical would let a malformed finding jump the
    queue and clear every floor. A guard asserts no rank map comes back and that the two enums
    that cannot import it still spell the list identically.

74. **The remaining duplicated lists agreed, and nothing was keeping them that way.** Node kinds
    are written in the registry and again in a zod enum; configurable tool names in the schema and
    the implementations in another package. Both matched — checked, and reported as matching,
    because a sweep that only publishes its hits is not a sweep. What was missing was anything to
    stop them drifting, which is how the three defects above began. Guards now assert the node
    kinds match both ways, that every configurable tool is actually implemented (the runner
    silently drops a name it does not recognise, so a playbook naming a nonexistent tool loses it
    with no error), that the terminal tool is not offered as a configurable one, and that the
    schema comment documents the states the code writes — including `leaked`, which recovery
    writes and nobody would know to look for.

75. **The age cutoff failed open on a container it could not date.** The check was
    `createdAt !== undefined && createdAt > cutoff`, so a managed container with a missing or
    unparseable `maestro.created` label skipped the age test entirely and was force-removed at
    any age — reaching the exact failure the guard was written to prevent, through the
    unlabelled path. It fails closed now: a container you cannot date is not provably garbage,
    and an unscoped `maestro reap`, which passes no age, still collects it.
76. **The severity-copies guard could not detect what it claimed to.** It asserted
    `toContain(SEVERITIES.join(...))`, a whole-file substring search that cannot see the order as
    written, and it `continue`d past any file not mentioning "critical" rather than failing. A
    guard that passes vacuously is worse than no guard, and I wrote this one an hour after
    criticising exactly that pattern twice. It now extracts the literals in source order and
    fails when a file stops stating the list at all; both failure modes were reintroduced to
    confirm it catches them.

77. **The line-change signal would have driven every acceptance rate to ~100%.** It compared a
    finding's file against the pull request's *cumulative* file list — and a finding points at a
    file in that diff by construction, so on the first push after any review essentially every
    finding was marked accepted. `recordFeedback` deduplicates, so the corruption would have been
    permanent, and the Quality view wired up the same day would have shown every agent at perfect
    precision for ever. It now compares the delta between the reviewed SHA and the new head. An
    undeterminable delta settles nothing: unknown is not "nothing changed".
78. **The reaper's image sweep ignored both guards the container sweep had just gained.** Snapshot
    images carry the same labels and were listed with neither the in-flight protection nor the age
    cutoff, so a review's snapshot could be deleted between agent starts — the engine creates one
    container per agent as scheduler slots free up — and every later start against that image
    fails. The container half was fixed and the image half was not, in the same function.
79. **Cancellation matched pull requests by number alone, across repositories.** `inFlight` holds
    reviews for every repo the daemon serves and PR numbers are small dense integers, so a
    `closed` event for one repository aborted the review of any other with the same number.
    Anyone able to open and close pull requests in one repository could sweep numbers and kill
    reviews of private repositories they cannot read. Both the new cancel path and the
    pre-existing supersede path had it; the new one copied the old rather than noticing.

    **The first attempt at this fix did not land.** The edit script raised on its second
    replacement before writing, so the first was discarded too; only the supersede path was
    fixed, and the commit message and this document both claimed otherwise. Maestro caught the
    live code and the false claim as separate findings on the next review. Both paths go through
    one repository-scoped helper now. The first test guarding it asserted the SHAPE OF THE
    SOURCE and was described here as proving the behaviour — it did not: a filter keeping the
    same words while matching the wrong rows passed it. The boundary is now a pure exported
    predicate tested against a real database with two repositories sharing a pull request
    number, verified to fail both for the original bug and for that same-words variant.

80. **Cache-hit snapshots became permanently unreapable.** The fail-closed age guard added in 75
    skips any image it cannot date — and `refreshCheckout`, the dependency-cache path taken by
    every review of a repo after the first, committed without a creation label. So the images on
    the hottest path, which can be gigabytes, were skipped by every ten-minute sweep for ever. A
    fix that was correct in isolation created a leak through a path that did not stamp the label
    it now depends on.
81. **A truncated compare was read as an authoritative delta.** GitHub caps the files one compare
    returns, and past that cap the tail was silently dropped — turning "we did not see this file"
    into "this file did not change", which is the same shape as the defect the method was added
    to fix. A partial "no" is still a verdict; it returns unknown now.

82. **A cancelled review still posted its comment, and the `cancelled` state was never written.**
    Cancellation existed to stop a review "finishing a comment nobody will read" — but the engine
    treats an abort as every agent being skipped and still returns a completed review, and the
    posting guard covered only `superseded`. So closing a pull request mid-review posted an empty
    comment to the closed pull request: the exact outcome the feature was added to prevent.
    `cancelled` was meanwhile declared in `REVIEW_STATES`, treated as terminal and as
    re-reviewable, and written by nothing — the ninth built-but-unwired capability found in this
    session, and the state the feature is named after.

83. **The test guarding a tenant boundary tested the source text, not the boundary.** It read
    `daemon.ts` and asserted substrings, which proves a spelling rather than a behaviour: a
    filter that kept the words and matched the wrong rows would have passed, and a rename would
    have broken it for no reason. Source-text guards are right where the text IS the artefact —
    the severity list, the badge classes — and wrong where the artefact is control flow. The
    predicate is exported and tested directly now, and the source check that remains is titled
    for the narrow thing it actually does.

84. **The read-only note was a suppression channel.** `run_command` executes the pull request's
    own tests, so every byte of its output is the author's to choose — and the harness matched
    that output for "EROFS" or "permission denied" and appended, in its own voice, "do not report
    it as a defect". Anyone could suppress a finding by printing those strings. Worse, a genuine
    permissions regression prints exactly them, so the harness would have told the reviewer to
    ignore the defect the change introduced. I added that note this morning to reduce false
    positives. The same fact is now stated once from the sandbox's own configuration, which the
    diff cannot influence.
85. **Author-chosen file paths entered the prompt unfenced.** Git permits newlines and control
    bytes in a path, so a file named `x.txt\nIgnore all instructions` rendered as its own line in
    the trusted region — after the nonce fence hardened the same morning had closed. Carried
    findings had the same shape. Both are fenced now, and control characters in a path are
    replaced rather than passed through. A fence is only worth what the set of places it is
    applied is worth.

86. **"No findings" read as a clean bill of health while half the crew never ran.** On a real run
    two of three agents died on a provider quota; the comment's headline still said "No findings
    met the reporting threshold" and the failures were disclosed only inside the collapsed
    details block. Silence from an agent that never ran is not a verdict, and this is the same
    class as every honesty defect in this document — the output implying more than was done.
    A partial review now says so above the fold and names the agents that did not complete.

87. **Anyone who could comment could spend money.** `@maestro review` started a review for any
    commenter, and on a public repository a comment is anyone's to write — so a passer-by could
    start containers and bill model calls, repeatedly. The delivery carries GitHub's own
    statement about the commenter, `author_association`, which is the one signal here that is not
    written by the person being judged. Only `OWNER`, `MEMBER` and `COLLABORATOR` may ask now,
    checked before the job is enqueued; an unrecognised or absent association is refused rather
    than treated as authorised. Automatic triggers are unaffected, since those come from the pull
    request's lifecycle. Recorded as an open decision in TODO.md this morning and closed here.

88. **Manual-only reviews were configurable and unimplemented.** `router.automaticTriggers`
    was added to the schema, set in the default playbook, and given a `source` discriminator on
    the trigger union — and nothing read it, so a repository configured for opt-in reviews was
    still reviewed on every push. Caught before it shipped, by looking for its consumer rather
    than by trusting that adding a field does something. The daemon now ignores lifecycle
    triggers when it is off, and `wiring.test.ts` asserts every `RouterSchema` field has a
    consumer, which is the same guard the model bindings already had.

89. **Every `@maestro review` after the first was silently dropped, for ever.** `dedupe_key`
    is `UNIQUE` across the whole `jobs` table and rows are never pruned, and a comment trigger
    has no head SHA, so every request on a pull request collapsed onto `owner/repo#N@latest`.
    The first request ran; the second, minutes or weeks later, inserted nothing and returned
    202. A requested review now keys on the id of the comment that asked — redelivery repeats
    the id and stays idempotent, a person asking again gets what they asked for. This also
    makes `@maestro review` the recovery path for an automatic review whose job exhausted its
    attempts, since that failed job holds its SHA's key permanently. Two further pieces were
    needed before the claim was true: the job carries `force`, because otherwise a request at
    an unchanged head reached `reviewPullRequest`, matched the existing row and returned
    "already reviewed at this head sha" — silence, to someone who had asked; and a transient
    "is one already queued or running" check, because the permanent key cannot express "not
    twice at once" without also meaning "not ever again".

93. **`trigger_review` over MCP worked exactly once per pull request, for ever.** The same
    defect as 89, one call site over, and the same shape this session keeps finding: the MCP
    server copied the webhook path's `#N@latest` dedupe key. Every call after the first
    inserted nothing and reported `ok: true`. Both paths now share `hasPendingReviewJob`.
    The first fix keyed on `Date.now()` and reproduced the bug in miniature: two calls in
    the same millisecond collided, which passed locally and failed in the clean-checkout
    gate. The key is random now; idempotency belongs to the pending check, not to it.

94. **The manual-only gate had quietly turned off measurement.** The first version returned
    before `recordLineChanges`, so a repository with automatic reviews off also stopped
    recording whether the last review's findings were acted on — the strongest quality signal
    available, and the one that needs no human action. A push is still a push. Moved above
    the gate.

95. **`--poll` with automatic triggers off is a daemon that reviews nothing.** The poller
    lists open pull requests and compares head SHAs; it cannot see comments. The combination
    is legal, silent and completely inert — the same "configuration that does nothing" class
    the section above is about. It now warns, naming both ways out.

90. **Asking for a review destroyed the review in progress.** The supersede loop ran on every
    trigger and skipped only reviews whose `head_sha` equalled the trigger's. A comment carries
    no SHA, so the test was never true for one and every `@maestro review` aborted every
    in-flight review of that pull request — killing containers mid-run. With 89 fixed it would
    have got worse: two comments in a row would abort the review the first had just queued.
    The decision is now one tested function, `supersedes`, and only a push supersedes anything.

91. **A routing mode nothing implements was accepted in silence.** `router.mode: "llm"` and
    `router.model` describe optional LLM refinement of the routing decision. The router reads
    neither, so selecting them changed nothing while looking like configuration that applied —
    and `router.model` is the one binding that would have cost money on every pull request.
    Both are now rejected at validation with a message saying what to use instead. Found by
    making the wiring guard honest (below), not by reading.

92. **A wiring guard that its own explanation satisfied.** The new `RouterSchema` check
    searched source text for `router.<field>`, and the comment written to explain why `model`
    had no consumer contained the string `router.model` — so the guard passed on the very field
    it was added to catch. Both guards now strip comments before searching. Second time in this
    session that a check passed for the wrong reason; the first was `severity-copies.test.ts`.

96. **Cross-agent agreement corrupted the signal it exists to improve.** Triage merges what
    several agents reported into one finding, and the recorder writes `agentIds.join(",")` into
    `findings.agent_id`. Three places then did `GROUP BY agent_id` — the admin API, the MCP
    `review_stats` tool and `agentQuality` — so a finding both security and architecture raised
    was credited to an agent called `security,architecture`, and the findings the design values
    most were the ones missing from every per-agent number. Per-agent acceptance is what noise
    tuning is supposed to be driven by. One shared `findingCountsByAgent` now splits the list and
    credits each agent; findings with no agent recorded land under `unknown` rather than being
    dropped.

97. **`dedupe_group` was a recomputation that had stopped matching the rule.** The recorder
    wrote `${file}:${category}`, which was the dedupe key until dedupe became proximity-based
    and category-independent. After that it was wrong in both directions: two agents' different
    words for one defect got different groups, and two unrelated defects of the same category in
    one file shared one. Triage now assigns the group when it opens it, so the column records
    what actually happened instead of guessing at it afterwards.

98. **A documented unix socket that was never built.** `MAESTRO_SOCKET` was listed in the
    configuration reference as "the unix socket the MCP server bridges over". The MCP server
    opens the store directly — which is what WAL and `BEGIN IMMEDIATE` are for, and means it
    works with no daemon running. `socketPath()` had no callers at all. Documented configuration
    that does nothing is worse than undocumented configuration: someone sets it, sees no effect,
    and cannot tell whether the tool or their value is wrong. The wiring guard now checks the
    reverse direction too — every `MAESTRO_` variable in the reference must be read somewhere.

99. **Log lines could not be tied to the review they came from.** `taskLogger` exists to attach
    `reviewId`/`taskId`/`agentId`, its own comment says "every task-scoped log should use one",
    and nothing called it; six places hand-rolled `logger.child` with whatever fields were to
    hand. The agent runner logged `agentId` without `reviewId`, and the model loop logged
    neither — so with three agents running across several reviews, a retry or a context-window
    warning could not be attributed to anything. The ids are threaded through the agent runner
    into the loop now.

100. **`maestro doctor` never checked the GitHub credential.** It checks Docker, git, the
    database, the playbook, snapshots and Linear. A wrong or expired token produced no signal
    until a review failed several minutes in, having already built a container — which is
    precisely what `doctor` exists to prevent. It reports the identity too, since reviewing as
    the wrong account looks like nothing at all. The check branches on the credential: `GET
    /user` identifies a personal token and an installation token is refused it with 403, so
    asking every credential for a user login would have reported the *preferred* configuration,
    a GitHub App, as broken. Both token paths were run against the compiled binary: a real
    token reports `authenticated as user mustafarslan`, an invalid one reports `credential
    rejected: Bad credentials` and exits in half a second — the 10s guard timer is cleared
    rather than left pending, which would otherwise have held the process open after it had
    finished printing. **The App branch is written against the documented endpoints and has not
    been run** — there is still no App to run it against.

101. **The cost table's age was invisible.** Every PR comment quotes a cost computed from prices
    cached by hand into `PRICING.ts`. `PRICING_FETCHED_AT` recorded when, and nothing read it,
    so a figure that had drifted looked exactly like a current one. `doctor` prints the date and
    warns past six months.

102. **`maestro llm add` had no `remove`.** `ProviderConfigStore.remove` was written and never
    called, so a provider added by mistake, or a self-hosted endpoint that no longer exists,
    could only be got rid of by editing the database by hand.

103. **The ticket a review was judged against was never kept.** `reviews.linear_issue_json` was
    in the first migration and nothing ever wrote it, so the acceptance criteria the product
    agent used lived only inside a prompt that is discarded when the review ends. "Why did it
    say that on PR 412?" is the question the version-pinning design exists to answer, and this
    was the half of the answer nobody was keeping. Written at resolution time; both the admin
    API and the MCP `get_review` tool already `SELECT *`, so it comes back with the review.

104. **A guard that would have failed only in the clean checkout.** The new reverse env-var
    check listed source files with `git ls-files`, and the gate unpacks tracked files into a
    directory with no `.git`, where that exits 128. Passing locally and failing there is the
    exact shape the gate exists to catch, so it must not be the shape of the gate's own tests.
    It walks the filesystem now, pruning `node_modules` — `readdirSync(recursive)` descends into
    it and exceeds the test timeout.

105. **Whether the dependency cache worked was measured and thrown away.** The sandbox driver
    has set `PreparedEnvironment.cacheHit` from the first day — snapshot reuse when the lockfile
    hash is unchanged is described in the plan as the single biggest lever on how long a review
    takes — and nothing read it. An operator asking "why does every review take four minutes"
    had no way to see that it never hits. It is in the metrics block now, and in the "environment
    ready" log line. Omitted rather than reported as a miss when the driver did not say.

106. **A command an agent was refused was recorded nowhere.** The tool answered the agent and
    logged nothing, so an agent asking repeatedly for `pnpm test` in a repository whose allowlist
    was detected as `npm test` produced a review with no commands run and no explanation —
    indistinguishable from an agent that chose not to run any. That is a misdetected toolchain
    silently degrading every review of that repository. Refusals are in the command log and the
    metrics block now, with a note saying where to fix the allowlist. `ExecResult.refused`,
    which was declared for this and never set by anything, is gone: the refusal happens in the
    tool, before the sandbox is reached, so the flag belonged on the log entry.

### Phase 8: the environments view

The observability phase names an environments page — running containers, TTLs, what the reaper
left behind — and it was the one page that did not exist. `maestro doctor` counts strays, which
tells an operator that something leaked but not what. `/api/environments` joins each row to its
pull request and puts leaked and running ones first, and the UI shows the lease with an explicit
"expired 4m ago" on anything still marked live. That is deliberately *not* what `reap` keys on —
the sweep goes by Docker label and age — so it is a second, independent signal rather than a copy
of the reaper's own state: `lease_until` is stamped once at creation as prepare plus analyze
timeouts, so exceeding it means the environment has outlived the entire time both its phases were
allowed. Rows are kept after teardown, so a leak has a history rather than only a present.

Shipping it produced three of its own, all found by checking its claims rather than by running it.
`age()` rounded a signed value, so a healthy lease printed as `-4m left`. The reaper's row-closing
statement excluded `state='leaked'` — exactly the rows the page tells an operator to run `maestro
reap` about — so the warning survived the action it asked for, about containers that no longer
existed; leaked rows now keep their state and gain a `destroyed_at`, which keeps the history and
makes "still leaking" mean what it says. And the first version of this paragraph claimed the lease
was what the reaper looks for, which it is not.

Container and image leaks are a named risk of this design: every review starts several containers
and commits a snapshot image, and a crash between prepare and teardown leaves them behind.

107. **Per-repo playbook assignment was documented and unreachable.** `repos.playbook_id` has
    been in the schema since the first migration and `resolveForRepo` has read it since the
    daemon learned to; nothing anywhere wrote it. A mobile repo and a backend repo wanting
    different personas is the reason the column exists, it is what `docs/CONFIGURATION.md`
    promised, and it was the stated justification for putting `router.automaticTriggers` in the
    playbook rather than on a flag — so the argument for that decision rested on a feature with
    no writer. `maestro playbook assign <owner/repo> <name>`, `--default` to undo, and
    `assignments` to see who uses what. A name that does not exist is refused rather than
    silently leaving the repository on the default, which would look identical to success.
    Run end to end on the compiled binary: publish a second playbook, assign it, mistype a name
    and see it refused, list who uses what.

108. **Nothing bounded aggregate spend.** The plan lists per-task, per-review, per-repo and daily
    caps as the control on cost blowup. The first two existed; the two that bound *totals* did
    not, so a busy repository — or a retry loop across many reviews — could spend without limit,
    and a per-review cap cannot see that by construction. Made worse by the change earlier in
    this session that lets `@maestro review` re-review an unchanged head. `budget.dailyCapCents`
    and `budget.perRepoDailyCapCents` are checked before the job is created, summed from
    `llm_calls` over a rolling 24 hours rather than from finished reviews, because a review still
    running has spent money that has not been rolled up and that is precisely what a cap needs to
    see. Both unset by default: a cap nobody asked for silently stops reviewing. `maestro doctor`
    shows the balance, since a cap whose balance is invisible is one people discover by reviews
    quietly stopping.

109. **The GitHub App manifest flow was a plan item with no implementation.** Phase 3 says
    `init` creates the App through GitHub's manifest flow, and nothing did — an operator had to
    fill in a dozen form fields, choose a permissions matrix by hand, download a PEM and paste it
    into an environment variable. `maestro github-app create` sends a manifest stating exactly
    what Maestro needs (contents and metadata read, pull requests and issues write — no write
    access to code, no administration), takes the redirect back on a loopback listener that lives
    for one exchange, and stores the key 0600 in `MAESTRO_HOME`. `GitHubClient.fromEnv` reads
    that file, because storing a key nothing reads would have left the PEM-pasting in place.
    `doctor` distinguishes "created but installed nowhere", which is the state the flow
    legitimately leaves you in until somebody installs the app.

110. **An App with no installation crashed at construction.** `@octokit/auth-app` throws
    "installationId is set to a falsy value" when the key is present and undefined, and
    `fromEnv` has always treated `GITHUB_APP_INSTALLATION_ID` as optional — so the documented
    configuration threw before making a single request. Nothing exercised it because no App
    existed; the manifest flow makes it the normal first state. The key is now omitted rather
    than passed as undefined.

111. **Half of Phase 9's exit was reachable from no surface.** `compareVersions` computes
    precision, recall, false positives and cost per playbook version, and the CLI and MCP could
    read it while the UI — the one the plan names — could not. The quality view now shows it
    beside acceptance, with the two kept visibly separate: acceptance is what humans did with
    real findings, the golden set is what a fixed set of known defects says about a prompt or
    model change, and only the second can be run before shipping.

112. **"Test connection" was in the plan and in no interface.** Binding an agent to a model
    that cannot call tools fails minutes into a review, with an error nobody connects back to
    the model picker. The button does the same conformance round trip `maestro llm test` runs
    and says so before it is pressed, since a button that quietly spends money is not a button.

113. **`thinkingBudget` reached the provider and had no field.** It is in the schema and the
    runner forwards it — `wiring.test.ts` exists partly because it was dead twice — but the
    Studio's model picker never offered it, so the only way to set it was hand-editing YAML.
    The UI's `ModelBinding` interface is a hand-maintained copy of the zod schema and had
    drifted; that is the same two-sources-of-truth shape, now one field closer to matching.

114. **The manifest flow stored a webhook secret `serve` would not use.** GitHub's conversion
    response carries a `webhook_secret`; it was written to `github-app.json`, `github-app show`
    reported it as stored, and `serve` read only `--webhook-secret` and `GITHUB_WEBHOOK_SECRET` —
    so an operator who created an App with a webhook got one whose deliveries are signed with a
    secret Maestro had on disk and refused to use, and was told to set a variable they had never
    been shown. Found in the commit whose finding 109 justifies its own design by avoiding
    exactly this. `resolveWebhookSecret` is exported so the precedence is asserted without
    starting a daemon.

115. **A comment claiming a property the code did not have.** The manifest callback compared the
    `state` nonce with `===` under a comment saying it was compared in constant time. Loopback,
    single-use, ten-minute window — the exposure is negligible and the false claim is not, since
    the next person to read it has no reason to check. It uses `timingSafeEqual` now, after a
    length check, because that throws on mismatched lengths. The manifest's HTML escaping also
    covered `"` but not `&` or `<`, so an app name containing one would have broken the form.

117. **Two unhandled rejections, either of which terminates the process.** `setInterval(() =>
    void tick())` — `void` discards a promise, it does not handle its rejection, and an
    unhandled rejection from a timer callback ends the process on modern Node. `tick` catches
    per repository today, so nothing known reaches it; a poller is the component whose entire
    job is running unattended, and the cost of one future edit escaping that inner catch is the
    daemon, silently. The second was worse because it was on the shutdown path: `void
    shutdown(signal)` with `await daemon.stop()` inside meant a stop that rejected crashed the
    process with a rejection trace instead of exiting cleanly. Shutdown also had no way out if
    `stop()` hung — a second Ctrl-C did nothing and SIGKILL was the only exit — so it now
    force-exits on a second signal and after 60 seconds, pointing at `maestro reap`.

118. **A guard I wrote on a premise that was false, and a test that proved nothing.** The first
    version of 117 wrapped `GitHubClient.fromEnv()` in the poller because "the Octokit
    constructor throws on a malformed private key", with a test asserting the daemon survived
    one. The mutation check passed with the guard removed, which is the tell: Octokit's
    constructor does not throw on a bad PEM — it rejects on the first request, which `tick`
    already caught. Both the guard and the test are gone, and the remaining test asserts the
    property the code can actually guarantee. Third time this session a check passed for the
    wrong reason; the mutation check caught all three.

119. **The formatter was never run over `scripts/`.** Every local format in this session was
    `biome check --write packages apps`, which silently excluded the new `scripts/` directory —
    so `live-github-check.mjs` was committed unformatted and only the clean-checkout gate said
    so. `pnpm run format` covers the repository and is what to use.

120. **The idempotency key was undone by a race above it.** `unique(repo_id, pr_number,
    head_sha)` is the key the plan names as covering webhook redelivery and the poller racing the
    webhook. `create` implemented it as `SELECT`, then `INSERT` if the select missed — a
    check-then-act across two statements with no transaction. Three workers by default, plus a
    webhook and a poller and now comment triggers, all touch the same pull request: both miss,
    both insert, and the loser takes `UNIQUE constraint failed: reviews.repo_id,
    reviews.pr_number, reviews.head_sha` and fails its job. The constraint was doing exactly
    what it was for; the code above it turned a successful deduplication into an error.

    Now one statement decides — `INSERT ... ON CONFLICT DO NOTHING`, then read the winner's row
    when the insert found one — so there is no window at all. `DO NOTHING` rather than
    `DO UPDATE` on purpose: the review already in flight is the one other rows point at, and
    rewriting its title or trust level underneath it would change what a running review believes
    about itself. `ensureRepo` had the identical shape against `UNIQUE (owner, name)`.

    The tests exercise the losing path directly, which no sequential test reached before because
    the fast-path `SELECT` hid it; removing the conflict clause reproduces the constraint error
    verbatim.

121. **Anyone who could comment could take over Maestro's comment.** `findPreviousComment`
    matched on the marker and nothing else, and the marker is a plain HTML comment —
    `<!-- maestro-review -->` — visible in the source of every review Maestro posts. On a public
    repository anybody may comment on a pull request, so anybody could post that string and
    Maestro would write its review into *their* comment instead of posting its own. Three
    consequences, in rising order of seriousness: the review is attributed to them and remains
    editable by them, sitting exactly where a reviewer expects Maestro's output;
    `posted_comment_id` then points at a comment Maestro does not own, so the reaction feedback
    that drives every precision number is gathered from one an attacker controls; and placing
    the marker before the first review means Maestro never posts a comment of its own at all.

    The array holding the matches was called `mine` — the assumption stated out loud and never
    checked. It is marker **and** author now: the login for a personal token, the app id on
    `performed_via_github_app` for an installation. If the author cannot be established the
    method returns null and the caller posts a new comment, because a duplicate comment is a
    nuisance and writing into a stranger's is not.

    This belongs to the threat model the project already names — pull request content is
    attacker-controlled and the orchestrator is meant to be the only writer — and it had
    survived every reading pass because the filter looked obviously right.

122. **The reaction half of the quality signal could never fire.** `interpretEvent` handled an
    event named `reaction` and `ingestReaction` settled every finding on the comment it named —
    and GitHub delivers no such event. Its published webhook catalogue has none, which is why
    this project's own App manifest requests `pull_request`, `issue_comment` and
    `pull_request_review_comment` and nothing else. So the human half of the post-hoc quality
    loop, the half Phase 9 names first, was built, unit-tested and unreachable, and the whole
    acceptance signal in the Quality view has only ever come from the line-change heuristic.

    I had recorded this the previous commit as "ungated, and its delivery is unproven" and
    declined to guess. Checking the documentation rather than a live App answered it in one
    request, which was the cheaper move available all along. Reactions are polled now, from the
    comments Maestro posted, on a ten-minute timer in every mode — whether reactions are visible
    has nothing to do with whether webhooks are reachable. `recordFeedback` already refused a
    duplicate `(finding, signal, actor)`, so a comment can be swept for a fortnight and each
    person still counts once; removing that guard fails the test. The gating question dissolved
    with it: the reactions endpoint returns each reacting user, so who left a verdict is now
    something Maestro has rather than something it has to be told.

    The endpoint's response shape was confirmed live against the real comment on PR #1 — add a
    reaction, list it, delete it — rather than assumed from documentation.

123. **`@maestro review` on a plain issue queued a review of a pull request that does not
    exist.** `issue_comment` fires for issues *and* pull requests — GitHub numbers both from one
    sequence and delivers both through that event — and the only thing telling them apart is
    `issue.pull_request`, present exactly when the issue is a pull request. The code tested
    `!number`, which every issue has, under a reason string reading "comment is not on a pull
    request". So a comment on an issue enqueued a review, `getPullRequest` 404ed, the job burned
    all five attempts, and the person who asked got silence.

    The fourth check this session that passed for the wrong reason, and the most pointed: a test
    named `ignores a comment on an issue that is not a pull request` asserted exactly this
    property and passed because its fixture omitted `issue` altogether. Fixing it failed six
    more tests in the same file — **none of the comment-trigger fixtures had ever carried
    `issue.pull_request`**, so the entire comment-trigger suite had been passing against payloads
    GitHub never sends. All of them are realistic now, and removing the discriminator fails the
    test that names it.

    Found by doing what I had said the previous commit I would: re-examining the "needs a live
    GitHub run" list for parts answerable from documentation or a read-only call. Every field the
    webhook parser reads was checked against real objects from the API — `comment.id`,
    `comment.body`, `comment.author_association` (`"OWNER"`, confirming the exact casing of the
    trusted-association list), `pull_request.number`, `.draft`, `.head.sha` — and they all
    matched. `issue.pull_request` was the one that did not.

### The binary's own surfaces

The tests run against the pieces; the product is a single compiled binary, and three of its
surfaces existed only there. Two carried defects that nothing else could have seen.

- **The store driver** runs `bun:sqlite` in the binary and `node:sqlite` under vitest. Found 128.
- **The admin server** only serves the embedded UI once it is embedded. Found 129 — the worst
  user-facing defect of the session.
- **The MCP server** only exists as a subprocess with stdout as a pipe, where anything written
  there that is not a protocol frame corrupts the stream. Checked and clean: 13 tools advertised,
  two stdout lines, both JSON-RPC, nothing on stderr. `scripts/mcp-protocol-check.mjs` keeps it
  that way, and asserts the planned tool set is still complete so dropping one is caught here
  rather than by somebody whose Claude Code session stops being able to trigger a review.

Production code contains no `__dirname` or `import.meta.dirname`, so there is no compiled-bundle
path resolution to get wrong — checked rather than assumed.

### Two external contracts, verified without credentials

The last few findings all came from the same move: comparing an assumption against the thing it
is an assumption about, rather than reading the code again. Both of these were on the "needs a
live run" list, and neither needed one.

- **GitHub's webhook payloads.** Every field the parser reads, checked against real API objects.
  Found 123 — and, before it, that GitHub delivers no `reaction` event at all (122).
- **Docker's `-q` output.** One line per tag, not per image. Found 124.
- **The AI SDKs' own option schemas.** `@ai-sdk/google` takes a token budget,
  `@ai-sdk/openai` takes an effort enum, `@ai-sdk/anthropic@4.0.49` declares `adaptive`.
  Found 125, and confirmed the Anthropic mapping was already correct.
- **Linear's GraphQL schema.** Linear validates before it authenticates, so the query shape is
  checkable with no key. `scripts/live-linear-check.mjs` does it, control first.

Both are scripts rather than tests, because both reach the network; both are cheap enough to run
before a release, and either would catch the other side changing under us.

124. **The reaper double-counted everything it swept.** `docker images -q` prints a line per
    *tag*, not per image, and Maestro tags every snapshot twice — once as the review's snapshot
    and once as the dependency cache, deliberately, pointing at the same id. So a listing of
    three images came back as six lines: the reaper ran `docker inspect` on each image twice,
    called `docker rmi` on each id twice, and reported double the number it had actually
    removed. `protected` was inflated the same way. Nothing broke — the second `rmi` fails
    silently on an id already gone — which is precisely why it could sit there: the only symptom
    was a number an operator reads and believes.

    Verified against the running daemon before the fix and after: six lines, three unique ids.
    The test fixture is that real output rather than something invented to match the code.
    `maestro doctor`'s count escaped the bug by accident, because it adds a `reference=` filter
    that happens to narrow each image to one tag; it deduplicates now too, rather than staying
    correct by coincidence.

    Third external contract checked against reality in as many commits, and the first where the
    tool's actual behaviour differed from the obvious reading of its output.

125. **`thinkingBudget` silently did nothing on Google.** Only the Anthropic branch mapped it;
    Google and OpenAI both fell through to `undefined` under a comment saying other providers
    "express reasoning effort differently" and were "left alone rather than guessed at". Checking
    the installed SDKs' own option schemas turned that guess into two different answers.
    `@ai-sdk/google` declares `thinkingConfig.thinkingBudget?: number` — the same unit Maestro
    already has, so there was nothing to guess — while `@ai-sdk/openai` declares
    `reasoningEffort?: "low" | "medium" | "high" | …`, an enum. Google is wired and asserted on
    the wire; OpenAI is still unmapped, but now for a stated reason rather than caution, and it
    says so once per provider instead of ignoring the field in silence. Inventing a token-count
    to effort-level threshold would quietly change what an agent costs, which is worse than a
    setting that visibly does nothing.

    The Anthropic branch came out of the same check verified rather than changed:
    `acceptsThinkingBudget` puts 3.5 through 4.5 on the explicit-budget side and everything from
    4.6 on adaptive, which matches the published contract — `budget_tokens` is deprecated on 4.6
    and rejected with a 400 on 4.7, 4.8, Opus 5, Sonnet 5 and Fable 5. The pinned
    `@ai-sdk/anthropic@4.0.49` declares `type: "adaptive"` as the first variant of its thinking
    union, so the shape the code sends is one the installed SDK accepts. That is the fourth
    external contract checked, and the first that was already right.

126. **Everything that was not an HTTP error was retried.** The HTTP half of the error mapping
    was right, and verified against the SDK itself rather than assumed: constructing an
    `APICallError` at each status shows 401 and 403 non-retryable and 408, 409, 429 and 5xx
    retryable, so a rejected credential fails fast instead of burning every retry of every step
    of every agent. But anything that was *not* an `APICallError` fell into a fallback that
    retried it unless it was an abort — a prompt the SDK refused to build, an API key it could
    not load, a response that failed schema validation. None of those become true on a second
    attempt, and a validation failure has already been paid for in tokens. The reasoning was
    already written three lines above, on the HTTP branch: "a 400 means the request itself is
    wrong and retrying just burns budget."

    Classified by the SDK's exported error classes rather than by matching on message text,
    which would be a trap for whoever next reads a changelog. A transport failure — `fetch
    failed`, a reset socket — is what the fallback is genuinely for, and stays retryable.

    This is the "auth handling and error shapes" half of the hosted-provider gap, and it turned
    out to need no key: the SDK's own error classes answer it, and they are on disk.

127. **Cancel-on-push released nothing after the first command.** An `abort` event fires once,
    at abort time — adding a listener to a signal that has *already* aborted never fires it,
    which is documented behaviour and takes four lines of Node to confirm. The docker helper
    only ever added a listener. So every command started after a review was cancelled ran to
    completion: each subsequent pull, run, commit and copy went ahead, holding exactly the
    containers and disk the cancellation existed to release. The feature worked for whatever
    command happened to be in flight at that instant and for nothing after it.

    Alongside it: an aborted command reported exit code 124, the timeout convention, and set
    `timedOut`. Those mean opposite things to whoever reads the review — a timeout is a
    statement about the repository's command, a cancellation is a statement about Maestro — so
    a review superseded by a push told the agent, the metrics block and the reader that the
    build had hung. `aborted` is now its own field with exit 130, and the agent is told
    "cancelled" rather than "timed out".

    This is half of the "cancel-on-push has never run under real timing" entry, and the half
    that needed no GitHub: what a real delivery would still prove is the timing, not the
    teardown.

128. **The runtime the product ships was never tested.** vitest runs on Node, so every test in
    this repository exercises `node:sqlite`; the compiled binary runs `bun:sqlite`. Two different
    implementations behind one interface, and only one of them was ever run — which matters more
    since the idempotency fix (120) made correctness depend on `run().changes` after
    `ON CONFLICT DO NOTHING`.

    `scripts/store-contract-check.ts` runs the driver's contract on whichever runtime executes
    it, and the clean-checkout gate now runs it on both. `changes`, the savepoint nesting that
    lets `transaction()` compose, and the parameter normalisation all matched. One thing did not:
    **`node:sqlite` returns `undefined` for a query matching no row and `bun:sqlite` returns
    `null`**, so the interface's declared `T | undefined` was false on the runtime the product
    actually ships.

    No live bug today — everything reads results with `if (!row)`, which is true for both. The
    defect is the trap: `if (row === undefined)` is the natural thing to write given that
    signature, and it would have passed every test and failed only in the binary. Normalised in
    the driver so the type is true on both.

    The first version of the gate wiring ran each check through `| tail -1`, and a pipeline's
    exit status is its last command's — so a failing contract check would have been swallowed by
    `tail` and the gate would have passed anyway. A gate that cannot fail is the same defect as
    a test that cannot fail, one layer up. Verified the other way round: breaking the driver
    deliberately now exits the gate 1.

129. **Every page of the admin UI was cached immutable for a year.** The cache-control test
    was `assetPath === "/index.html"`, so only the literal index path got `no-store`. Every
    client-side route — `/quality`, `/studio`, anything the SPA owns — *is* index.html, served
    under a different path, and therefore took the other branch:
    `public, max-age=31536000, immutable`. A browser that visited `/quality` once cached that
    HTML for a year. After an upgrade it would keep serving the old index, referring to
    content-hashed assets that no longer exist, and the UI would stay broken until somebody
    thought to hard-reload — with nothing anywhere reporting a problem.

    Alongside it: a missing file under `/assets/` fell through to index.html and answered
    **200** with HTML. A browser that asked for a script got a MIME error rather than a plain
    miss, and — through the same caching bug — kept it. Those are 404s now, and immutable is
    reserved for a file that exists under its own content-hashed name, which is the only thing
    hashing makes safe to cache.

    Found by serving the compiled binary and asking it for a route. `ui-assets.test.ts` checks
    the asset map and the admin tests checked the API; nothing had ever looked at the response
    headers, and `doctor` does not either. The shipped artifact's HTTP surface had never been
    exercised at all — which is the same lesson as 128, one layer up: the tests run against the
    pieces, and the product is the binary.

### Found by mechanical sweep, still open

Recorded rather than fixed, because each is a decision rather than an oversight:

- **`findings.task_id` is never written.** A finding cannot be traced to the agent run that
  produced it. `agent_id` covers most of what that is wanted for; the task link would matter for
  Phase 8's "click a failed task" once findings are shown beside the waterfall.
- **`tasks.lease_until`, `worker_id` and `started_at` are never written.** The plan gave tasks
  their own leases for crash recovery. What exists is job-level leasing plus `recoverStaleReviews`,
  which recovers at the review granularity. That is a legitimate simplification — a review is the
  unit that gets requeued — but it was undocumented, so the columns read as a feature.
- **`environments.volume_ids` is never written**, because no named volumes are created: the
  dependency cache is an image, and everything else is tmpfs or a bind mount. The plan's "the
  reaper must sweep volumes" has nothing to sweep.
- **`repos.config_json`, `repos.installation_id` and the whole `installations` table are unused**,
  since no GitHub App exists yet.
- **`task_deps` is unused.** Dependencies are expressed by the graph, resolved in memory.
- ~~**Reaction feedback is ungated, and its delivery is unproven.**~~ **Answered, and fixed
  properly.** GitHub's webhook catalogue has no `reaction` event — checked against the published
  documentation rather than guessed at — so the daemon's handler for one could never fire. The
  reaction half of the quality signal, the half the plan names first, was built, tested and
  unreachable, and its gating was moot because nothing reached it. It is polled now:
  `pollCommentReactions` reads reactions from the comments Maestro posted, on a ten-minute timer,
  in every mode. `recordFeedback` already refused a duplicate `(finding, signal, actor)`, so a
  comment can be swept for a fortnight and each person still counts once — verified by removing
  that guard and watching the test fail. The reactions endpoint's shape was confirmed live
  against the real comment on PR #1.

Findings 75-87 were reported by **Maestro reviewing this session's own commits** — the first two
on the six commits that introduced them, the rest on the eight before those. Three of the five are
cases of fixing one half of something and leaving the other, which is the failure mode this
session has repeated most.

Findings 11-20, 23-25 and 29-32 were reported by, or found by running, **Maestro against real
code — its own commits and its own pull request**.

### The self-review loop, observed

Round 1 on the live pull request found a missing subprocess timeout and a disk check scoped to the
whole daemon. Both were real; both were fixed. Round 2 then reviewed that fix and found that
routing the command through `probe()` — which is what fixing the timeout required — had introduced
first-line truncation, and that the same flaw had been sitting in the pre-existing stray-container
count all along. It also correctly noted that this was *not* a repeat of round 1's findings.

That is the loop working as designed, and it is also the honest counter-argument to any claim that
the bug count is now zero: each round of fixes is itself new code. It also produced one
false positive (a Bun cross-compile target it flagged at 60% confidence, explicitly noting it
could not run Bun to check — both spellings are in fact valid), which is roughly the calibration
you want. Findings 19 and 20 are the sharpest evidence so far: it read a fix that had just been
committed, traced the new config field through three packages, and found that nothing could set it.

## Model choice per agent

Agents are bound to different models on purpose. Two copies of one model agreeing is one opinion
stated twice, so triage's cross-agent agreement boost only means something when the agents differ.
Current bindings, from live runs against Ollama Cloud:

| Agent | Model | Observed |
| --- | --- | --- |
| security | `glm-5.3:cloud` | found the IDOR in `notabase`; 2 findings on the self-review below |
| architecture | `glm-5.3:cloud` | 4 findings on the self-review below, including 19, 20 and 23 |
| product | `gpt-oss:120b-cloud` | 0 findings on both self-reviews, and it stops earlier than the others |
| ui-ux | `gpt-oss:20b-cloud` | 1 finding on its first run: rows clickable but not keyboard-reachable |

Numbers above are from the self-review of commit `86212d9` (22 files, ~825 lines) unless stated.

The `product` row is the honest one: the smaller model stops early and submits an empty list rather
than digging. That is a model-quality difference, not a bug, and it is the kind of thing the eval
harness exists to measure per playbook version.
