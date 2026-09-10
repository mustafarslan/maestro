import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UI_ASSETS } from "./ui-assets.generated.js";

/**
 * The admin UI is base64'd into the binary by scripts/embed-ui.mjs. Nothing else checks
 * it, and the failure mode is silent: a partial map serves an index.html whose script
 * tag 404s, so the page loads blank with no server-side error at all.
 */
describe("the embedded admin UI", () => {
  const index = UI_ASSETS["/index.html"];

  it("embeds an index.html", () => {
    expect(index, "no /index.html in the embedded asset map").toBeDefined();
  });

  it("embeds every asset that index.html references", () => {
    // Vite fingerprints filenames, so a stale or partial embed produces references to
    // assets that are simply absent — and the page renders as a blank white screen.
    const html = Buffer.from(index!.body, "base64").toString("utf8");
    const referenced = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!);

    expect(referenced.length, "index.html references no assets at all").toBeGreaterThan(0);
    const missing = referenced.filter((path) => !UI_ASSETS[path]);
    expect(missing, `index.html references assets that are not embedded: ${missing}`).toEqual([]);
  });

  it("gives every asset a content type and a non-empty body", () => {
    for (const [path, asset] of Object.entries(UI_ASSETS)) {
      expect(asset.mime, `${path} has no mime type`).toMatch(/\w+\/\w+/);
      expect(asset.body.length, `${path} is empty`).toBeGreaterThan(0);
    }
  });

  it("still contains the JavaScript bundle, not just the shell", () => {
    // An index.html with no bundle would satisfy the checks above and serve nothing.
    const scripts = Object.keys(UI_ASSETS).filter((p) => p.endsWith(".js"));
    expect(scripts.length, "no JavaScript embedded").toBeGreaterThan(0);
  });
});

describe("the generated file is a pure function of the assets", () => {
  it("exports nothing but the asset map", async () => {
    // It used to also emit `UI_BUILT_AT = <now>`, which nothing read: one definition, one
    // writer, zero consumers. Its only effect was that any local build dirtied a checked-in
    // generated file even when every embedded asset was byte-identical — so `git status`
    // permanently showed a modified file that meant nothing, which is exactly where a real
    // change hides. Anything non-deterministic added here trips this.
    const generated = await import("./ui-assets.generated.js");
    expect(Object.keys(generated)).toEqual(["UI_ASSETS"]);
  });

  it("has no timestamp outside the encoded asset bodies", () => {
    // The bodies are base64 and may legitimately contain anything, so this checks the
    // generated source with them removed rather than the file as a whole.
    const source = readFileSync(new URL("./ui-assets.generated.ts", import.meta.url), "utf8");
    const withoutBodies = source.replace(/body: "[^"]*"/g, 'body: ""');
    expect(withoutBodies).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
