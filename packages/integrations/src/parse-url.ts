import type { PullRequestRef } from "./github.js";

/** Accepts a PR URL or `owner/repo#123`; anything else is a local path. */
export function parsePullRequestRef(input: string): PullRequestRef | null {
  const url = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(input);
  if (url) return { owner: url[1] as string, repo: url[2] as string, number: Number(url[3]) };

  const short = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(input);
  if (short)
    return { owner: short[1] as string, repo: short[2] as string, number: Number(short[3]) };

  return null;
}
