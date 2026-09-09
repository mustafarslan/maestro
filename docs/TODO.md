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

## Other

- **A live hosted-provider call has never been made.** Every model call in this project used
  Ollama. `maestro llm test --all` closes it in about a minute once a key is available.
- **The load scenario is simulated.** Forty agent tasks run through the real scheduler; no
  run has started forty real containers.
