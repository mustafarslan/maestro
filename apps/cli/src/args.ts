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

/**
 * Refuses a flag no command accepts.
 *
 * Silently ignoring one is the same failure the `=`-form bug above produced, arriving by
 * a different route: `maestro serve --port 7799 --workers 8` started on the default port
 * with three workers and said nothing, because neither `--port` nor a misspelt
 * `--workers` exists as written. The daemon then behaves differently from what the
 * operator asked for, and the only way to find out is to notice.
 *
 * A bare `--` ends the flags, so anything after it is a positional argument and is left
 * alone.
 */
export function rejectUnknownFlags(argv: string[], known: readonly string[]): void {
  const accepted = new Set<string>([...known, "--help", "-h"]);
  for (const token of argv) {
    if (token === "--") break;
    if (!token.startsWith("--")) continue;
    const name = token.split("=")[0] as string;
    if (accepted.has(name)) continue;

    // A near miss is almost always a typo, and naming the intended flag is the whole
    // difference between a useful error and a list to read.
    const suggestion = [...accepted].find(
      (f) =>
        f.length > 3 && (f.startsWith(name) || name.startsWith(f) || editDistance(f, name) <= 2),
    );
    throw new Error(
      `unknown option '${name}'${suggestion ? `; did you mean '${suggestion}'?` : ""}\n` +
        `accepted here: ${[...accepted].sort().join(", ")}`,
    );
  }
}

/** Small enough that a full matrix is cheaper than being clever. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = rows[i] as number[];
      const previous = rows[i - 1] as number[];
      row[j] = Math.min(
        (previous[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return (rows[a.length] as number[])[b.length] as number;
}

/**
 * Whether the arguments are a request for help.
 *
 * One spelling of the question, because there were several and they disagreed.
 * `rejectUnknownFlags` lists `-h` among the options it accepts — so `-h` passes the
 * guard — while `reap` and `serve` tested only for `--help`. `maestro reap -h` therefore
 * ran the destructive sweep, and the error message had promised the flag was understood.
 * Reported by Maestro reviewing its own commit, and confirmed: it swept, and closed six
 * environment rows on the way.
 *
 * A false guarantee is worse than a missing one, and this is the second time in a day
 * that `rejectUnknownFlags` has produced one by accepting a spelling the command behind
 * it ignores.
 */
export function wantsHelp(argv: string[]): boolean {
  return argv.some((a) => a === "--help" || a === "-h" || a === "help");
}
