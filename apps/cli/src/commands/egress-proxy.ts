import { PROXY_LOG_PATH, serveEgressProxy } from "@maestro/sandbox";
import { arg, numberArg, rejectUnknownFlags, wantsHelp } from "../args.js";
import { color } from "../ui.js";

/**
 * The allowlist proxy, as a foreground process.
 *
 * Not a command anybody types. It is the entrypoint of the per-review proxy container:
 * the daemon copies this same binary into a stock Debian image and runs this subcommand,
 * which is what makes the prepare-phase allowlist enforcement rather than a convention.
 * Documented in help anyway, because a process visible in `docker ps` that no
 * documentation mentions is worse than one line of help.
 */
function printUsage(): void {
  console.log(`
${color.bold("maestro egress-proxy")} --allowlist <hosts> [--port <n>]

  --allowlist <hosts>   comma-separated hosts that may be reached
  --port <n>            port to bind on every interface (default 8080)

Runs the prepare-phase egress allowlist as a proxy. Maestro starts this inside a
container of its own, attached to the review's --internal network, so the sandbox
has no route to the internet except through it. Binding every interface is correct
here and only here: the container's network IS the boundary.

Writes its aggregated log to ${PROXY_LOG_PATH}, which the daemon copies out.
`);
}

export async function egressProxy(argv: string[]): Promise<number> {
  if (wantsHelp(argv)) {
    printUsage();
    return 0;
  }
  rejectUnknownFlags(argv, ["--allowlist", "--port"]);

  const raw = arg(argv, "--allowlist");
  // An empty allowlist would refuse everything, which looks like enforcement working and
  // is actually a missing argument. Refuse to start rather than fail every install with
  // a 403 that names the wrong cause.
  if (!raw?.trim()) {
    console.error(color.red("maestro egress-proxy: --allowlist is required and must not be empty"));
    return 2;
  }
  const allowlist = raw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (allowlist.length === 0) {
    console.error(color.red("maestro egress-proxy: --allowlist contained no hosts"));
    return 2;
  }

  const port = numberArg(argv, "--port", { min: 1, max: 65535, fallback: 8080 }) ?? 8080;

  await serveEgressProxy({ allowlist, port });
  return 0;
}
