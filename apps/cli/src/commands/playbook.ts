import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { openStore, ReviewStore } from "@maestro/core";
import { NODE_SPECS, PlaybookStore, parseYaml, safeParsePlaybook, toYaml } from "@maestro/playbook";
import { arg, rejectUnknownFlags } from "../args.js";
import { checkLine, color } from "../ui.js";

/**
 * `code` is the process exit status, and it is a parameter because this text is printed
 * for two different reasons. Somebody asking `--help` got what they asked for and must
 * see 0; somebody who typed the command wrong must see 1. Returning 1 for both made
 * `maestro playbook --help && ...` fail in a shell, and a CI step that probes a command
 * with `--help` read the tool as broken. `reap` already returned 0 and the others did
 * not, so the two spellings disagreed with each other as well.
 */
function usage(code = 1): number {
  console.log(`
${color.bold("maestro playbook")} <subcommand>

  list                        show every version, newest first
  show [--version <id>]       print the active (or named) playbook as YAML
  export <file>               write the active playbook to a YAML file
  import <file> [--activate]  validate a YAML file and publish it as a new version
  validate <file>             validate without publishing
  activate <version-id>       point the active pointer at an existing version
  assign <owner/repo> <name>  use a named playbook for one repository
  assign <owner/repo> --default
                              go back to the global default for that repository
  assignments                 show which repositories have their own playbook
  nodes                       list the node registry the canvas may draw
`);
  return code;
}

export async function playbook(argv: string[]): Promise<number> {
  rejectUnknownFlags(argv, ["--version", "--activate", "--default"]);
  const sub = argv[0];
  if (sub === "help" || sub === "--help" || sub === "-h") return usage(0);
  if (!sub) return usage();

  const db = await openStore();
  const store = new PlaybookStore(db);
  try {
    switch (sub) {
      case "list": {
        const versions = store.listVersions();
        if (!versions.length) {
          console.log("no playbooks yet - run 'maestro init'");
          return 1;
        }
        const active = store.getActive();
        console.log(color.bold("\nplaybook versions\n"));
        for (const v of versions) {
          const mark = v.id === active?.id ? color.green("* ") : "  ";
          console.log(
            `${mark}v${String(v.version).padEnd(3)} ${color.dim(v.id)}  ${v.createdAt}  ${v.notes ?? ""}`,
          );
        }
        console.log();
        return 0;
      }

      case "show": {
        const version = arg(argv, "--version");
        const record = version ? store.getVersion(version) : store.getActive();
        if (!record) {
          console.error("no such playbook version");
          return 1;
        }
        console.log(toYaml(record.doc));
        return 0;
      }

      case "export": {
        const file = argv[1];
        if (!file) return usage();
        const record = store.getActive();
        if (!record) {
          console.error("no active playbook - run 'maestro init'");
          return 1;
        }
        writeFileSync(file, toYaml(record.doc), "utf8");
        console.log(checkLine("ok", "exported", `v${record.version} -> ${file}`));
        return 0;
      }

      case "validate":
      case "import": {
        const file = argv[1];
        if (!file) return usage();
        // Parse without validating, so we can report every issue at once instead of
        // surfacing whichever one happened to throw first.
        // A missing file is the commonest way this is typed wrong, and the raw
        // `ENOENT: no such file or directory, open '…'` was the one error in this
        // command that did not read like a sentence.
        if (!existsSync(file)) {
          console.log(checkLine("fail", "no such file", file));
          return 1;
        }
        const result = safeParsePlaybook(parseYaml(readFileSync(file, "utf8")));
        if (!result.ok) {
          console.log(color.bold(`\n${result.issues.length} issue(s) in ${file}\n`));
          for (const i of result.issues) console.log(checkLine("fail", i.code, i.message));
          console.log();
          return 1;
        }
        if (sub === "validate") {
          console.log(
            checkLine(
              "ok",
              "valid",
              `${result.doc.agents.length} agents, ${result.doc.graph.nodes.length} nodes`,
            ),
          );
          return 0;
        }
        const record = store.publish(result.doc, {
          notes: `imported from ${file}`,
          activate: argv.includes("--activate"),
        });
        console.log(
          checkLine(
            "ok",
            "published",
            `v${record.version} ${record.id}${argv.includes("--activate") ? " (active)" : ""}`,
          ),
        );
        return 0;
      }

      case "activate": {
        const id = argv[1];
        if (!id) return usage();
        store.activate(id);
        console.log(checkLine("ok", "activated", id));
        return 0;
      }

      // `repos.playbook_id` has been in the schema and read by the daemon from the start,
      // and nothing could write it — so a mobile repo and a backend repo wanting
      // different personas, the reason the column exists, was not reachable. It is also
      // the only way one repository reviews only on request while another reviews every
      // push, since `router.automaticTriggers` lives in the playbook.
      case "assign": {
        const slug = argv[1];
        const name = argv[2];
        const [owner, repo] = (slug ?? "").split("/");
        if (!owner || !repo || (!name && !argv.includes("--default"))) return usage();

        const reviews = new ReviewStore(db);
        const repoId = reviews.ensureRepo(owner, repo);
        if (argv.includes("--default")) {
          store.assignToRepo(repoId, null);
          console.log(checkLine("ok", slug as string, "follows the global default playbook"));
          return 0;
        }
        if (!store.assignToRepo(repoId, name as string)) {
          console.log(checkLine("fail", "no such playbook", name as string));
          return 1;
        }
        console.log(checkLine("ok", slug as string, `uses playbook '${name}'`));
        return 0;
      }

      case "assignments": {
        const rows = db
          .prepare(
            `SELECT r.owner || '/' || r.name AS slug, p.name AS playbook
               FROM repos r LEFT JOIN playbooks p ON p.id = r.playbook_id
              ORDER BY slug`,
          )
          .all<{ slug: string; playbook: string | null }>();
        console.log(color.bold("\nplaybook assignments\n"));
        if (!rows.length) console.log(color.dim("  no repositories yet"));
        for (const r of rows) {
          console.log(
            checkLine(
              r.playbook ? "ok" : "info",
              r.slug,
              r.playbook ? `playbook '${r.playbook}'` : "global default",
            ),
          );
        }
        return 0;
      }

      case "nodes": {
        console.log(color.bold("\nnode registry\n"));
        for (const spec of Object.values(NODE_SPECS)) {
          const ports = `${spec.inputs.join("+") || "-"} -> ${spec.outputs.join("+") || "-"}`;
          console.log(
            `  ${color.cyan(spec.kind.padEnd(12))} ${ports.padEnd(34)} ${spec.pinned ? color.yellow("pinned") : ""}`,
          );
          console.log(`  ${color.dim(spec.description)}\n`);
        }
        console.log(
          color.dim(
            "  teardown is not a node: it is a guaranteed finalizer, so no graph can leak containers.\n",
          ),
        );
        return 0;
      }

      default:
        return usage();
    }
  } finally {
    db.close();
  }
}
