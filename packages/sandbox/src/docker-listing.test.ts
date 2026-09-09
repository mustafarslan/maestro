import { describe, expect, it } from "vitest";
import { uniqueIds } from "./docker.js";

/**
 * The fixture is real output.
 *
 * `docker images -q --filter label=maestro.managed=true` on a machine with three Maestro
 * snapshots printed these six lines — one per tag, and every snapshot carries two: the
 * review's own and the dependency cache pointing at the same id. Assuming one line meant
 * one image is the kind of thing that reads correctly for ever and is simply not how the
 * tool behaves.
 */
const REAL_OUTPUT = [
  "2257aeed91f9",
  "2257aeed91f9",
  "8ce2353c0453",
  "8ce2353c0453",
  "1dc5059f9003",
  "1dc5059f9003",
  "",
].join("\n");

describe("ids from a docker -q listing", () => {
  it("counts an image tagged twice once", () => {
    // The reaper inspected each of these twice, ran `docker rmi` on each twice, and told
    // the operator it had removed six images when there were three. The second `rmi` fails
    // silently on an id already gone, so nothing broke — the number was just untrue.
    expect(uniqueIds(REAL_OUTPUT)).toEqual(["2257aeed91f9", "8ce2353c0453", "1dc5059f9003"]);
  });

  it("keeps the order the daemon reported", () => {
    // Not sorted: the caller pairs ids with per-image `docker inspect` results, and a
    // reordering would be an easy way to make that correspondence subtly wrong later.
    expect(uniqueIds("b\na\nb\nc")).toEqual(["b", "a", "c"]);
  });

  it("drops blank lines rather than treating them as an id", () => {
    // `docker` ends its output with a newline, so the last split is always empty. An empty
    // id passed to `docker rmi` removes nothing and reports an error per sweep.
    expect(uniqueIds("a\n\n  \nb\n")).toEqual(["a", "b"]);
  });

  it("is empty for no output at all", () => {
    expect(uniqueIds("")).toEqual([]);
    expect(uniqueIds("\n")).toEqual([]);
  });
});
