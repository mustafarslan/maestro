import { runStdioServer } from "@maestro/mcp";
import { arg } from "../args.js";

/**
 * stdio MCP server.
 *
 * Nothing may be written to stdout here except the protocol itself — Maestro's logs go
 * to stderr for exactly this reason. A stray console.log corrupts the stream and the
 * client silently disconnects.
 */
export async function mcp(argv: string[]): Promise<number> {
  await runStdioServer(arg(argv, "--db"));
  // The transport owns the process lifetime; returning here would close stdin.
  await new Promise(() => {});
  return 0;
}
