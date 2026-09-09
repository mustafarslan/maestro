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
