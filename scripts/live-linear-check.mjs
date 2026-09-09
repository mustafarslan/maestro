#!/usr/bin/env node
/**
 * Validates Maestro's Linear query against the real schema — with no API key.
 *
 * Linear runs GraphQL schema validation before authentication: a query naming a field
 * that does not exist comes back `GRAPHQL_VALIDATION_FAILED`, while a well-formed one gets
 * as far as "Authentication required". So "the query shape is unverified against the real
 * endpoint" — a standing entry in STATUS — is answerable without credentials, and stays
 * answerable, which is what makes schema drift something that can be caught rather than
 * discovered by a user.
 *
 *   pnpm build && node scripts/live-linear-check.mjs
 */
import { ISSUE_QUERY, VIEWER_QUERY } from "../packages/integrations/dist/index.js";

const ENDPOINT = process.env.LINEAR_API_URL || "https://api.linear.app/graphql";

const post = async (query) => {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "shape-check-no-key" },
    body: JSON.stringify({ query, variables: { id: "ENG-1" } }),
  });
  return res.json();
};

const codeOf = (body) => body?.errors?.[0]?.extensions?.code ?? "(none)";

console.log(`\nlinear query shape — ${ENDPOINT}\n`);

// The control comes first. Without proving the endpoint *does* reject a bad shape, "no
// validation error" would be indistinguishable from "validation never ran", and the whole
// check would pass for the wrong reason.
const control = await post(`query Issue($id: String!) { issue(id: $id) { notARealField } }`);
if (codeOf(control) !== "GRAPHQL_VALIDATION_FAILED") {
  console.log(
    `  FAIL control: expected a validation error for a bogus field, got ${codeOf(control)}`,
  );
  console.log("  Without it this check proves nothing, so it stops here.\n");
  process.exit(1);
}
console.log("  ok   control: the endpoint rejects a field that does not exist");

let failed = 0;
for (const [name, query] of [
  ["issue lookup", ISSUE_QUERY],
  // `doctor` calls this one to prove a configured key actually works, so its shape
  // matters as much as the lookup's.
  ["viewer (doctor's credential check)", VIEWER_QUERY],
]) {
  const res = await post(query);
  const code = codeOf(res);
  if (code === "GRAPHQL_VALIDATION_FAILED") {
    console.log(`  FAIL ${name}: ${res.errors?.[0]?.message}`);
    failed++;
  } else {
    console.log(`  ok   ${name}: validates against the live schema (stopped at ${code})`);
  }
}
if (failed) {
  console.log("\nLinear's schema has moved.\n");
  process.exit(1);
}
console.log("\nquery shape verified — no API key needed\n");
