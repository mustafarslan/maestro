import { logger } from "@maestro/core";

/**
 * Linear issue lookup.
 *
 * The product agent's job is to check a diff against what was actually asked for, and
 * the PR description is the author's own account of that — the least reliable source
 * available when the question is "does this do what the ticket said". The issue is the
 * independent record, so it is fetched here and injected into the agent's context.
 *
 * Deliberately NOT exposed as an agent tool. Agents run offline with no credentials;
 * giving one a live API client would put a token inside the sandbox and let
 * attacker-controlled PR text drive requests to an internal tracker. The orchestrator
 * fetches, the agent reads text.
 */

export interface LinearIssue {
  identifier: string;
  title: string;
  description?: string;
  /** Extracted from the description when it uses a recognisable heading. */
  acceptanceCriteria?: string;
  url?: string;
  state?: string;
}

/**
 * Issue keys in prose: uppercase by definition, e.g. `ENG-1234`.
 *
 * Case-sensitive on purpose. Uppercasing the text first and then matching turns `utf-8`,
 * `base-64` and `covid-19` into issue keys, and every false key is a pointless API round
 * trip on every review — or worse, a real issue in an unrelated team that happens to own
 * that prefix. Two letters minimum, because a single letter matches far too much prose,
 * and the number may not lead with a zero — Linear numbers issues from 1, so `v2-0` is a
 * version string, not a ticket.
 */
const PROSE_KEY = /\b([A-Z][A-Z0-9]{1,4})-([1-9]\d{0,5})\b/g;

/**
 * Issue keys in a branch name, where tooling lowercases them.
 *
 * Anchored to segment boundaries — the start of the name or after `/` or `_`, and ending
 * at `-`, `_`, `/` or the end. Linear's own generated branches look like
 * `mustafa/eng-412-add-delete-account`, so the key is always its own segment; that
 * anchoring is what keeps `fix/utf-8-encoding` from being read as issue UTF-8.
 */
const BRANCH_KEY = /(?:^|[/_])([A-Za-z][A-Za-z0-9]{1,4})-([1-9]\d{0,5})(?=$|[-_/])/g;

/**
 * Optional allowlist of team prefixes, e.g. `LINEAR_TEAM_PREFIXES=ENG,DES`.
 *
 * Unset means accept anything key-shaped, which is the right default for a single-team
 * workspace. Setting it removes the false-positive class entirely.
 */
function allowedPrefixes(): Set<string> | undefined {
  const raw = process.env.LINEAR_TEAM_PREFIXES?.trim();
  if (!raw) return undefined;
  const set = new Set(
    raw
      .split(/[,\s]+/)
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean),
  );
  return set.size ? set : undefined;
}

/**
 * Finds the issue this pull request is about, in order of how deliberate each source is.
 *
 * A branch name is chosen by the author before any work and is what Linear's git
 * integration generates, so it is the strongest signal. The PR body comes next, then the
 * title. Later sources never override an earlier one — a body mentioning three related
 * tickets must not displace the one the branch names.
 */
export function extractIssueKeys(sources: {
  branch?: string;
  title?: string;
  body?: string;
}): string[] {
  const prefixes = allowedPrefixes();
  const seen = new Set<string>();
  const keys: string[] = [];

  const collect = (text: string | undefined, pattern: RegExp) => {
    if (!text) return;
    for (const match of text.matchAll(pattern)) {
      const key = `${match[1]?.toUpperCase()}-${match[2]}`;
      if (prefixes && !prefixes.has(match[1]?.toUpperCase() ?? "")) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  };

  collect(sources.branch, BRANCH_KEY);
  collect(sources.title, PROSE_KEY);
  collect(sources.body, PROSE_KEY);
  return keys;
}

/**
 * Pulls the acceptance criteria out of an issue description.
 *
 * Teams write them under a heading and nothing enforces which one, so this recognises the
 * common spellings and falls back to returning nothing. Returning the whole description
 * as "acceptance criteria" would be worse than returning none: the agent would treat
 * background prose as a checklist and report every unmet aside as a defect.
 */
export function extractAcceptanceCriteria(description?: string): string | undefined {
  if (!description) return undefined;

  const heading =
    /^\s{0,3}#{1,6}\s*(acceptance criteria|acceptance|success criteria|definition of done|requirements)\b.*$/im;
  const start = description.match(heading);
  if (!start || start.index === undefined) return undefined;

  const after = description.slice(start.index + start[0].length);
  // Stop at the next heading of any level; everything before it belongs to this section.
  const next = after.search(/^\s{0,3}#{1,6}\s+\S/m);
  const section = (next === -1 ? after : after.slice(0, next)).trim();
  return section || undefined;
}

export class LinearClient {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint = "https://api.linear.app/graphql",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Configured from the environment, or absent — Linear is optional, never required. */
  static fromEnv(fetchImpl: typeof fetch = fetch): LinearClient | undefined {
    const key = process.env.LINEAR_API_KEY?.trim();
    if (!key) return undefined;
    return new LinearClient(key, process.env.LINEAR_API_URL || undefined, fetchImpl);
  }

  async getIssue(identifier: string): Promise<LinearIssue | undefined> {
    const query = `query Issue($id: String!) {
      issue(id: $id) { identifier title description url state { name } }
    }`;

    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.apiKey },
      body: JSON.stringify({ query, variables: { id: identifier } }),
    });

    if (!res.ok) {
      // A tracker being unreachable must never fail a code review: the review is still
      // worth posting without the ticket, so this degrades rather than throws.
      logger.warn({ identifier, status: res.status }, "linear issue lookup failed");
      return undefined;
    }

    const json = (await res.json()) as {
      data?: {
        issue?: {
          identifier: string;
          title: string;
          description?: string;
          url?: string;
          state?: { name?: string };
        } | null;
      };
      errors?: { message: string }[];
    };

    if (json.errors?.length) {
      logger.warn(
        { identifier, errors: json.errors.map((e) => e.message) },
        "linear returned errors",
      );
      return undefined;
    }

    const issue = json.data?.issue;
    if (!issue) return undefined;

    return {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      acceptanceCriteria: extractAcceptanceCriteria(issue.description),
      url: issue.url,
      state: issue.state?.name,
    };
  }
}

/**
 * Resolves the issue for a pull request, returning nothing rather than failing.
 *
 * Every failure mode here — no key configured, no issue referenced, an unreachable
 * tracker, a key that belongs to a different workspace — ends with a review that runs
 * without ticket context. That is a worse review, not a broken one.
 */
export async function resolveIssueForPullRequest(
  client: LinearClient | undefined,
  sources: { branch?: string; title?: string; body?: string },
): Promise<LinearIssue | undefined> {
  if (!client) return undefined;

  const keys = extractIssueKeys(sources);
  if (!keys.length) return undefined;

  for (const key of keys) {
    try {
      const issue = await client.getIssue(key);
      if (issue) {
        logger.info({ identifier: issue.identifier }, "linear issue resolved for pull request");
        return issue;
      }
    } catch (err) {
      logger.warn(
        { key, err: err instanceof Error ? err.message : String(err) },
        "linear lookup threw; continuing without issue context",
      );
    }
  }
  return undefined;
}
