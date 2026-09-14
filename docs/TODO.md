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
- ~~**Acknowledging the request.**~~ **Done — `docs/STATUS.md` 223.** A 👀 reaction on the
  comment, for a request that was really enqueued or folded into one already queued. Not a
  comment: one consolidated comment per pull request is the anti-noise design.
- ~~**Scoped requests.**~~ **Done — `docs/STATUS.md` 224.** `@maestro review security` runs one
  agent; `@maestro review security, architecture` runs two. The words are captured by the
  webhook parser and resolved against the repository's own playbook by the daemon, because
  whether "security" names an agent is a question about the playbook and not about the shape of
  a delivery. Words matching nothing leave the scope empty and the whole crew runs, which is
  what keeps `@maestro review it please` working — and means a misspelt agent name gets a fuller
  review rather than a silent refusal.

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
- ~~**A prepare phase with no setup commands needs no network at all.**~~ **Done —
  `docs/STATUS.md` 225.** `--network none`, no proxy container, no review network.
- **A registry would buy one thing: a pinned digest.** If a deployment needs an auditable
  immutable artifact for the component enforcing a supply-chain control, that is the argument
  for publishing a proxy image, and it is the only one. `MAESTRO_PROXY_BINARY` covers the
  air-gapped case today.

## The refinement proposer

**What exists** (`docs/STATUS.md` 241): the validation gate (`gateCandidate`), rejection memory
(`recordAttempt`, `priorRejections`), a train/val split on the golden set, `created_by` on
playbook versions, and per-turn agent trajectories in `trajectory_turns`. **What does not:** the
thing that proposes a candidate. It is a model call, so it waits for a provider — but most of
what surrounds it does not, and that part can be built and tested first.

**The one rule that decides whether any of this measures anything:** the proposer sees the
TRAIN half only. If a held-out fixture's name, answer key or score reaches its prompt, the gate
stops measuring generalisation and starts measuring memory. Enforced in code and in a test that
builds the prompt over the real golden set and asserts no `val` fixture's name or `match` pattern
appears in it — not left to a comment.

**Inputs to one round**, all from `train`:

1. The latest train scores for the version being refined: per fixture, `misses` and
   `falsePositives` (`loadScores`, filtered by version and split).
2. For each missed fixture, what the agent actually did: its `trajectory_turns`, reduced to the
   tool calls, their outcomes and the final `submit_findings`, and capped in characters.
   **Step 0, because this join does not exist:** `EvalScore` carries no review id, so a score
   cannot be traced back to the run that produced it. Add `reviewId` at scoring time; older
   scores simply have none and contribute no trajectory.
3. `priorRejections(db, playbookId, { limit: 20 })`, so a round is not told to rediscover a
   failure.
4. The current playbook, restricted to the fields a candidate may change.

**Output:** `{ rationale, edits: [{ path, value }] }`, validated with zod, at most three edits.
`path` is checked against an allowlist of playbook FIELDS — agent personas,
`node.config.proceduralGraph` guidance and pitfalls, `triage.minConfidence`,
`triage.maxInlineComments`, `triage.agreementBoost`, gate node config — and never graph topology
(`refine.ts` says why: nothing executes `graph.edges`) and never model bindings, which would turn
a quality search into a cost search.

**One round:**

1. Apply the edits to a copy; `safeParsePlaybook` and `validateGraph`. Invalid →
   `recordAttempt({ decision: "invalid" })` with the reason, and stop.
2. `PlaybookStore.publish(candidate, { activate: false, createdBy: "refiner:<attempt id>" })`.
3. `maestro eval run --playbook <candidate>` over both halves: `val` for the gate, `train` as
   evidence for the next round.
4. `gateCandidate(scores, from, candidate)`. Rejected → `recordAttempt` with the decision.
   Accepted → `recordAttempt` and print it. **Activation stays a human step**
   (`maestro playbook activate`): at ten held-out fixtures a gate is evidence, not a verdict.
5. Stop on the round limit, a cost cap, or two rejections in a row.

**Build order**, each step testable before the next:

| step | needs a provider | test |
| --- | --- | --- |
| 0. `reviewId` on `EvalScore` — **done, 243** | no | a score written by `eval run` names its review |
| 1. edit schema, path allowlist, apply-to-copy — **done, 243** | no | disallowed paths refused; topology and bindings untouchable |
| 2. evidence builder, train only — **done, 243** | no | no val name or pattern in the prompt, over the real golden set |
| 3. prompt and output parser — **done, 243** | no | malformed or oversized output becomes an `invalid` attempt |
| 4. the round, fed a hand-written `--proposal <file>` — **done, 243** | no | publish → gate → record, against synthetic scores |
| 5. the model-backed proposer | yes | one conformance run: valid schema, allowlisted paths |
| 6. one live round on the finding-239 control arm | yes | a recorded attempt, accepted or not |

Steps 0–4 are the work available while the quota is out. A round in step 6 costs one proposer
call plus a full twenty-fixture eval, so it runs one round at a time, by hand.

**Open before step 5:** whether one round should edit one agent only, so that a gate decision
can be attributed to one change; and whether a net-two margin over ten held-out fixtures lets
through anything but large changes — if nothing ever clears it, that is the golden set asking to
grow, not the margin asking to shrink.

## Developer profiles: what is left

Built (`docs/STATUS.md` 242): scoring, battery 2.2, the active profile, the triage agent, the
review state on GitHub, the Profiles tab, recorded dispositions. Left, each with its reason:

- ~~**A live triage agent run.**~~ Done 2026-09-14 on `glm-5.3:cloud`: `comment-marker-author`
  reviewed as a conservative profile, the agent's answer used, the finding blocked and reworded.
- ~~**A live review-state check.**~~ Done 2026-09-14 on `mustafarslan/maestro#5`: under a token,
  GitHub refused a block on the account's own pull request and Maestro reported it; under the App,
  review 5196844015 was submitted and then dismissed by the login learned from it.
  `scripts/live-github-check.mjs --write-review-state` requests
  changes on a real pull request and dismisses the block. A submitted review cannot be deleted, so
  it runs on the user's word, against a pull request they choose. Run it under GitHub App auth
  as well as a token: an App cannot ask who it is, so dismissal relies on the login learned from
  Maestro's own summary comment, which `reviewPullRequest` finds before it settles the state.
- ~~**A place to configure the policy.**~~ Done: `triage.profilePolicy` in the playbook
  (`docs/CONFIGURATION.md`, "Developer profiles").
- ~~**Which profile a webhook review runs as.**~~ Decided: locally one profile per person (each
  checkout's own database and OS user); `maestro serve` one active profile for all.
- **A topic for correctness defects.** `off-by-one`, `logic-error` and `type-error` map to no
  battery topic and so to the neutral weight; with the identity scale that no longer lowers them,
  but a developer's view on them is never measured. That wants new battery items.

## Other

- ~~**A live hosted-provider call has never been made.**~~ Done: the conformance suite passes
  against `glm-5.3:cloud`, `deepseek-v4-pro:cloud` and `kimi-k3:cloud` — completion, tool call,
  multi-turn loop with a terminal tool, usage accounting and error mapping. The `anthropic` and
  `google` adapters are verified as far as a refusal by `scripts/live-provider-check.mjs`; only
  their happy path still wants a key.
- ~~**The load scenario is simulated.**~~ Done: `scripts/load-check.mjs` runs 30 reviews across
  3 repositories against real Docker, and `scripts/crash-recovery-check.mjs` covers the kill and
  restart half.
