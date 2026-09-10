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

~~The largest known gap.~~ **Done — `docs/STATUS.md` 205.** `egressEnforcement: enforced` is the
default: prepare runs on a per-review `--internal` network whose only route out is a proxy
container running this same binary, copied in with `docker cp`. The decisions this section used
to ask a person to make were settled by measurement and are recorded in the commit and in
`docs/CONFIGURATION.md`; what is left of the design note lives there rather than here.

Two things a future reader should know about the shape that was chosen:

- **No image is published.** The proxy is a stock `debian:bookworm-slim` with the binary copied
  in at review time. Reusing the Maestro image looked cheaper and is not — the daemon shells out
  to `git` and the `docker` CLI, so its image carries both and is around 450MB against a 63MB
  binary, and it can never be distroless. Publishing a small one would have been this project's
  first container artifact, which neither option avoids. `docker cp` avoids both.
- **A prepare phase with no setup commands needs no network at all.** Fork pull requests
  downgrade to `trust: untrusted`, which runs no setup — and the clone and the image pull both
  happen host-side, so nothing in that container ever dials out. It still gets a proxy container
  and an internal network today. Giving an empty-setup prepare `--network none` outright would
  be both faster and stricter than the proxy, on exactly the path that matters most. Small, and
  deliberately not bundled into the change that introduced enforcement.
- **A registry would buy one thing: a pinned digest.** If a deployment needs an auditable
  immutable artifact for the component enforcing a supply-chain control, that is the argument
  for publishing a proxy image, and it is the only one. `MAESTRO_PROXY_BINARY` covers the
  air-gapped case today.

## Other

- ~~**A live hosted-provider call has never been made.**~~ Done: the conformance suite passes
  against `glm-5.3:cloud`, `deepseek-v4-pro:cloud` and `kimi-k3:cloud` — completion, tool call,
  multi-turn loop with a terminal tool, usage accounting and error mapping. The `anthropic` and
  `google` adapters are verified as far as a refusal by `scripts/live-provider-check.mjs`; only
  their happy path still wants a key.
- ~~**The load scenario is simulated.**~~ Done: `scripts/load-check.mjs` runs 30 reviews across
  3 repositories against real Docker, and `scripts/crash-recovery-check.mjs` covers the kill and
  restart half.
