# TODO

Things worth doing that are not done. Kept separate from `STATUS.md`, which records what
*is* built and how far it has been verified.

## Manual triggering: `@maestro review`

**Asked for:** GitHub supports `@claude review it` to invoke Claude on a pull request on
demand. Maestro should work the same way — and manual invocation may be a better default
than reviewing every pull request automatically.

**Already built:** the webhook path interprets `issue_comment` events and starts a review
on a comment matching `/maestro review` or `@maestro review` (both accepted; the mention
form is what people expect from `@claude`). Trailing words are ignored, so
`@maestro review it please` works. This runs through the same idempotency and scheduling
as an automatic trigger.

**Not built, and each is a real decision rather than an oversight:**

- ~~**A manual-only mode.**~~ **Done.** `router.automaticTriggers: false` in the playbook
  stops the `pull_request` lifecycle events (`opened`, `reopened`, `ready_for_review`,
  `synchronize`) from starting anything; a `@maestro review` comment still does. It lives
  in the playbook rather than on `repos` because playbooks are already assignable per
  repository, so per-repo settings come for free and travel with export/import. Toggled
  from the Studio's settings panel ("Review every pull request automatically").

  Two things had to change with it. A trigger now says whether it came from the pull
  request's lifecycle or from a person, because telling them apart by their reason string
  is a trap for whoever next rewords it. And a requested review deduplicates on the
  comment's id rather than the pull request: `dedupe_key` is unique across the whole
  table and rows are never pruned, so the old key silently dropped every `@maestro review`
  after the first — for ever, including after the first review had finished. A request also
  forces the review, since otherwise one at an unchanged head answered "already reviewed at
  this SHA" to somebody who had just asked.

  Not for `--poll`: the poller cannot see comments, so a polling daemon with automatic
  triggers off reviews nothing. It warns rather than pretending to work.
- ~~**Who may trigger one.**~~ **Done.** A comment trigger is refused unless the delivery's
  `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR` — the repository's own statement
  about the commenter, checked before the job is enqueued. Everyone else can still comment; they
  just cannot spend. Automatic triggers are unaffected, since those come from the pull request's
  lifecycle rather than from someone asking.
- **Acknowledging the request.** `@claude` reacts to the comment so the author knows it was
  heard. Maestro currently answers a comment trigger with nothing until the review posts,
  which for a several-minute review looks like it was ignored.
- **Scoped requests.** `@maestro review security` — run one agent rather than the crew.
  The `--agent` flag already does this from the CLI; the parsing is the missing half.

## Enforcing the prepare-phase egress allowlist

The largest known gap (`docs/STATUS.md` 143): the allowlist is honoured by convention through
`HTTP_PROXY`, and a tool that ignores those variables reaches the internet directly. The design
below is not a sketch — every claim in it was measured against the real daemon, so whoever picks
this up starts from results rather than from the experiments.

**The topology works.** A `--internal` network for the sandbox, and a proxy container attached to
both that network and a normal one. From inside, measured:

| from a container on the internal network | |
| --- | --- |
| direct socket to `1.1.1.1:443` | blocked |
| external DNS | blocked |
| the proxy container, by name | reachable |
| through the proxy, allowlisted host | allowed |
| through the proxy, denied host | refused by the allowlist |

That is real enforcement: the proxy becomes the only route rather than a suggestion. It also
rules out the obvious cheaper option — `--internal` cuts off the host gateway too
(`Network is unreachable`), so the proxy cannot stay in the Maestro process.

**The per-review allowlist is not the obstacle it first looks like.** The allowlist is resolved
per review, from the playbook and the repository's `.maestro.yaml`, so a shared sidecar would
need to know which allowlist applies to which connection. A *per-review* proxy container avoids
that entirely and is symmetric with what already exists: Maestro creates, leases, reaps and
finalises containers per review today, and the `environments` table already models exactly this.

**The obstacle is what runs the proxy, and it is platform-specific.** The tidy answer — bind-mount
Maestro's own single static binary into a container and give it an `egress-proxy` subcommand —
works only where the host binary is a Linux one. Measured on this machine: mounting the macOS
binary into a Debian container gives `exec /maestro: exec format error`, which is obvious in
hindsight and would have been discovered late. So a macOS host needs a Linux image carrying the
proxy: either the published Maestro image, or a small purpose-built one.

**What is left to decide**, and why it wants a person rather than a default:

- Publish a small proxy image, or reuse the Maestro image? The second adds no new artifact to
  build and sign; the first is a few megabytes instead of several hundred, and a sandbox host
  pulling the whole Maestro image to run a proxy is a strange shape.
- One proxy container per review is simplest and matches the existing lifecycle, but it doubles
  container count per review, which interacts with the scheduler's concurrency limits and with
  how the reaper counts strays.
- The host path on Linux could bind-mount the binary and skip the image entirely — worth having,
  or is one code path better than two that differ by platform?

Everything else is mechanical: create the network beside the environment, start the proxy, point
`HTTP_PROXY` at it by container name, and tear both down in the finalizer that already exists.

## Other

- **A live hosted-provider call has never been made.** Every model call in this project used
  Ollama. `maestro llm test --all` closes it in about a minute once a key is available.
- **The load scenario is simulated.** Forty agent tasks run through the real scheduler; no
  run has started forty real containers.
