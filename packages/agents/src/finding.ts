// Severity lives in `core`: two of its copies were in SQL, in packages that cannot import
// from here. Re-exported so every existing import of `@maestro/agents` still works.
import { SEVERITIES } from "@maestro/core";
import { z } from "zod";

export {
  bySeverity,
  SEVERITIES,
  type Severity,
  severityAtLeast,
  severityRank,
} from "@maestro/core";

/**
 * The one output shape every agent produces, regardless of speciality or provider.
 *
 * Fixing this schema is what lets triage stay generic: it can dedupe and rank findings
 * from a "performance" agent a user invented this morning without knowing anything
 * about it.
 */
export const FindingSchema = z.object({
  file: z.string().optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  category: z.string().min(1).max(64),
  severity: z.enum(SEVERITIES),
  confidence: z.number().min(0).max(1),
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  evidence: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const SubmitFindingsSchema = z.object({
  summary: z.string().optional(),
  findings: z.array(FindingSchema).max(100),
});
export type SubmitFindings = z.infer<typeof SubmitFindingsSchema>;

/** JSON Schema handed to the model. Kept in sync with the zod schema by the test suite. */
export const SUBMIT_FINDINGS_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One or two sentences on what this change does." },
    findings: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          file: { type: "string", description: "Repo-relative path. Omit for a whole-PR point." },
          lineStart: { type: "integer", minimum: 1 },
          lineEnd: { type: "integer", minimum: 1 },
          category: { type: "string", description: "Short kebab-case slug, e.g. 'sql-injection'." },
          severity: { type: "string", enum: [...SEVERITIES] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          title: { type: "string", description: "One specific line, under 80 characters." },
          body: {
            type: "string",
            description:
              "At most three short sentences, under 300 characters: what is wrong, why it matters, the fix.",
          },
          evidence: {
            type: "string",
            description: "The shortest code excerpt or command output line that proves it.",
          },
        },
        required: ["category", "severity", "confidence", "title", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;
