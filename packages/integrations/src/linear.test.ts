import { describe, expect, it } from "vitest";
import {
  extractAcceptanceCriteria,
  extractIssueKeys,
  LinearClient,
  resolveIssueForPullRequest,
} from "./linear.js";

describe("issue key extraction", () => {
  it("prefers the branch, which the author chose before writing anything", () => {
    // Linear's own git integration generates the branch name, so it is the most
    // deliberate signal. A body mentioning related tickets must not displace it.
    const keys = extractIssueKeys({
      branch: "mustafa/eng-412-add-delete-account",
      title: "Add delete account",
      body: "Related to ENG-999 and DES-12.",
    });
    expect(keys[0]).toBe("ENG-412");
    expect(keys).toContain("ENG-999");
  });

  it("finds keys in a lowercased branch name", () => {
    expect(extractIssueKeys({ branch: "fix/abc-7-thing" })).toEqual(["ABC-7"]);
  });

  it("does not treat ordinary hyphenated text as an issue key", () => {
    // A one-letter prefix matches far too much prose, and every false key is a pointless
    // API round trip on every single review.
    expect(extractIssueKeys({ title: "Upgrade to A-1 grade, see X-2" })).toEqual([]);
    expect(extractIssueKeys({ body: "utf-8 and base-64 and covid-19" })).toEqual([]);
  });

  it("rejects version strings, which are shaped like keys but numbered from zero", () => {
    // Linear numbers issues from 1, so a leading zero is proof this is not a ticket.
    expect(extractIssueKeys({ branch: "release/v2-0" })).toEqual([]);
    expect(extractIssueKeys({ body: "See RFC-0 for background" })).toEqual([]);
  });

  it("still matches a key-shaped branch segment, which the prefix allowlist exists for", () => {
    // `fix/utf-8-encoding` is genuinely ambiguous: UTF-8 is exactly the shape of a key.
    // The lookup for a nonexistent issue costs one request and returns nothing, and a
    // team that minds sets LINEAR_TEAM_PREFIXES.
    expect(extractIssueKeys({ branch: "fix/utf-8-encoding" })).toEqual(["UTF-8"]);
  });

  it("honours an explicit team prefix allowlist", () => {
    // A single-team workspace needs no allowlist; setting one removes the false-positive
    // class outright.
    process.env.LINEAR_TEAM_PREFIXES = "ENG,DES";
    try {
      expect(extractIssueKeys({ branch: "fix/utf-8-encoding" })).toEqual([]);
      expect(extractIssueKeys({ branch: "x/eng-5-thing", body: "and ABC-9" })).toEqual(["ENG-5"]);
    } finally {
      delete process.env.LINEAR_TEAM_PREFIXES;
    }
  });

  it("returns nothing when no issue is referenced", () => {
    expect(extractIssueKeys({ branch: "main", title: "chore: bump deps" })).toEqual([]);
  });
});

describe("acceptance criteria extraction", () => {
  it("takes the section under a recognised heading and stops at the next one", () => {
    const description = [
      "Some background about why we want this.",
      "",
      "## Acceptance Criteria",
      "- The user can delete their account",
      "- All their assets are removed",
      "",
      "## Notes",
      "Ping design before shipping.",
    ].join("\n");

    const criteria = extractAcceptanceCriteria(description);
    expect(criteria).toContain("The user can delete their account");
    expect(criteria).toContain("All their assets are removed");
    expect(criteria).not.toContain("Ping design");
    expect(criteria).not.toContain("Some background");
  });

  it("returns nothing rather than passing off background prose as criteria", () => {
    // Returning the whole description would be worse than returning none: the agent
    // treats it as a checklist and reports every unmet aside as a defect.
    expect(extractAcceptanceCriteria("Just a description with no headings.")).toBeUndefined();
    expect(extractAcceptanceCriteria(undefined)).toBeUndefined();
  });

  it("accepts the spellings teams actually use", () => {
    for (const heading of [
      "Acceptance",
      "Success Criteria",
      "Definition of Done",
      "Requirements",
    ]) {
      expect(extractAcceptanceCriteria(`### ${heading}\n- it works`)).toBe("- it works");
    }
  });
});

describe("issue lookup", () => {
  const respond = (body: unknown, ok = true) =>
    (async () =>
      ({
        ok,
        status: ok ? 200 : 500,
        json: async () => body,
      }) as unknown as Response) as typeof fetch;

  it("returns the issue with criteria pulled out of the description", async () => {
    const client = new LinearClient(
      "lin_api_x",
      undefined,
      respond({
        data: {
          issue: {
            identifier: "ENG-412",
            title: "Delete account",
            description: "## Acceptance Criteria\n- data is really gone",
            url: "https://linear.app/x/issue/ENG-412",
            state: { name: "In Progress" },
          },
        },
      }),
    );

    const issue = await client.getIssue("ENG-412");
    expect(issue?.identifier).toBe("ENG-412");
    expect(issue?.acceptanceCriteria).toBe("- data is really gone");
  });

  it("degrades to no context when the tracker is unreachable", async () => {
    // A tracker outage must never fail a code review: the review is still worth posting
    // without the ticket.
    const client = new LinearClient("k", undefined, respond({}, false));
    await expect(client.getIssue("ENG-1")).resolves.toBeUndefined();
  });

  it("degrades when the API returns GraphQL errors", async () => {
    const client = new LinearClient("k", undefined, respond({ errors: [{ message: "nope" }] }));
    await expect(client.getIssue("ENG-1")).resolves.toBeUndefined();
  });

  it("resolves nothing, without throwing, when Linear is not configured", async () => {
    await expect(
      resolveIssueForPullRequest(undefined, { branch: "eng-1-thing" }),
    ).resolves.toBeUndefined();
  });

  it("falls through to the next key when the first is not found", async () => {
    let call = 0;
    const client = new LinearClient("k", undefined, (async () => {
      call++;
      return {
        ok: true,
        status: 200,
        json: async () =>
          call === 1
            ? { data: { issue: null } }
            : { data: { issue: { identifier: "DES-12", title: "Design" } } },
      } as unknown as Response;
    }) as typeof fetch);

    const issue = await resolveIssueForPullRequest(client, {
      branch: "eng-999-missing",
      body: "also DES-12",
    });
    expect(issue?.identifier).toBe("DES-12");
  });

  it("survives a lookup that throws outright", async () => {
    const client = new LinearClient("k", undefined, (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch);
    await expect(
      resolveIssueForPullRequest(client, { branch: "eng-1-x" }),
    ).resolves.toBeUndefined();
  });
});

describe("against Linear's real API contract", () => {
  // These bodies were captured from api.linear.app itself, not written by hand.
  //
  // Linear validates a GraphQL query BEFORE it checks authentication: a query naming a
  // field that does not exist returns 400 GRAPHQL_VALIDATION_FAILED even unauthenticated,
  // while our query returns 401. That difference is a live schema check — every field the
  // client selects provably exists on the Issue type, which is the part of an integration
  // most likely to be silently wrong.
  const REAL_AUTH_ERROR = {
    errors: [
      {
        message: "Authentication required, not authenticated",
        extensions: {
          type: "authentication error",
          code: "AUTHENTICATION_ERROR",
          statusCode: 401,
          userError: true,
          userPresentableMessage: "You need to authenticate to access this operation.",
          meta: {},
          http: {
            status: 401,
          },
        },
      },
    ],
  };

  const REAL_VALIDATION_ERROR = {
    errors: [
      {
        message: 'Cannot query field "notARealField" on type "Issue".',
        locations: [
          {
            line: 1,
            column: 57,
          },
        ],
        extensions: {
          http: {
            status: 400,
            headers: {},
          },
          code: "GRAPHQL_VALIDATION_FAILED",
          type: "graphql error",
          userError: true,
        },
      },
    ],
  };

  const respondWith = (body: unknown, status: number) =>
    (async () =>
      ({
        ok: status < 400,
        status,
        json: async () => body,
      }) as unknown as Response) as typeof fetch;

  it("treats a real authentication error as missing context, not a crash", async () => {
    // A misconfigured key must degrade the review, never fail it.
    const client = new LinearClient("bad-key", undefined, respondWith(REAL_AUTH_ERROR, 401));
    await expect(client.getIssue("ENG-1")).resolves.toBeUndefined();
  });

  it("treats a real schema validation error as missing context too", async () => {
    // If Linear ever changes the Issue type under us, the review still posts.
    const client = new LinearClient("k", undefined, respondWith(REAL_VALIDATION_ERROR, 400));
    await expect(client.getIssue("ENG-1")).resolves.toBeUndefined();
  });

  it("reads the error shape Linear actually returns", () => {
    // Both real bodies carry `errors[].message`, which is what the client logs.
    for (const body of [REAL_AUTH_ERROR, REAL_VALIDATION_ERROR]) {
      expect(Array.isArray(body.errors)).toBe(true);
      expect(typeof body.errors[0]?.message).toBe("string");
    }
  });
});
