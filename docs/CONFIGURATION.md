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
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID` | App credentials |
| `GITHUB_TOKEN` | PAT, used when no App is configured |
| `GITHUB_WEBHOOK_SECRET` | Required by `serve --webhook-port`; deliveries without a valid HMAC are refused |

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
are assignable per repository, so one repository can be manual-only while another is not.
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
| `MAESTRO_SOCKET` | `$MAESTRO_HOME/maestro.sock` | Unix socket the MCP server bridges over |
| `MAESTRO_LOG_LEVEL` | `info` | `trace`…`fatal`. Logs go to **stderr**, so stdout stays parseable |

## Sandbox networking

Only the `prepare` phase has any network, and only through an allowlist proxy. `analyze` runs with
`--network none` regardless of everything below.

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
