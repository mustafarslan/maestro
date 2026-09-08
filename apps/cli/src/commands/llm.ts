import { openStore } from "@maestro/core";
import {
  knownModels,
  ModelCatalog,
  ProviderConfigStore,
  type ProviderKind,
  resolveApiKey,
  runConformance,
  secretStore,
} from "@maestro/llm";
import { checkLine, color } from "../ui.js";

function usage(): number {
  console.log(`
${color.bold("maestro llm")} <subcommand>

  providers                   list configured providers and credential status
  models [--provider <id>]    fetch and cache each provider's live model list
  test [--provider <id>] [--model <id>]
                              run the conformance suite (tool call, multi-turn loop,
                              usage accounting, error mapping) against real providers
  key set <provider>          store an API key in the OS keychain (reads stdin)
  key rm <provider>
  add <id> --kind <kind> [--base-url <url>]
                              register another provider instance (e.g. a vLLM server)
`);
  return 1;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function llm(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === "help" || sub === "--help") return usage();

  const db = await openStore();
  const store = new ProviderConfigStore(db);
  store.ensureDefaults();

  try {
    switch (sub) {
      case "providers": {
        console.log(color.bold("\nproviders\n"));
        for (const p of store.list()) {
          const key = await resolveApiKey(p.id, p.kind);
          const local = p.kind === "openai-compatible";
          const ready = local || Boolean(key);
          console.log(
            checkLine(
              ready ? "ok" : "warn",
              p.id.padEnd(16),
              `${p.kind}${p.baseUrl ? ` ${p.baseUrl}` : ""}${
                ready
                  ? local
                    ? " (no key needed)"
                    : " key found"
                  : " no credential - run 'maestro llm key set'"
              }`,
            ),
          );
        }
        console.log(`\n${color.dim(`secrets backend: ${(await secretStore()).backend}`)}\n`);
        return 0;
      }

      case "models": {
        const registry = await store.buildRegistry();
        const catalog = new ModelCatalog(db);
        const only = arg(argv, "--provider");
        let any = false;

        console.log(color.bold("\nmodel catalog\n"));
        for (const p of store.list()) {
          if (only && p.id !== only) continue;
          const provider = registry.get(p.id);
          if (!provider) {
            console.log(checkLine("warn", p.id, "not available (no credential)"));
            continue;
          }
          try {
            const models = await provider.listModels();
            catalog.save(p.id, p.kind, models);
            any = true;
            console.log(checkLine("ok", p.id, `${models.length} model(s)`));
            for (const m of models.slice(0, 12)) {
              const caps = [
                m.capabilities.tools ? "tools" : "",
                m.capabilities.thinking ? "thinking" : "",
              ]
                .filter(Boolean)
                .join(",");
              console.log(`      ${m.id}${caps ? color.dim(`  [${caps}]`) : ""}`);
            }
            if (models.length > 12) console.log(color.dim(`      ... ${models.length - 12} more`));
          } catch (err) {
            console.log(checkLine("fail", p.id, err instanceof Error ? err.message : String(err)));
          }
        }
        console.log();
        return any ? 0 : 1;
      }

      case "test": {
        const registry = await store.buildRegistry();
        const only = arg(argv, "--provider");
        const modelOverride = arg(argv, "--model");
        const reports = [];

        console.log(color.bold("\nprovider conformance\n"));
        for (const p of store.list()) {
          if (only && p.id !== only) continue;
          const provider = registry.get(p.id);
          if (!provider) {
            console.log(checkLine("warn", p.id, "skipped - no credential configured"));
            continue;
          }
          // Local servers have no default model, so one must be named explicitly.
          const model = modelOverride ?? knownModels(p.kind)[0];
          if (!model) {
            console.log(
              checkLine("warn", p.id, "skipped - pass --model (no default for this kind)"),
            );
            continue;
          }

          console.log(`  ${color.cyan(p.id)} ${color.dim(model)}`);
          const report = await runConformance(provider, model);
          reports.push(report);
          for (const c of report.checks) {
            console.log(
              checkLine(c.passed ? "ok" : "fail", `  ${c.name}`, `${c.detail} (${c.durationMs}ms)`),
            );
          }
          // A model that silently ignores tools still "passes" overall, because
          // text-only work is valid - but binding a review agent to it would fail
          // at run time, so say so loudly here.
          const toolNote =
            report.observed.tools === false
              ? color.yellow("  tools: UNSUPPORTED - unusable for review agents")
              : "";
          console.log(
            `    ${report.passed ? color.green("passed") : color.red("failed")}${toolNote}` +
              color.dim(`  cost ~${report.costCents.toFixed(3)}c\n`),
          );
        }

        if (!reports.length) {
          console.log(
            color.yellow("\nno providers could be tested - configure a key or a local server\n"),
          );
          return 1;
        }
        const failed = reports.filter((r) => !r.passed).length;
        console.log(
          failed
            ? color.red(`${failed} provider(s) failed\n`)
            : color.green("all providers conform\n"),
        );
        return failed ? 1 : 0;
      }

      case "key": {
        const action = argv[1];
        const providerId = argv[2];
        if (!action || !providerId) return usage();
        const secrets = await secretStore();

        if (action === "rm") {
          await secrets.delete(providerId);
          console.log(checkLine("ok", "removed", `${providerId} (${secrets.backend})`));
          return 0;
        }
        if (action !== "set") return usage();

        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
        const key = Buffer.concat(chunks).toString("utf8").trim();
        if (!key) {
          console.error("no key on stdin - pipe it: echo $KEY | maestro llm key set anthropic");
          return 1;
        }
        await secrets.set(providerId, key);
        console.log(checkLine("ok", "stored", `${providerId} in ${secrets.backend}`));
        return 0;
      }

      case "add": {
        const id = argv[1];
        const kind = arg(argv, "--kind") as ProviderKind | undefined;
        if (!id || !kind) return usage();
        store.upsert({ id, kind, baseUrl: arg(argv, "--base-url"), enabled: true });
        console.log(checkLine("ok", "registered", `${id} (${kind})`));
        return 0;
      }

      default:
        return usage();
    }
  } finally {
    db.close();
  }
}
