# Configuration

Maestro's review pipeline lives in the **playbook**, which is data in the database and edited in
the Studio — not here. This file covers the things that must be settled before the process starts:
where state lives, how credentials are found, and how sandboxes reach the network.

## Credentials

### Model providers

Resolution order, first match wins:

1. `MAESTRO_KEY_<PROVIDER_ID>` — per provider *instance*, uppercased with `-` as `_`. A second
   Ollama instance called `ollama-gpu0` reads `MAESTRO_KEY_OLLAMA_GPU0`. This is the only way to
   give two instances of the same kind different keys.
2. The conventional variable for the provider kind: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
   `GOOGLE_GENERATIVE_AI_API_KEY` or `GEMINI_API_KEY`.
3. The OS keychain — `security` on macOS, `secret-tool` on Linux — written by
   `maestro llm set-key` and never readable through the API or UI.

Environment variables deliberately win over the keychain, so CI and one-off runs need no
interactive keychain prompt.

`MAESTRO_SECRETS=file` forces a `0600` file under `$MAESTRO_HOME` instead of a keychain. That is
the automatic fallback where no keychain tool exists; set it explicitly on a headless host to avoid
depending on what happens to be installed.

`openai-compatible` instances have no conventional variable. Give them
`MAESTRO_KEY_<ID>`, or nothing at all for a local Ollama that needs no key.

### GitHub

A GitHub App is preferred; a PAT works for a single user.

| Variable | Purpose |
| --- | --- |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID` | App credentials; override the stored ones |
| `GITHUB_TOKEN` | PAT, used when no App is configured |
| `GITHUB_WEBHOOK_SECRET` | Required by `serve --webhook-port`; deliveries without a valid HMAC are refused |

The App is easiest to create through GitHub's manifest flow, which states the permissions
Maestro needs and lets you confirm them in one click rather than filling in a form:

```
maestro github-app create               # or --org <org>, --webhook-url <url>
# open the printed loopback URL, confirm on GitHub, then install it on your repositories
maestro github-app installed            # asks GitHub which installation that was
maestro doctor
```

Everything in that flow is loopback — GitHub redirects your own browser back to
`127.0.0.1`, so it needs no public URL and no tunnel. `installed` takes an id if you want to
give one, and checks it against this App's real installations either way; with none, it
records the only installation, or lists them when there is more than one (a personal account
and an organisation, say).

It asks for **contents** and **metadata** read and **pull requests** and **issues** write — enough
to read a diff and post one comment, and no write access to code. The private key is stored 0600
in `$MAESTRO_HOME/github-app.json`; the environment variables above override it if set. Passing
no `--webhook-url` creates the app with its webhook disabled, which is right for `serve --poll`.

A comment can ask for a review — `@maestro review` — but only from someone the repository
reports as `OWNER`, `MEMBER` or `COLLABORATOR`. A review starts containers and bills model
calls, and on a public repository a comment is anyone's to write.

Agents never see any of these. They run offline in a container with no credentials, and the
orchestrator is the only writer.

#### Reviewing only when asked

By default every opened, reopened, ready-for-review and pushed-to pull request is reviewed.
To make reviews opt-in instead, set `router.automaticTriggers: false`:

```
maestro playbook export > playbook.yaml
# router:
#   automaticTriggers: false
maestro playbook import playbook.yaml
```

or flip "Review every pull request automatically" in the Studio's settings panel. Playbooks
are assignable per repository, so one repository can be manual-only while another is not:

```
maestro playbook import mobile.yaml     # publishes a playbook named in the file
maestro playbook assign acme/ios mobile
maestro playbook assign acme/ios --default   # back to the global default
maestro playbook assignments            # who uses what
```
Lifecycle events are then ignored and `@maestro review` is the only way in — still subject
to the association check above.

A requested review deduplicates on the comment that asked, not on the pull request. GitHub
redelivering the same comment does nothing; asking again later runs again, including at an
unchanged head — a request from someone with write access re-reviews rather than answering
"already reviewed at this SHA", and the single per-pull-request comment is updated in place
rather than a second one being posted. Asking again while a review is still queued or
running is ignored, since both askers read the same comment.

That also makes `@maestro review` the recovery path for an automatic review whose job
exhausted its attempts: the failed job holds that head SHA's dedupe key for ever, and a
comment carries its own.

`maestro mcp`'s `trigger_review` behaves the same way and for the same reason — it had the
identical defect, a fixed per-pull-request key that let it work exactly once.

One combination to avoid: `--poll` with `automaticTriggers: false`. Polling cannot see
comments, so such a daemon reviews nothing at all. It warns when it happens.

### Linear (optional)

| Variable | Purpose |
| --- | --- |
| `LINEAR_API_KEY` | Enables issue lookup; absent means reviews run without ticket context |
| `LINEAR_TEAM_PREFIXES` | e.g. `ENG,DES`. Restricts which key-shaped strings are treated as issues — `fix/utf-8-encoding` otherwise looks exactly like issue `UTF-8` |

## Installing

`install.sh` reads these. It depends on nothing but `curl`, which is why the private-release path
resolves assets through the GitHub API with `grep` and `sed` rather than pulling in a JSON parser.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAESTRO_INSTALL_DIR` | `~/.maestro/bin` | Where the binary is written. The installer never edits a shell profile; it prints the `PATH` line for you to add |
| `MAESTRO_VERSION` | `latest` | A release tag, e.g. `v0.1.0` |
| `MAESTRO_REPO` | `mustafarslan/maestro` | Source repository, for a fork |
| `MAESTRO_BASE_URL` | — | Fetch the binary from a mirror or internal artifact store instead of GitHub releases. The asset filename is appended, e.g. `.../maestro-linux-x64` |
| `MAESTRO_TOKEN` | — | Read a **private** release. Required for a private repo: the public `releases/latest/download` URL returns 404 there even with a token, so the installer resolves the asset through the API instead |

A download that succeeds but produces an empty file is treated as a failure, because otherwise it
surfaces much later as a confusing exec error rather than a download problem.

### Exercising an adapter without that provider's account

The `openai` adapter can be pointed at any server speaking the OpenAI protocol, which is
what Ollama's `/v1` endpoint is. That runs the real adapter — request construction,
tool-call parsing, usage accounting, error mapping — against a live server without an
OpenAI account:

```sh
maestro llm add openai-proto --kind openai --base-url http://localhost:11434/v1
echo "unused-locally" | maestro llm key set openai-proto
maestro llm test --provider openai-proto --model glm-5.3:cloud
```

It does not exercise `api.openai.com` itself — auth handling and that service's own error
shapes are still untested — but it is the difference between an adapter that has run and
one that has only ever seen fixtures. `anthropic` and `google` speak their own protocols
and have no equivalent local stand-in.

## State

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAESTRO_HOME` | `~/.maestro` | Database, workspaces, fixtures, the file secret store |
| `MAESTRO_DB` | `$MAESTRO_HOME/maestro.db` | Override the SQLite path alone |
| `MAESTRO_LOG_LEVEL` | `info` | `trace`…`fatal`. Logs go to **stderr**, so stdout stays parseable |

`maestro mcp` opens the same SQLite database directly rather than bridging to the daemon
over a socket. That is what WAL mode and `BEGIN IMMEDIATE` are for, and it means the MCP
server works with no daemon running. An earlier socket-path variable documented here
described a bridge that was never built; it is gone rather than left as configuration that
reads well and does nothing.

## Persona template variables

A persona may interpolate context with `{{…}}`. The Studio lists these beside the editor and
inserts them at the cursor; the same list is what the validator enforces.

| Variable | What it is | Source |
| --- | --- | --- |
| `{{pr.number}}` | Pull request number | Maestro |
| `{{pr.title}}` | Pull request title | author-written — fenced |
| `{{pr.description}}` | Pull request body | author-written — fenced |
| `{{pr.author}}` | Login of whoever opened it | author-written — fenced |
| `{{repo.owner}}` | Repository owner | Maestro |
| `{{repo.name}}` | Repository name | Maestro |
| `{{repo.defaultBranch}}` | Default branch name | Maestro |
| `{{diff.summary}}` | Human-readable summary of the diff | author-written — fenced |
| `{{diff.changedFiles}}` | Changed file paths, comma-joined | author-written — fenced |
| `{{diff.changedLines}}` | Total lines added and removed | Maestro |
| `{{linear.identifier}}` | Linear issue key, e.g. ENG-412 | author-written — fenced |
| `{{linear.title}}` | Linear issue title | author-written — fenced |
| `{{linear.description}}` | Linear issue description | author-written — fenced |
| `{{linear.acceptanceCriteria}}` | Acceptance criteria from the Linear issue | author-written — fenced |
| `{{commands}}` | Commands this agent is allowed to run, comma-joined | Maestro |
| `{{carriedFindings}}` | Titles of unresolved findings from the previous round | Maestro |

Two rules make this safe rather than merely convenient.

**A variable that does not exist blocks the publish.** Rendering an unknown variable as empty is
the right behaviour at run time — a pull request with no Linear issue must still be reviewed — but
it makes a typo invisible: `{{linear.acceptance_criteria}}` against a field named
`acceptanceCriteria` leaves the product agent checking a change against no acceptance criteria at
all, silently. The editor warns while you type and `POST /api/playbook` refuses it.

**`triage.persona` is reserved.** Triage is deterministic — dedupe, cross-agent agreement,
thresholds and the comment cap are implemented in code rather than asked of a model on every
run — so the triage persona and its model binding are carried for the narrative pass the design
describes and are read by nothing today. An agent's persona changes that agent's behaviour;
this one changes nothing, and nothing at run time would say so.

**Author-written values are fenced, not spliced.** The persona is rendered into the *system*
prompt, beside the injection defenses. Interpolating a pull request description there unlabelled
would hand whoever opened it a direct write into that prompt. Those values arrive inside the same
nonce-delimited untrusted-content block the user prompt uses, so a description reading "ignore
previous instructions" is presented as data to review.

## The golden set

`maestro eval` scores a run against a repository state whose answer key is known, which is
what turns "this persona feels better" into a number. Fixtures live in
`~/.maestro/fixtures/*.json`, scores in `~/.maestro/eval-scores/`, and every score records
the playbook version that produced it, so two pipelines can be compared rather than
remembered.

Every fixture belongs to one of two halves:

```
maestro eval add my-case ./repo --split train    # a case a change may be tuned against
maestro eval add my-case ./repo                  # held out; this is the default
maestro eval run --split val                     # score only the held-out half
maestro eval run --playbook pv_1234...           # score a version without activating it
maestro eval gate pv_old pv_new                  # would the candidate replace the current playbook?
maestro eval report                              # both halves, reported separately
```

**A fixture with no stated split is held out.** The conservative direction: a fixture that
silently joins the training set is a fixture whose score stops meaning anything, and nothing
would say so. The report never pools the two — the number a change is chosen by and the
number it is judged by have to be different numbers, or the second one measures nothing.

`scripts/seed-golden-set.sh` builds the whole set on a fresh checkout: the answer keys are
committed under `docs/golden-set/`, and the script generates one fixture repository per key
and installs the keys into `$MAESTRO_HOME/fixtures` with their targets resolved. The numbers
in `docs/STATUS.md` are measured against those twenty, so they are re-runnable rather than
taken on trust.

`maestro eval gate <from> <candidate>` answers the question a refinement loop has to ask:
does the candidate hold up on the **held-out** half? It compares per-fixture recall between
two explicitly named versions — never inferred, because two runs of one configuration share
a version id — counts only fixtures both sides actually ran, and requires a net gain of two
fixtures. That margin is measured, not chosen: one control configuration run twice moved
recall on one fixture in ten, so a candidate that moves one is indistinguishable from the
same playbook run again. It prints the decision and takes no action; exit status is 0 for
accept and 1 for reject.

Recall decides, not precision. The same pair of runs moved precision on four fixtures in
ten, because that number counts every finding the answer key says nothing about.

A fixture's split is decided by a rule, not per fixture: the parity of its fix commit's last
hex digit. Choosing one at a time is choosing which half a result lands in. A fixture
repository also holds source files only — no `package.json`, no tests — so nothing in the
golden set can exercise `run_command`.

Individual fixtures are built by `scripts/make-eval-fixture.sh <name> <fix-commit> <path>...`, which
takes a commit that fixed a real defect and produces a two-commit repository whose base is
that commit's tree and whose head is the same tree with the fix reverted. The diff under
review is then the introduction of a defect this project actually shipped, in the code that
shipped it. Tests, docs and the fix's own explanatory comments are left out: a diff that
deletes the test — or the paragraph — naming the defect measures reading the answer key
rather than deriving it.

The false-positive half of an answer key (`forbidden`) is written from what real runs
report, not guessed at in advance. A forbidden pattern invented up front scores an agent
against a prediction about its wording.

## Procedural guidance for an agent (experimental)

An agent node may carry a **procedural graph** in its `config`: a directed graph over that
agent's tool names, whose edges say which call is admissible after which and carry
`condition`, `guidance` and `pitfalls` text. At each step Maestro localizes the tools just
called, takes their two-hop outgoing neighbourhood, and appends it to the same synthetic turn
that carries the wrap-up nudge. It biases the next action; it does not constrain it — every
tool stays callable.

Each step's guidance replaces the previous step's rather than adding to it. Only one is in
the conversation at a time, which is what "localized" means: stacking them would rebuild
most of the graph in the prompt, and the paper's own ablation puts that configuration below
using no graph at all.

A graph that fails to parse is ignored and the agent runs without guidance, which is
the safe direction — a broken experiment costs the guidance, never the review. It is
logged with the reason, node and agent, because a silently ignored graph produces a
review indistinguishable from one nobody meant to guide.

```yaml
# playbook.yaml
graph:
  nodes:
    - id: n-architecture
      kind: agent
      agentId: architecture
      config:
        proceduralGraph:
          nodes:
            - { id: Start, type: STATE, description: nothing has been read yet }
            - { id: git_diff, description: the change under review }
            - { id: read_file, description: the code the change lives in }
          edges:
            - from: Start
              to: git_diff
              guidance: Call git_diff first. Every judgement here is about what changed.
              pitfalls: Do not begin by listing directories. You do not yet know what you seek.
```

`docs/procedural-graph-architecture.json` is the graph the experiment below used, ready to
paste in. A malformed graph degrades to no guidance rather than failing the review, and an
unmatched step gets silence rather than the whole graph — the paper's own ablation is the
argument for that, having measured full-graph guidance *below* no graph at all.

**Measured, on eight fixtures, one agent, against two runs of the same configuration
without it.** It used fewer solver steps than both control runs on all eight fixtures — 126
and 148 steps down to 63 — with input tokens up 3% and output tokens down 43%. Whether it
changes what the review *finds* is not measurable on a set this small: four of the eight
fixtures moved between the two control runs, so the arms are separated by less than the noise.
`docs/STATUS.md` finding 234 has the whole account, including the hypothesis it was built on
turning out to be false. Off by default, and not a schema field.

## Spend caps

A router tier caps one review and a model binding caps one agent. Neither can see that a
repository has run two hundred reviews today, so there are two aggregate caps, both measured
over a rolling 24 hours and both **unset by default** — a cap nobody asked for silently stops
reviewing:

```
# playbook.yaml
budget:
  dailyCapCents: 2000          # $20/day across everything
  perRepoDailyCapCents: 500    # and no single repo may take more than $5 of it
```

Reached caps refuse the review before the job is created, with a log line saying which cap and
where the total stands. `maestro doctor` shows spend against the daily cap. Spend is summed from
`llm_calls` rather than finished reviews, so a review still running counts — which is the money a
cap most needs to see.

## Disk

Reviews clone repositories, install their dependencies and commit snapshot images, so disk is
the resource they consume that nothing else reclaims. The daemon stops claiming new work when
free space falls below **5 GiB or 5%**, whichever bites first, and resumes on its own when
space returns. Queued work waits rather than being dropped — refusing at the moment a webhook
arrives would lose the request, and nothing asks twice.

The pause is logged once a minute, and `maestro doctor` reports the same number. To recover:

```
maestro reap      # remove stray containers and snapshot images — usually enough
maestro prune     # delete the step-by-step trace of old reviews
```

## Interrupting a review

Ctrl-C on `maestro review` stops the review and tears its containers down before exiting;
it prints a partial report saying which agents did not complete. A second Ctrl-C exits
immediately without waiting, in case the cleanup is itself stuck — which will leave
containers behind, and `maestro reap` collects them.

## Concurrency

Four limits apply to agent admission at once, and the tightest one wins:

| Limit | Default | Applies to |
| --- | --- | --- |
| `global` | 6 | every agent across every review |
| `perProvider` | 4 | agents resolving to one provider |
| `perRepo` | 3 | agents reviewing one repository |
| `perAgent` | 2 | one agent id across concurrent reviews |

**With a single provider configured, `perProvider` is the ceiling and `global` is
unreachable** — raising `global` alone changes nothing. That is the ordinary case: a fresh
install has one credential. Measured, with 30 concurrent reviews across 3 repositories:
peak admission was 4, exactly `perProvider`, never 6.

## Load

`scripts/load-check.mjs` runs the Phase 7 scenario against real Docker: N reviews across M
repositories through the real interpreter and scheduler, asserting that every review
completes, that peak concurrency stays inside the configured limit, and that no container
or fairness tally is left behind.

```
node scripts/load-check.mjs 10 3          # ten reviews, three repositories
node scripts/crash-recovery-check.mjs     # what a restart does with a killed daemon's leftovers
node scripts/live-provider-check.mjs      # anthropic and google reachable, refusals mapped (no key)
```

The second builds the state a killed daemon leaves — a review stuck mid-flight and a real
container labelled as belonging to it — starts a daemon into it, and checks the review is
recovered and the container collected. SIGKILL cannot be handled, so a crash always leaves
containers running; what matters is what the next start does about them.

The provider is stubbed on purpose. The scenario is about containers, admission and
teardown; running real agents would cost an hour and a pile of tokens to tell you nothing
about any of the three. It is not part of the gate — it starts dozens of containers and
takes minutes.

## After a crash

Killing the daemon mid-review and restarting is safe, but not instant, and the delay is
deliberate.

A worker's claim on a job is a **15-minute lease**, and a review is treated as abandoned only
after **30 minutes** — longer than the lease, so a review a live worker is still running can
never be mistaken for an orphan and have its containers destroyed underneath it. The cost is
that after a kill and an immediate restart:

- the board shows those reviews as in flight for up to 30 minutes;
- their queued work is re-claimed after 15;
- nothing is lost, and restarting again does not shorten either number.

The daemon says so on startup when it finds reviews in that state, so an apparently stuck
queue is distinguishable from a genuinely stuck one. Containers left by the killed process
are swept by the startup reap unless they belong to a review still inside that window.

## Checking a pull request's claims

A pull request that says "3x faster", "fixes the flaky login test" or "smaller bundle" is,
by default, just text. `envSpec.compareCommands` makes those claims checkable: each command
runs at the **merge base** — the commit the pull request was written against — and again at
the head, and both results are given to the agents as evidence and printed in the review.

```yaml
# playbook.yaml
envSpec:
  compareCommands:
    - npm test
    - npm run build
```

Off unless you set it. There is no `auto`: every other command list can be detected from the
toolchain because there is a right answer, but which command bears on a claim is a judgement,
and a measurement nobody asked for is a measurement nobody should trust.

**What it reports, and what it refuses to report.**

The verdict is the exit code and nothing else. A test that fails at the merge base and passes
at the head is a fact about the change; that is what the review says, and it is the signal
worth acting on. Timings are printed raw, per run, alongside how many other agent containers
were running at the time — and never as a ratio. A container with two CPUs sharing a host
with other reviews is a poor benchmark host, and "1.8x faster" states far more than two
samples taken there can support.

Output differences are shown but never turned into a verdict. Test runners print timestamps,
durations and temporary paths, so two identical runs differ byte for byte; a normalisation
rule that is subtly wrong yields a confident wrong answer, which is worse than no answer. The
agents read the output and judge it.

Commands are repeated three times per side when the first run took under 30 seconds, so the
spread is visible; slower commands run once and the review says variance was not measured.
The decision uses the slower of the two sides, so both always get the same number of samples.

**When it does not run**, the review says so rather than printing an empty table — "we did
not check" and "we checked and found nothing" are different claims:

| Situation | Reported as |
| --- | --- |
| Fork pull request | `fork pull requests execute no commands` |
| Fork point not found in the clone | `the fork point could not be found, so there is no baseline` |
| Merge-base environment failed to build | `the merge-base environment could not be prepared` |
| The command is new in this pull request | `does not exist at the merge base` |

That last row matters: an npm script the pull request *adds* exits non-zero at the base with
"Missing script", which by exit code alone is indistinguishable from a failing test. Calling
it a base-side failure would manufacture exactly the "fixed" verdict the feature exists to
earn honestly.

**Commands that write.** Analyze containers mount the checkout read-only unless
`envSpec.writableWorkdir: true`. A build or a test that emits coverage will therefore fail
identically on both sides, and the table will read `exit 1 | exit 1 | no change in exit code`
with a permissions error in the output tails. That is a fair comparison but a useless one —
set `writableWorkdir: true` if your comparison commands write into the checkout.

**Cost and safety.** This is a second prepared environment and two more analyze containers
per review, and they are not counted against the scheduler's concurrency limits. Fork pull
requests are excluded twice over — `compareCommands` is emptied along with `setup` and
`allowedCommands`, and the engine refuses again on `trust`. Entries go through the same
deny-pattern check as `allowedCommands`, so a shell metacharacter or a network tool is
rejected when the playbook is saved. A repository's `.maestro.yaml` may remove a command
from this list but never add one.

Local reviews work the same way, and are the easiest way to try it:

```
maestro review . --base HEAD~1
```

The baseline is a copy of the working tree with `git checkout <base>` applied, so on a large
repository with dependencies already installed the copy is not free — it copies
`node_modules` along with everything else.

## Sandbox networking

Only the `prepare` phase has any network, and only through an allowlist proxy. `analyze` runs
with `--network none` regardless of everything below.

There are two postures, chosen with `egressEnforcement` in the playbook's `envSpec`.

### `enforced` (the default)

The review gets its own `--internal` Docker network. A container on one has no default route
and no external DNS — a direct socket to `1.1.1.1` and an external lookup both fail. The proxy
runs in a container of its own, attached to that network *and* to the normal bridge, so it is
the only path out and the allowlist decides what crosses it. That is enforcement rather than
convention: a tool that ignores `HTTP_PROXY` does not reach the internet, it reaches nothing.

The proxy container is a stock Debian image with this same binary copied in, running
`maestro egress-proxy`. Nothing is built, published or pulled from a registry beyond the base
image. Maestro needs a **Linux build of itself for Docker's architecture**, found in this order:

1. `MAESTRO_PROXY_BINARY` — an explicit path, which always wins
2. `dist/maestro-linux-<arch>` — from `pnpm run build:proxy-binary` in a checkout. That
   command also copies the result into the cache below, because `dist/` is resolved relative
   to the working directory and would otherwise only be found while running Maestro from
   inside the checkout
3. this process, when it is already a Linux binary of the right architecture (a Linux host, or Compose)
4. `~/.maestro/cache/maestro-linux-<arch>-<version>`, downloaded from the release once and
   cached. A **private** repository needs `MAESTRO_TOKEN` set to a token that can read it —
   a private release's assets answer 404 rather than 403 on the plain download URL, so without
   one the failure looks like a missing version rather than a missing credential

Releases are cut with `scripts/release.sh` (`--publish` to create the GitHub release). Bun
cross-compiles all four targets from one machine, so this needs no CI; the script refuses to
overwrite an existing tag, because the proxy caches by version and a cache filled from replaced
bytes would never refresh.

If none of those work, the prepare phase **fails** and names all three ways to fix it. It does
not fall back to advisory: a supply-chain control that stops enforcing without saying so is
worse than one that was never claimed, because everything downstream still reports that the
allowlist applied.

| Variable | When you need it |
| --- | --- |
| `MAESTRO_PROXY_BINARY` | Path to a Linux build of `maestro` for the proxy container. Set this on a host that cannot cross-compile and cannot reach the release |
| `MAESTRO_PROXY_BASE_IMAGE` | The image the proxy binary is copied into. Defaults to `debian:bookworm-slim`; any glibc base works, musl (Alpine) does not |

### `advisory`

The older posture, and what to set if a host cannot supply a Linux binary. The proxy runs
inside the daemon and is offered to the sandbox through `HTTP_PROXY` and friends, which
well-behaved tools honour. Nothing forces traffic through it, and a direct socket from inside
the container reaches the internet. The review comment says which posture ran, so an advisory
run is never reported as if it had sealed the phase.

The one question these settings answer is: *how does a sandbox container reach the proxy?*

| Variable | When you need it |
| --- | --- |
| `MAESTRO_SANDBOX_NETWORK` | **Maestro is itself a container** (the Compose deployment). Names the Docker network the prepare sandbox joins, so it reaches Maestro by name. This is the right answer for containerised deployments |
| `MAESTRO_PROXY_HOST` | Manual override of the address sandboxes dial. Defaults to Maestro's own hostname when a sandbox network is set, `host.docker.internal` otherwise |
| `MAESTRO_PROXY_BIND` | Which interface the proxy binds. Defaults to loopback on macOS, the docker bridge on Linux, all interfaces inside a container |
| `MAESTRO_PROXY_PORT_RANGE` | e.g. `7790-7799`. Pins the proxy to a fixed range instead of an ephemeral port, for deployments that must publish it. The range width caps concurrent prepare phases |

Getting this wrong has one symptom: every dependency install fails or times out, and nothing in the
error names this setting. `maestro doctor` reports what is configured.

## Admin surface

| Variable | Purpose |
| --- | --- |
| `MAESTRO_ADMIN_TOKEN` | Bearer token for the admin API and UI. Generated per run if unset |

The admin API binds `127.0.0.1` by default and refuses to bind elsewhere without a token. The
webhook receiver is a separate listener on its own port, because it is the only thing that must be
reachable from the internet and it does signature verification and nothing else.

## Self-hosting

`maestro serve` on a host is the simplest deployment: one binary, the installer is the whole setup.

```sh
maestro init
maestro doctor          # checks Docker, git, database, playbook, Linear
maestro serve --poll owner/repo --admin-port 7777
```

`--poll` needs no public URL and no App, which makes it the right starting point. Move to
`--webhook-port` once an App exists.

For the container deployment see `docker-compose.yml`. It mounts the Docker socket, which grants
Maestro control of the host daemon — run it on a host you would trust with that. Agent containers
never receive the socket.

What is verified and what is not is recorded in [STATUS.md](./STATUS.md).

## Checking a change before pushing

> **CI is manual.** `.github/workflows/ci.yml` runs on `workflow_dispatch` only, and both
> workflows are disabled at the repository level. Every push was starting a run that failed
> for want of Actions minutes rather than for anything about the code, and a red tick that
> means "billing" teaches you to ignore red ticks. `scripts/gate.sh` runs the same steps
> locally — it is what every commit here goes through — so nothing is lost but the second
> opinion of a clean machine. Re-enable the push trigger when there are minutes to spend.

```
scripts/gate.sh /tmp/maestro-gate
```

To commit only if it passes, let the exit code decide rather than reading the output:

```
scripts/ship.sh <<'MSG'
Commit subject

Body.
MSG
```

The gate itself ends with `GATE PASSED` or `GATE FAILED (exit N)`, and that line is the verdict — the
output before it includes other programs' summaries, one of which used to be the last thing
printed and was read as the gate's own.

Unpacks the tracked files plus any uncommitted changes into an empty directory and runs
install, lint, typecheck, the test suite, the store-driver contract **on both runtimes**,
the binary build, the MCP protocol check **against that binary**, and `doctor` — from a tree with no `node_modules` and no stale
`tsbuildinfo`. That combination is what catches the class of problem where the working
tree builds only because of state that is not in the repository, and where the suite
passes on Node while the shipped binary runs Bun.

Two read-only scripts check contracts owned by somebody else, and need no credentials:

```
node scripts/live-linear-check.mjs                 # Linear's GraphQL schema
GITHUB_TOKEN=$(gh auth token) node scripts/live-github-check.mjs owner/repo#1
```

The GitHub one takes `--write` to also exercise posting, finding and updating a comment; it
deletes what it creates, including when a step fails.

CI runs the same checks: lint, typecheck, the suite including the Docker integration tests, the
store-driver contract on both runtimes, the binary build, and the MCP protocol against that
binary. `scripts/gate.sh` is the local equivalent, plus the clean-checkout property CI gets for
free from `actions/checkout`.

Nothing is deleted automatically. `maestro prune [--days 30]` drops the per-step trace —
`spans`, `llm_calls` and `trajectory_turns` — of reviews finished before the cutoff, and keeps
reviews, findings and feedback, which are the quality history and are small. `doctor` mentions
the database size once it passes 50MB.

`trajectory_turns` is the largest of the three by a wide margin: one row per turn of every agent
run, carrying the composed prompts and every tool result verbatim, which is what makes "why did
this agent submit nothing" answerable after the fact. It holds repository text the agent read —
no credential, since the analyze sandbox runs with `secrets: none` — and the same text already
appears in findings as evidence, so it crosses no boundary the database did not already cross.
Prune is how it is bounded.

The daemon's recurring work and what each costs:

| runs | cost |
| --- | --- |
| job queue poll | local SQLite only |
| lease heartbeat | local SQLite only, per in-flight review |
| reaction sweep, every 10 min | at most 50 comment reads, plus 20 pull requests of at most 3 GraphQL pages each — 660/hour |
| pull request poller, every `--poll-interval` | one GitHub request per repository per tick |

`recurring-cost.test.ts` fails if a new recurring job appears without a line here, because the two
worst defects of this kind were both correct code that simply ran too often.

When touching a security control or a guard, check the tests actually hold it:

```
scripts/mutation-check.sh
```

Breaks each guard on purpose and reports any the suite does not notice. It refuses to run on a
dirty tree, because it reverts with `git checkout --`. Not in the gate: it runs the suite once
per mutation.

Before cutting a release:

```
GITHUB_TOKEN=$(gh auth token) node scripts/release-assets-check.mjs
```

Downloads every published asset and reads its executable header, so a dropped or ignored
`--target` in the build matrix — which would still produce four uploads, all built for
whichever runner finished last — is caught here rather than by three quarters of users
being told their platform is unsupported.
