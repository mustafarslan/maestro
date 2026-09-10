/**
 * A tiny in-memory session store, used by the example server.
 */
export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

/** Creates a session that lasts a week. */
export function createSession(userId: string): Session {
  const id = Math.random().toString(36).slice(2);
  const session = { id, userId, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  sessions.set(id, session);
  return session;
}

/** Looks a session up by id. */
export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

/** Removes every session belonging to a user. */
export function revokeUser(userId: string): number {
  let removed = 0;
  for (const [id, s] of sessions) {
    if (s.userId === userId) {
      sessions.delete(id);
      removed++;
    }
  }
  return removed;
}
