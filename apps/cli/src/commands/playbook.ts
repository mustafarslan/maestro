import { readFileSync, writeFileSync } from "node:fs";
import { openStore } from "@maestro/core";
import { NODE_SPECS, PlaybookStore, parseYaml, safeParsePlaybook, toYaml } from "@maestro/playbook";
import { arg } from "../args.js";
import { checkLine, color } from "../ui.js";

function usage(): number {
  console.log(`
${color.bold("maestro playbook")} <subcommand>

  list                        show every version, newest first
  show [--version <id>]       print the active (or named) playbook as YAML
  export <file>               write the active playbook to a YAML file
  import <file> [--activate]  validate a YAML file and publish it as a new version
  validate <file>             validate without publishing
  activate <version-id>       point the active pointer at an existing version
  nodes                       list the node registry the canvas may draw
`);
  return 1;
}

export async function playbook(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === "help" || sub === "--help") return usage();

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
