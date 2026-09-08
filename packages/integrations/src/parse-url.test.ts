import { describe, expect, it } from "vitest";
import { parsePullRequestRef } from "./parse-url.js";

describe("parsePullRequestRef", () => {
  it("parses a github.com pull request URL", () => {
    expect(parsePullRequestRef("https://github.com/acme/web/pull/412")).toEqual({
      owner: "acme",
      repo: "web",
      number: 412,
    });
  });

  it("parses a GitHub Enterprise URL", () => {
    expect(parsePullRequestRef("https://git.corp.example.com/acme/web/pull/7")).toMatchObject({
      owner: "acme",
      repo: "web",
      number: 7,
    });
  });

  it("parses the owner/repo#number shorthand", () => {
    expect(parsePullRequestRef("acme/web#9")).toEqual({ owner: "acme", repo: "web", number: 9 });
  });

  it("ignores a trailing path such as /files", () => {
    expect(parsePullRequestRef("https://github.com/acme/web/pull/412/files")?.number).toBe(412);
  });

  it("returns null for a local path so it can be treated as a directory", () => {
    for (const input of ["./my-repo", "/Users/me/code/app", "acme/web", "not a url"]) {
      expect(parsePullRequestRef(input), input).toBeNull();
    }
  });
});
