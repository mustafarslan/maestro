import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FINDING_STATUSES, REVIEW_STATES } from "@maestro/core";
import { describe, expect, it } from "vitest";

/**
 * Every review state must be visually distinguishable in the admin UI.
 *
 * `triaging` and `cancelled` had no rule at all, so they rendered with the bare `.badge`
 * styling: a cancelled review looked like neither finished nor failed, which is the state
 * it most needs to be distinguishable in. Adding a state to the schema and forgetting the
 * colour is silent, so it is asserted rather than remembered.
 *
 * This lives in the server package because it serves the UI and depends on core; the UI
 * package has no core dependency on purpose, being a browser bundle.
 */
const css = readFileSync(join(import.meta.dirname, "../../ui/src/styles.css"), "utf8");

describe("state badges", () => {
  it("gives every review state a colour", () => {
    const missing = REVIEW_STATES.filter((state) => !css.includes(`.badge.${state}`));
    expect(missing, `no .badge rule for: ${missing.join(", ")}`).toEqual([]);
  });

  it("gives every finding status a colour", () => {
    // The per-review rollup renders the disposition as a badge, and none of the five had
    // a rule: accepted, dismissed and suppressed all came out as the bare pill, in the
    // one column whose whole purpose is telling them apart. Same failure as the review
    // states above, found the same way — by rendering something that had never been
    // rendered before.
    const missing = FINDING_STATUSES.filter((s) => !css.includes(`.badge.${s}`));
    expect(missing, `no .badge rule for: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not colour a dismissed finding like an accepted one", () => {
    // The distinction the quality loop is built on. Both existing as rules is not enough
    // if they resolve to the same colour.
    const accepted = /\.badge\.accepted \{([^}]*)\}/.exec(css)?.[1] ?? "";
    const dismissed = /\.badge\.dismissed \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(accepted).not.toBe("");
    expect(dismissed).not.toBe("");
    expect(accepted).not.toBe(dismissed);
  });

  it("does not colour a cancelled review like a running one", () => {
    // Reading as "running" would be worse than having no colour at all.
    const ruleFor = (state: string) => {
      const at = css.indexOf(`.badge.${state}`);
      return css.slice(at, css.indexOf("}", at));
    };
    expect(ruleFor("cancelled")).not.toBe(ruleFor("analyzing"));
    expect(ruleFor("done")).not.toBe(ruleFor("failed"));
  });

  it("colours every severity the comment renderer emits", () => {
    for (const severity of ["critical", "high", "medium", "low", "info"]) {
      expect(css, `no .badge rule for severity ${severity}`).toContain(`.badge.${severity}`);
    }
  });
});
