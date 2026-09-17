# Security

Maestro clones a pull request, runs language models over it inside Docker, and posts a review
with a GitHub credential. Three things follow from that, and they are what this file is about:
it executes code and content it did not write, it holds tokens, and its output is shaped by
text an attacker can write.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on
https://github.com/mustafarslan/maestro. That opens a private advisory visible only to the
maintainer.

Please do not open a public issue for anything that would let someone escape the sandbox, reach
the network from a review, read a token, or make Maestro post or execute something on a
repository it was not asked to.

One maintainer works on this, so triage is best effort rather than a business-hours guarantee.
Expect an acknowledgement within a week. A report that includes the playbook, the environment
spec, and whether the pull request was a fork is much faster to reproduce.

## What is in scope

- Escaping the analyze or prepare container, or reaching the host from either.
- Reaching a network destination the egress allowlist does not name, in `enforced` mode.
- Reading a GitHub token, an App private key, or a model API key from inside a sandbox, from a
  review transcript, from a finding, or from the database.
- Content in a pull request that makes an agent act rather than report — running a command
  outside the allowlist, writing to the repository, or posting on its own.
- Causing Maestro to review, comment on, or block a repository it was not configured for.
- Authentication or authorization flaws in the daemon's admin API or webhook receiver.

## What is not

- A model writing a wrong, weak, or missing review. That is quality, not security; open an issue.
- A finding that asserts something untrue about the diff. Same.
- Denial of service through a genuinely expensive pull request. Spend caps and disk backpressure
  exist for this; if they fail to hold, that is a bug worth reporting as one.
- Anything that needs the admin token, which is equivalent to operator access by design.

## Known limitations, already documented

These are real and already written down, so they are not news:

- **The prepare phase is still weaker than analyze**, though not by as much as it was. Analyze
  runs `--network none --read-only --cap-drop ALL`. Prepare runs the repository's own dependency
  install, so it cannot be read-only or non-root, but it now drops every capability except the
  six a root-run package manager uses to own the files it writes. A fork pull request never
  reaches this phase at all: forks get no setup commands, no allowed commands, and no egress.
- **The admin API has two levels, not accounts.** The admin token publishes and activates
  playbook versions, which control allowed commands and the egress allowlist, so it is operator
  access; the read-only token that `serve` also prints reads everything and is refused on
  anything that changes state or spends money. Both are shared secrets: revoking one person
  means rotating the token for everyone, and there is no per-user audit trail. The daemon prints
  the admin token in a URL; the UI strips it from the address bar on load and keeps it for the
  tab, but it is still a query parameter on the events stream, so treat both like passwords.
  Bind the admin API to loopback, which is the default.

`docs/STATUS.md` records what has been verified against reality and what has not.
