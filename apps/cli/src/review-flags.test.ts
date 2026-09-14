import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { review } from "./commands/review.js";

describe("maestro review --profile and --no-profile", () => {
  let err: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => err.mockRestore());

  it("refuses both at once rather than silently picking one", async () => {
    // Before any store is opened or container started: a contradiction is an argument error.
    expect(await review([".", "--profile", "octocat", "--no-profile"])).toBe(1);
    expect(err.mock.calls.flat().join("\n")).toMatch(/--profile and --no-profile contradict/);
  });
});
