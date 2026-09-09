/**
 * Flag parsing shared by every command.
 *
 * Both spellings are accepted — `--admin-port 7777` and `--admin-port=7777` — because
 * both are conventional and users type whichever they know. Six commands previously
 * carried their own copy that handled only the space form, and `docker-compose.yml`
 * passes the `=` form: the daemon started, silently ignored `--webhook-port=8080` and
 * `--admin-host=0.0.0.0`, warned that no trigger was configured as though the operator
 * had forgotten one, and bound the admin API to a loopback address unreachable from the
 * published port. The deployment came up and did nothing, with no error naming the cause.
 */
export function arg(argv: string[], name: string): string | undefined {
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);

  const i = argv.indexOf(name);
  if (i < 0) return undefined;

  const next = argv[i + 1];
  // `--admin-port --verbose` is a missing value, not a value of "--verbose".
  return next && !next.startsWith("--") ? next : undefined;
}

/** True when a boolean flag is present in either spelling (`--force` or `--force=true`). */
export function has(argv: string[], name: string): boolean {
  return argv.includes(name) || argv.some((a) => a.startsWith(`${name}=`));
}
