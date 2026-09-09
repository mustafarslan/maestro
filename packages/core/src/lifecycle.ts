/**
 * The states environments and tasks are actually put into.
 *
 * The schema's comments describe richer lifecycles than the code enacts. `environments`
 * says `creating|ready|running|destroying|destroyed|leaked` and only three of those are
 * ever written; `tasks` says `pending|ready|running|done|failed|skipped|cancelled` and only
 * four are. The unwritten ones are not harmless: `recoverStaleReviews` filters tasks on
 * `state IN ('pending','ready','running')`, two-thirds of which can never match, and the
 * admin UI keeps its own hand-written set of "live" environment states enumerating three
 * that never occur — so anyone reading either would believe in a lifecycle that does not
 * exist.
 *
 * Listed here as what the system does, not what it was once imagined doing. The migration
 * is left alone: it is applied history, and rewriting its comments would not change any
 * database that already exists.
 */

/** Written by the recorder when a sandbox is created, and when it is torn down. */
export const ENVIRONMENT_STATES = ["running", "destroyed", "leaked"] as const;
export type EnvironmentState = (typeof ENVIRONMENT_STATES)[number];

/** Still holding a container. Derived, and pinned in the tests so a new state is a choice. */
export const LIVE_ENVIRONMENT_STATES = ENVIRONMENT_STATES.filter(
  (s) => s !== "destroyed" && s !== "leaked",
);

/** Written by the engine as a node runs, finishes, fails or is skipped by the router. */
export const TASK_STATES = ["running", "done", "failed", "skipped"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * A task that a crash would leave stranded.
 *
 * Only `running`: a task that is done, failed or skipped has already reached its end.
 * `recoverStaleReviews` used to also name `pending` and `ready`, which nothing writes.
 */
export const ACTIVE_TASK_STATES = TASK_STATES.filter(
  (s) => s !== "done" && s !== "failed" && s !== "skipped",
);
