import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every recurring job has to state what it costs per hour.
 *
 * Two defects in this session were of one kind, and no other check in this repository
 * looks for it: work that is correct at every scale it would be tested at, and wrong at
 * the scale it actually runs at. The reaction sweep made one GitHub request per posted
 * comment every ten minutes, for ever — 6000 an hour at a thousand comments, against a
 * limit of 5000. The poller made one request per open pull request per tick for a field
 * the listing had already returned — 3060 an hour at fifty pull requests.
 *
 * Neither was a logic error. Unit tests, the mutation sweep and the clean-checkout gate
 * all ask whether code is correct; none asks how often it runs multiplied by how long it
 * runs for. So the question is asked here, the same crude way `wiring.test.ts` asks
 * whether configuration is read: a recurring job is only allowed to exist if somebody has
 * written down what it costs.
 */
const ROOT = join(import.meta.dirname, "../../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * The daemon's recurring work, and the bound on each. Adding a `setInterval` without
 * adding a line here fails this test, which is the point: the cost has to be thought
 * about once, out loud.
 */
const RECURRING = [
  {
    what: "job queue poll",
    bound: "local SQLite only, no external calls",
  },
  {
    what: "lease heartbeat",
    bound: "local SQLite only, one UPDATE per in-flight review per third of a lease",
  },
  {
    what: "reaction sweep",
    bound:
      "capped at 50 comment reads plus 20 pull requests of at most 3 GraphQL pages each per " +
      "sweep, 6 sweeps an hour — 660/hour maximum",
  },
  {
    what: "pull request poller",
    bound:
      "one GitHub request per configured repository per tick, independent of how many pull requests are open",
  },
];

describe("recurring work states its cost", () => {
  it("has a bound recorded for every interval the daemon starts", () => {
    // Crude on purpose. The number of `setInterval` calls is a proxy for the number of
    // recurring jobs, and if that number moves, somebody has to come here and say what
    // the new one costs.
    const daemon = read("packages/server/src/daemon.ts");
    const intervals = daemon.match(/setInterval\(/g)?.length ?? 0;
    expect(
      intervals,
      `packages/server/src/daemon.ts starts ${intervals} recurring job(s) and ${RECURRING.length} are documented in this test. ` +
        "Add the new one with its cost per hour, or remove the stale entry.",
    ).toBe(RECURRING.length);
  });

  it("keeps every external-facing sweep bounded independently of data volume", () => {
    // The two that actually reach GitHub. Both were unbounded and both scaled with
    // something a busy repository has more of, which is the shape that hides.
    const feedback = read("packages/integrations/src/feedback.ts");
    expect(feedback, "the reaction sweep must cap how many comments one pass touches").toMatch(
      /LIMIT \?/,
    );
    expect(feedback).toMatch(/maxComments/);
    // The resolved-thread half rides the same sweep, so it needs its own two bounds: how
    // many pull requests one pass touches, and how far it walks each one's thread list.
    expect(
      feedback,
      "the resolved-thread sweep must cap how many pull requests it asks about",
    ).toMatch(/maxPullRequests/);
    expect(
      read("packages/integrations/src/github.ts"),
      "walking review threads must stop at a page cap, not at the end of the list",
    ).toMatch(/maxPages/);

    const daemon = read("packages/server/src/daemon.ts");
    expect(
      daemon.includes("getPullRequest"),
      "the poller must not fetch each pull request individually: the listing already carries the head sha",
    ).toBe(false);
  });

  it("names a cost for each, not just a description", () => {
    // A bound that does not mention a rate is not a bound.
    for (const job of RECURRING) {
      expect(job.bound, `'${job.what}' has no stated limit`).toMatch(
        /per|maximum|only|independent/,
      );
    }
  });
});
