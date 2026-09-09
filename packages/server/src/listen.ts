import type { Server } from "node:http";

/**
 * Binds a server, and turns a bind failure into a sentence.
 *
 * `server.listen(port, host, callback)` reports success through the callback and failure
 * through an `error` EVENT. With no listener on that event, Node treats it as an
 * unhandled error and terminates the process — so a promise wrapping only the callback
 * never settles, the CLI's own error handling never runs, and the operator gets a raw
 * stack trace through Bun's internals with `EADDRINUSE` somewhere in the middle.
 *
 * Measured: starting a second `maestro serve` on a port already in use printed nine lines
 * of `node:_http_server` source and a `$bunfs/root/maestro` frame. The one thing worth
 * saying — another daemon is already there — was in that wall, and every other error this
 * CLI produces is a sentence.
 *
 * A port already in use is the likeliest operational failure a daemon has: a restart
 * before the old process released it, or two instances by accident.
 */
export function listen(server: Server, port: number, host: string, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      reject(explain(err, port, host, what));
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function explain(err: NodeJS.ErrnoException, port: number, host: string, what: string): Error {
  const where = `${host}:${port}`;
  switch (err.code) {
    case "EADDRINUSE":
      return new Error(
        `the ${what} cannot bind ${where}: something is already listening there. ` +
          "Another 'maestro serve' is the usual reason — stop it, or choose another port.",
      );
    case "EACCES":
      return new Error(
        `the ${what} is not permitted to bind ${where}. Ports below 1024 need elevated ` +
          "privileges; use a higher port and put a proxy in front of it.",
      );
    case "EADDRNOTAVAIL":
      return new Error(
        `the ${what} cannot bind ${where}: no interface on this machine has that address.`,
      );
    default:
      return new Error(`the ${what} cannot bind ${where}: ${err.message}`);
  }
}
