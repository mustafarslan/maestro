import { parse, stringify } from "yaml";
import type { PlaybookDocument } from "./schema.js";
import { parsePlaybook } from "./validate.js";

/** YAML is the interchange format so a playbook can live in git and be reviewed itself. */
export function toYaml(doc: PlaybookDocument): string {
  return stringify(doc, { lineWidth: 100, blockQuote: "literal" });
}

/** Raw parse with no validation — callers that want structured issues pass this to
 *  safeParsePlaybook rather than catching a throw. */
export function parseYaml(text: string): unknown {
  return parse(text);
}

export function fromYaml(text: string): PlaybookDocument {
  return parsePlaybook(parse(text));
}
