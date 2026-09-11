#!/usr/bin/env node
/**
 * Checks that the documentation refers only to things that exist.
 *
 * This project's main claim is that its documents are honest, and it spent a long session
 * finding places where they were not: a README whose install command 404ed, a README and a
 * TODO that contradicted each other about the same feature, a configuration reference
 * listing an environment variable nothing read. Those were all found by hand.
 *
 * This catches the mechanical half — a link, a script, a CLI subcommand or a pnpm task
 * that has been renamed or removed out from under a document — which is how the rest of
 * them start.
 *
 *   node scripts/docs-check.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every non-test source file under a directory, skipping build output. */
function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "dist" || entry === "node_modules") continue;
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.includes(".test.")) {
      out.push(path);
    }
  }
  return out;
}

const docs = ["README.md", "docs/STATUS.md", "docs/TODO.md", "docs/CONFIGURATION.md"];
let bad = 0;
const fail = (m) => {
  console.log(`  FAIL ${m}`);
  bad++;
};

// 1. Every relative link resolves.
for (const doc of docs) {
  const text = readFileSync(doc, "utf8");
  for (const m of text.matchAll(/\[[^\]]+\]\(([^)#]+)\)/g)) {
    const target = m[1];
    if (/^https?:/.test(target)) continue;
    const path = target.startsWith("docs/") || !doc.includes("/") ? target : `docs/${target}`;
    if (!existsSync(path)) fail(`${doc}: link to missing ${target}`);
  }
}

// 2. Every scripts/... path mentioned anywhere exists.
for (const doc of docs) {
  const text = readFileSync(doc, "utf8");
  for (const m of text.matchAll(/scripts\/[\w.-]+/g)) {
    if (!existsSync(m[0])) fail(`${doc}: mentions missing ${m[0]}`);
  }
}

// 3. Every `maestro <sub>` command mentioned is one the CLI knows.
const cliSource = readFileSync("apps/cli/src/index.ts", "utf8");
const known = new Set([...cliSource.matchAll(/case "([\w-]+)":/g)].map((m) => m[1]));
known.add("--version");
known.add("--help");
const mentioned = new Set();
for (const doc of docs) {
  for (const m of readFileSync(doc, "utf8").matchAll(/\bmaestro (--?[\w-]+|[a-z][\w-]*)/g)) {
    mentioned.add(m[1]);
  }
}
for (const cmd of mentioned) {
  if (!known.has(cmd) && !cmd.startsWith("-"))
    fail(`docs mention 'maestro ${cmd}', which the CLI does not accept`);
}

/**
 * The contents of every fenced code block, found by line rather than by regex pair.
 *
 * `matchAll(/```[\s\S]*?```/g)` pairs the first marker with the second, the third with the
 * fourth, and so on — which is correct only if every marker in the file opens or closes a
 * block. `docs/STATUS.md` shows a literal fence as inline code inside a table row, so its
 * marker count was ODD: the regex found no complete pair, returned nothing, and this check
 * silently examined an empty string for the entire life of the file. Adding one real code
 * block to that document made the count even again and paired the inline marker with the
 * new block's opener, sweeping every paragraph in between as though it were code — which is
 * how the silence was finally noticed, four false failures at a time.
 *
 * A fence delimiter is a line whose only content is the marker plus an optional info
 * string. An inline `` ``` `` inside a sentence or a table cell is not one, and cannot
 * become one by being counted.
 */
function fencedBlocks(text) {
  const out = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (/^\s*```[\w-]*\s*$/.test(line)) {
      inside = !inside;
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join("\n");
}

// 4. Every pnpm script mentioned exists in package.json.
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
for (const doc of docs) {
  // Only inside fenced code blocks: prose mentions pnpm in sentences ("which pnpm then
  // refuses"), and matching those made the check report failures that were not real.
  const fenced = fencedBlocks(readFileSync(doc, "utf8"));
  for (const m of fenced.matchAll(/pnpm (?:run )?([\w:]+)/g)) {
    const s = m[1];
    if (["install", "add", "exec", "dlx", "i"].includes(s)) continue;
    if (!pkg.scripts?.[s]) fail(`${doc}: mentions 'pnpm ${s}', not a script in package.json`);
  }
}

// 4b. The same rule for commands printed to a user by the product itself.
//
// The Quality page told people to run `maestro evaluate add`; the command is
// `maestro eval`, and the CLI answers `maestro evaluate` with a usage error. Check 3
// covers the four documents and stopped at their edge, so a wrong command in the admin
// UI — read by exactly the person who is about to type it — went unnoticed.
//
// The first version of this check listed six files and missed `packages/mcp/src/server.ts`,
// which told a model to run `maestro evaluate run <fixture>` — the same wrong command, in
// the surface most likely to be acted on without a person reading it. A hand-kept list of
// places to check is a list that will be short by one. It walks the source now: a command
// the CLI accepts is fine wherever it appears, and one it does not is worth knowing about
// wherever it appears.
{
  // Only formatted mentions — inside a backtick, a single quote or a <code> span. That is
  // how this codebase writes an instruction to somebody, and it separates
  // "run `maestro reap`" from prose like "comment is not a maestro command" or the log
  // line "maestro failed". Every real instruction in the tree is formatted one of those
  // three ways; rewording the prose to suit the check would be the tail wagging the dog.
  // `@maestro review` is a pull request comment, not a command, so it is excluded.
  const instruction = /(?<![@\w])(?<=`|'|<code>)maestro ([a-z][\w-]*)/g;
  const surfaces = sourceFiles("packages").concat(sourceFiles("apps"));
  for (const file of surfaces) {
    for (const m of readFileSync(file, "utf8").matchAll(instruction)) {
      if (!known.has(m[1]))
        fail(`${file}: prints 'maestro ${m[1]}', which the CLI does not accept`);
    }
  }
}

// 5. The documented persona template variables are exactly the ones the code offers.
//
// This table is the one a persona author copies from, and a variable that is documented
// but not offered renders as nothing while the validator refuses the publish — the
// document would be actively instructing somebody into an error. Checked against the
// source rather than a build so it holds before anything is compiled.
{
  const prompt = readFileSync("packages/playbook/src/prompt.ts", "utf8");
  const block = prompt.slice(
    prompt.indexOf("export const TEMPLATE_VARIABLES = ["),
    prompt.indexOf("] as const;"),
  );
  const code = new Set([...block.matchAll(/path:\s*"([\w.]+)"/g)].map((m) => m[1]));
  const doc = new Set(
    [...readFileSync("docs/CONFIGURATION.md", "utf8").matchAll(/\| `\{\{([\w.]+)\}\}` \|/g)].map(
      (m) => m[1],
    ),
  );
  if (!code.size) fail("could not read TEMPLATE_VARIABLES out of packages/playbook/src/prompt.ts");
  for (const v of code) if (!doc.has(v)) fail(`docs/CONFIGURATION.md omits template variable ${v}`);
  for (const v of doc)
    if (!code.has(v)) fail(`docs/CONFIGURATION.md documents ${v}, which does not exist`);
}

console.log(
  bad ? `\n${bad} broken reference(s)` : "\nevery documented link, script, command and task exists",
);
process.exit(bad ? 1 : 0);
