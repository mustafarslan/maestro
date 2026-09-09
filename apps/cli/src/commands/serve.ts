import { openStore } from "@maestro/core";
import { storedGitHubApp } from "@maestro/integrations";
import { startDaemon } from "@maestro/server";
import { arg, numberArg, rejectUnknownFlags } from "../args.js";
import { checkLine, color } from "../ui.js";

/**
 * Where the webhook secret comes from, in order.
 *
 * The manifest flow's App comes with a secret GitHub generated, stored beside the private
 * key. Without the third source `serve` would refuse to start and tell the operator to set
 * a variable they were never shown, about a secret Maestro already had on disk — the
 * "stored and read by nothing" shape the flow itself exists to avoid. Flag and environment
 * still win, so an override is always possible.
 *
 * Exported so the order can be asserted without starting a daemon.
 */
export function resolveWebhookSecret(argv: string[]): string | undefined {
  return (
    arg(argv, "--webhook-secret") ??
    process.env.GITHUB_WEBHOOK_SECRET ??
    storedGitHubApp()?.webhookSecret
  );
}

export async function serve(argv: string[]): Promise<number> {
  rejectUnknownFlags(argv, [
    "--admin-host",
    "--admin-port",
    "--poll",
    "--poll-interval",
    "--webhook-port",
    "--webhook-secret",
    "--workers",
  ]);
  if (argv.includes("--help")) {
    console.log(`
${color.bold("maestro serve")} [options]

  --webhook-port <n>    listen for GitHub webhooks (needs a public URL)
  --webhook-secret <s>  shared secret; deliveries are rejected without a valid signature
  --admin-port <n>      admin API + UI (default 7777, bound to 127.0.0.1)
  --admin-host <h>      override the admin bind address (a token is then required)
  --poll <repos>        comma-separated owner/repo list to poll instead of webhooks
  --poll-interval <s>   seconds between polls (default 60)
  --workers <n>         concurrent reviews (default 3)
`);
    return 0;
  }

  const db = await openStore();
  const pollRepos = (arg(argv, "--poll") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Every numeric flag is validated before anything starts. NaN passes silently into
  // everything downstream and produces a daemon that looks healthy and does nothing.
  let webhookPort: number | undefined;
  let adminPort: number;
  let pollIntervalSec: number;
  let workers: number;
  try {
    webhookPort = numberArg(argv, "--webhook-port", { min: 0, max: 65535 });
    adminPort = numberArg(argv, "--admin-port", { min: 0, max: 65535, fallback: 7777 }) as number;
    pollIntervalSec = numberArg(argv, "--poll-interval", { min: 1, fallback: 60 }) as number;
    workers = numberArg(argv, "--workers", { min: 1, max: 64, fallback: 3 }) as number;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const daemon = await startDaemon({
    db,
    webhookPort,
    webhookSecret: resolveWebhookSecret(argv),
    adminPort,
    adminHost: arg(argv, "--admin-host"),
    adminToken: process.env.MAESTRO_ADMIN_TOKEN,
    poll: pollRepos.length ? { repos: pollRepos, intervalMs: pollIntervalSec * 1000 } : undefined,
    concurrentReviews: workers,
  });

  console.log(color.bold("\nmaestro serve\n"));
  if (daemon.webhookPort) {
    console.log(checkLine("ok", "webhooks", `listening on 0.0.0.0:${daemon.webhookPort}`));
  }
  if (pollRepos.length) {
    console.log(checkLine("ok", "polling", pollRepos.join(", ")));
  }
  if (!daemon.webhookPort && !pollRepos.length) {
    console.log(
      checkLine(
        "warn",
        "triggers",
        "neither --webhook-port nor --poll given; nothing will start a review",
      ),
    );
  }
  // Print the address it is actually bound to. Saying 127.0.0.1 while bound to 0.0.0.0
  // hands someone a URL that works from their machine and not from where they need it.
  const adminHost = arg(argv, "--admin-host");
  const shown = !adminHost || adminHost === "0.0.0.0" ? "127.0.0.1" : adminHost;
  console.log(
    checkLine(
      "ok",
      "admin",
      `http://${shown}:${daemon.adminPort}/?token=${daemon.adminToken}` +
        (adminHost && adminHost !== "127.0.0.1" ? `  (bound to ${adminHost})` : ""),
    ),
  );
  console.log(color.dim("\nctrl-c to stop\n"));

  const shutdown = async (signal: string) => {
    console.log(color.dim(`\n${signal} received, finishing in-flight work...`));
    // A second signal means the operator has stopped waiting. Without this, Ctrl-C twice
    // did nothing the second time and the only way out was SIGKILL.
    process.once(signal as NodeJS.Signals, () => {
      console.log(color.dim("second signal — exiting now"));
      process.exit(130);
    });
    // A stop that hangs must not hold the terminal for ever. Containers left behind are
    // what `maestro reap` and the environments view exist for; an unkillable daemon has
    // no equivalent.
    const forced = setTimeout(() => {
      console.log(color.dim("shutdown timed out after 60s — exiting; run 'maestro reap'"));
      process.exit(1);
    }, 60_000);
    forced.unref();
    try {
      await daemon.stop();
    } catch (err) {
      // Exiting cleanly matters more than the reason, but the reason is worth printing:
      // rejecting here used to be an unhandled rejection, so a failed stop terminated the
      // process with a crash trace instead of the message above.
      console.error(`shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(forced);
      db.close();
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise(() => {});
  return 0;
}
