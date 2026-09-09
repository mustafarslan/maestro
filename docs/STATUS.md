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

- **Hosted providers have never made a live call.** The Anthropic, OpenAI and Google adapters pass
  the conformance suite against recorded fixtures only. All live testing used Ollama
  (`glm-5.3:cloud`). The shipped default playbook binds every agent to Anthropic, so a fresh
  install needs an `ANTHROPIC_API_KEY` before it will run.
- **Only two of the four agents have run against a model.** `product` and `ui-ux` have tuned
  personas but no live execution behind them.
- **Nothing has ever been posted to a real pull request.** Every GitHub run was `--dry-run`. The
  posting path, comment updating, and reaction ingestion are unit-tested but not exercised against
  live GitHub.
- **The webhook path has not received a real delivery.** Signature verification and event
  interpretation are unit-tested; no GitHub App has been created.
- **The Compose deployment is unverified.** The proxy-host fix is reasoned and documented but has
  not been run: it needs a Linux host with the socket mounted.
- **Release CI has not run.** `.github/workflows/release.yml` cross-compiles four targets; only the
  host target has actually been built.
- **Load behaviour is untested at scale.** The scheduler's fairness and limits are unit-tested, but
  the plan's "10 simultaneous PRs across 3 repos" scenario has not been run.

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

Findings 11-16 were reported by **Maestro reviewing its own commits**. It also produced one
false positive (a Bun cross-compile target it flagged at 60% confidence, explicitly noting it
could not run Bun to check — both spellings are in fact valid), which is roughly the calibration
you want.
