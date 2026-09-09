import { runStdioServer } from "@maestro/mcp";

/**
 * stdio MCP server.
 *
 * Nothing may be written to stdout here except the protocol itself — Maestro's logs go
 * to stderr for exactly this reason. A stray console.log corrupts the stream and the
 * client silently disconnects.
 */
export async function mcp(argv: string[]): Promise<number> {
  const dbIndex = argv.indexOf("--db");
  await runStdioServer(dbIndex >= 0 ? argv[dbIndex + 1] : undefined);
  // The transport owns the process lifetime; returning here would close stdin.
  await new Promise(() => {});
  return 0;
}
