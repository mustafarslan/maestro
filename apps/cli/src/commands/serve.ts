import { openStore } from "@maestro/core";
import { startDaemon } from "@maestro/server";
import { arg } from "../args.js";
import { checkLine, color } from "../ui.js";

export async function serve(argv: string[]): Promise<number> {
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
  const webhookPort = arg(argv, "--webhook-port");

  const daemon = await startDaemon({
    db,
    webhookPort: webhookPort ? Number(webhookPort) : undefined,
    webhookSecret: arg(argv, "--webhook-secret") ?? process.env.GITHUB_WEBHOOK_SECRET,
    adminPort: Number(arg(argv, "--admin-port") ?? 7777),
    adminHost: arg(argv, "--admin-host"),
    adminToken: process.env.MAESTRO_ADMIN_TOKEN,
    poll: pollRepos.length
      ? { repos: pollRepos, intervalMs: Number(arg(argv, "--poll-interval") ?? 60) * 1000 }
      : undefined,
    concurrentReviews: Number(arg(argv, "--workers") ?? 3),
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
  console.log(
    checkLine("ok", "admin", `http://127.0.0.1:${daemon.adminPort}/?token=${daemon.adminToken}`),
  );
  console.log(color.dim("\nctrl-c to stop\n"));

  const shutdown = async (signal: string) => {
    console.log(color.dim(`\n${signal} received, finishing in-flight work...`));
    await daemon.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise(() => {});
  return 0;
}
