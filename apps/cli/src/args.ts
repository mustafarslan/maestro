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

/**
 * A numeric flag, or a thrown error naming what was wrong.
 *
 * `Number("abc")` is NaN, and NaN passes silently into everything downstream. Measured:
 * `--workers abc` made `for (let i = 0; i < NaN; i++)` run zero times, so the daemon
 * started, printed a healthy banner, and never reviewed anything; `--poll-interval abc`
 * became `setInterval(fn, NaN)`, which the spec coerces to 1ms — a tight loop against
 * the GitHub API. Both are worse than a crash, because both look like they are working.
 */
export function numberArg(
  argv: string[],
  name: string,
  opts: { min?: number; max?: number; fallback?: number } = {},
): number | undefined {
  const raw = arg(argv, name);
  if (raw === undefined || raw === "") return opts.fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got '${raw}'`);
  if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number, got '${raw}'`);
  if (opts.min !== undefined && value < opts.min) {
    throw new Error(`${name} must be at least ${opts.min}, got ${value}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new Error(`${name} must be at most ${opts.max}, got ${value}`);
  }
  return value;
}
