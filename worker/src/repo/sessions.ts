/**
 * Sessions data-access layer built on Drizzle.
 *
 * Every query scopes by `userId` (BOLA/IDOR guardrail): a user can only ever
 * touch sessions they own. Drizzle parameterizes all bindings, so no user
 * input reaches SQL as a raw string.
 * @module serverless-worker/repo/sessions
 */

import { and, asc, count, desc, eq } from 'drizzle-orm'
import type { DbClient } from '../db/index.ts'
import { sessions } from '../db/schema.ts'
import type { Message } from '../db/schema.ts'
import { messages } from '../db/schema.ts'

/** A session record as exposed by the API. */
export interface SessionRecord {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly meta: Record<string, unknown>
}

function mapSession(row: typeof sessions.$inferSelect): SessionRecord {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    meta: row.meta as Record<string, unknown>,
  }
}

/** Create a session owned by `userId`. */
export async function createSession(db: DbClient, userId: string, title?: string): Promise<SessionRecord> {
  const rows = await db.insert(sessions).values({ userId, title: title ?? 'New session' }).returning()
  return mapSession(rows[0] as typeof sessions.$inferSelect)
}

/**
 * Fetch a session by id, scoped to the owner. Returns `undefined` when the
 * session does not exist OR belongs to another user (indistinguishable on
 * purpose to avoid leaking existence).
 */
export async function getSession(db: DbClient, userId: string, id: string): Promise<SessionRecord | undefined> {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
    .limit(1)
  const row = rows[0]
  return row === undefined ? undefined : mapSession(row)
}

/** List the user's sessions, newest first. */
export async function listSessions(db: DbClient, userId: string, limit = 50): Promise<SessionRecord[]> {
  const capped = Math.max(1, Math.min(100, limit))
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.createdAt))
    .limit(capped)
  return rows.map(mapSession)
}

/** Rename a session, scoped to the owner. Returns `undefined` if not owned. */
export async function renameSession(db: DbClient, userId: string, id: string, title: string): Promise<SessionRecord | undefined> {
  const rows = await db
    .update(sessions)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
    .returning()
  const row = rows[0]
  return row === undefined ? undefined : mapSession(row)
}

/**
 * Delete a session and (via ON DELETE CASCADE) its messages, scoped to the
 * owner. Returns whether a row was removed.
 */
export async function deleteSession(db: DbClient, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
    .returning({ id: sessions.id })
  return rows.length > 0
}

/** Load the full ordered transcript of an owned session. */
export async function loadSessionMessages(db: DbClient, userId: string, sessionId: string): Promise<Message[]> {
  // Ownership is enforced on the session row; message access derives from it.
  const owned = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .limit(1)
  if (owned.length === 0) return []
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt), asc(messages.id))
  return rows
}
