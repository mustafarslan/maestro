/**
 * The one place the version is written down.
 *
 * It was a literal in `apps/cli/src/index.ts` and nowhere else, which was fine while
 * only `maestro version` printed it. The egress proxy needs it too — it fetches a Linux
 * build of *this* version, and a cached binary from an older one may predate the
 * subcommand it is being asked to run — so a second copy would be a version skew that
 * shows up as `unknown command` inside a container nobody is watching.
 */
/**
 * Bumped to 0.2.0 for the egress proxy: the proxy downloads a Linux build of *this*
 * version, and every v0.1.0 asset predates the `egress-proxy` subcommand it would be
 * asked to run. Pointing the cache at a version whose release cannot answer is a failure
 * that surfaces inside a container nobody is watching.
 */
export const MAESTRO_VERSION = "0.2.0";
