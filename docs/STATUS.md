# Status

An honest account of what has been verified against reality, and what has not. Kept separate from
the README so the claims in that file stay short and true.

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
| GitHub integration | PR fetch, fork detection and downgrade, base-branch-only config read, checkout, dry-run review, idempotency refusing a duplicate SHA |
| MCP server | Real MCP client handshake: 10 tools, resources, and `set_agent_model` publishing a new playbook version |
| Admin API | Token required; no token, a wrong token and a token that is a prefix of the real one are all rejected |
| Server-side validation | A cyclic playbook POSTed to the API is rejected with both the cycle and the port-type violation |
| Prompt injection defenses | Structural: no write/network/GitHub tool exists, the allowlist is exact-match, untrusted text is fenced, and a hostile persona cannot displace the fixed preamble or contract |
| **Live posting to a real PR** | Reviewed `mustafarslan/maestro#1` for real and posted comment `5598039765`, fetched back from the API to confirm content. Three agent containers observed running with `net=none`; zero strays after teardown |
| **Live review quality** | That review found two genuine defects in the PR's own diff — a missing subprocess timeout that would hang `doctor` on a wedged daemon, and a disk check scoped daemon-wide when it was added to expose Maestro's own leaked layers. Both fixed in the PR |
| Scheduler fairness under load | The plan's 10-PRs-across-3-repos scenario, 40 agent tasks: no limit exceeded, no starvation, one saturated repo does not block the others |

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

- **Linear has never been called against a real workspace.** Key extraction, criteria parsing
  and every degradation path are unit-tested against a fake transport, but no live API key has
  been used, so the GraphQL query shape is unverified against the real endpoint.
- **Hosted providers have never made a live call.** The Anthropic, OpenAI and Google adapters pass
  the conformance suite against recorded fixtures only. All live testing used Ollama. The shipped
  default playbook binds every agent to Anthropic, so a fresh install needs an `ANTHROPIC_API_KEY`
  before it will run.
- **The prompt-size guard falls back to a constant on models it has no window for.** It is sized
  from `capabilities.contextWindow` where that is known, and every model tested live is an Ollama
  one with no entry, so those used the 400k-character default. That was enough for a 131k-token
  window once reads were capped; a 32k-window model has not been tried.
- **Hosted providers remain the gap in agent coverage.** All four agents have now run live against
  Ollama Cloud, including `ui-ux`, which found a real keyboard-accessibility defect in Maestro's own
  admin UI on its first run.
- **The webhook path has not received a real delivery.** Signature verification and event
  interpretation are unit-tested; no GitHub App has been created.
- **The Compose deployment is unverified and labelled experimental in the file itself.** Sandboxes
  are siblings on the host daemon, so they reach the egress proxy only if its port is both fixed
  and published; that is now wired (`MAESTRO_PROXY_PORT_RANGE`, published on the bridge gateway) and
  unit-tested, but running it needs a Linux host with the socket mounted and that has not happened.
- **Release CI has not run.** `.github/workflows/release.yml` cross-compiles four targets; only the
  host target has actually been built.
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
  patch of every intermediate commit, and a file being edited is already meaningful evidence.

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

Findings 11-20, 23-25 and 29 were reported by, or found by running, **Maestro against real code —
its own commits and its own pull request**. It also produced one
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
