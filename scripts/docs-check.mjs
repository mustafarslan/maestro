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
import { existsSync, readFileSync } from "node:fs";

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

// 4. Every pnpm script mentioned exists in package.json.
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
for (const doc of docs) {
  // Only inside fenced code blocks: prose mentions pnpm in sentences ("which pnpm then
  // refuses"), and matching those made the check report failures that were not real.
  const fenced = [...readFileSync(doc, "utf8").matchAll(/```[\s\S]*?```/g)]
    .map((f) => f[0])
    .join("\n");
  for (const m of fenced.matchAll(/pnpm (?:run )?([\w:]+)/g)) {
    const s = m[1];
    if (["install", "add", "exec", "dlx", "i"].includes(s)) continue;
    if (!pkg.scripts?.[s]) fail(`${doc}: mentions 'pnpm ${s}', not a script in package.json`);
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
