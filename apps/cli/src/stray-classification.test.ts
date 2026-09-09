import { classifyContainers, type ManagedContainer } from "@maestro/sandbox";
import { describe, expect, it } from "vitest";

/**
 * What makes a container a stray.
 *
 * `doctor` answered this with process state: stopped meant stray, running meant in
 * flight. The first version had it the other way round — every managed container was a
 * stray, so `doctor` told an operator to reap while a review was running, and reaping is
 * what destroys it. The correction over-shot in the other direction, and the case it
 * missed is the commonest one: a killed daemon leaves its containers RUNNING, belonging
 * to no live review, holding memory and a snapshot image. Verified by hand with a
 * labelled container naming a review that does not exist — "no strays (1 in flight)".
 *
 * The question is about the container's review, not its process state. Pinned here in
 * both directions so neither correction can be made again.
 */
const container = (over: Partial<ManagedContainer>): ManagedContainer => ({
  id: "c1",
  running: false,
  ...over,
});

describe("a container is a stray when its review is not", () => {
  it("counts a RUNNING container whose review is gone as a stray", () => {
    const { strays, inFlight } = classifyContainers(
      [container({ reviewId: "rv-gone", running: true })],
      ["rv-live"],
    );
    expect(strays).toHaveLength(1);
    expect(inFlight).toHaveLength(0);
  });

  it("counts a running container of a live review as in flight", () => {
    // The regression the earlier fix was for: reaping this destroys a review in progress.
    const { strays, inFlight } = classifyContainers(
      [container({ reviewId: "rv-live", running: true })],
      ["rv-live"],
    );
    expect(inFlight).toHaveLength(1);
    expect(strays).toHaveLength(0);
  });

  it("counts a stopped container of a live review as in flight", () => {
    // A prepare container that has exited while its review continues in another.
    const { inFlight } = classifyContainers(
      [container({ reviewId: "rv-live", running: false })],
      ["rv-live"],
    );
    expect(inFlight).toHaveLength(1);
  });

  it("counts an unlabelled container as a stray", () => {
    // Nothing claims it, so nothing protects it.
    const { strays } = classifyContainers([container({ running: true })], ["rv-live"]);
    expect(strays).toHaveLength(1);
  });

  it("puts every container on exactly one side", () => {
    // Neither dropped nor double-counted: a container missing from both lists is a leak
    // nothing reports, and one in both makes `doctor` contradict itself in a sentence.
    const managed = [
      container({ id: "a", reviewId: "rv-live", running: true }),
      container({ id: "b", reviewId: "rv-gone", running: true }),
      container({ id: "c", running: false }),
    ];
    const { inFlight, strays } = classifyContainers(managed, ["rv-live"]);
    expect([...inFlight, ...strays].map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
  });
});
