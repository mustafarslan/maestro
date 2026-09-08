import pino from "pino";

const level =
  process.env.MAESTRO_LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info");

export const logger = pino({
  level,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = pino.Logger;

/** Child logger carrying trace correlation ids; every task-scoped log should use one. */
export function taskLogger(fields: {
  reviewId?: string;
  taskId?: string;
  agentId?: string;
  nodeId?: string;
}): Logger {
  return logger.child(fields);
}
