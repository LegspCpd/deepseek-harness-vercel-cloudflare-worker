/**
 * Messages data-access layer built on Drizzle.
 *
 * Appends and paginates messages. Because `messages` carries no direct user
 * column, ownership is always asserted through the owning session first
 * (BOLA/IDOR guardrail): a caller must pass `userId` and every entry point
 * verifies the session belongs to that user before touching its rows.
 * @module serverless-worker/repo/messages
 */

import { and, desc, eq, sql } from 'drizzle-orm'
import type { DbClient } from '../db/index.ts'
import { sessions } from '../db/schema.ts'
import type { Message } from '../db/schema.ts'
import { messages } from '../db/schema.ts'

/** The accepted message roles. */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** Validate that a session is owned by `userId`, throwing otherwise. */
async function assertSessionOwned(db: DbClient, userId: string, sessionId: string): Promise<void> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .limit(1)
  if (rows.length === 0) {
    throw new MessageError('session not found or not owned', 'NOT_FOUND')
  }
}

/** A message error with a machine-readable code. */
export class MessageError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'MessageError'
    this.code = code
  }
}

/** Append a message to an owned session. */
export async function appendMessage(
  db: DbClient,
  userId: string,
  sessionId: string,
  role: MessageRole,
  content: unknown,
): Promise<Message> {
  await assertSessionOwned(db, userId, sessionId)
  const rows = await db
    .insert(messages)
    .values({ sessionId, role, content: content as object })
    .returning()
  return rows[0] as Message
}

/** Append multiple messages to an owned session in one batch. */
export async function appendMessages(
  db: DbClient,
  userId: string,
  sessionId: string,
  items: readonly { role: MessageRole; content: unknown }[],
): Promise<Message[]> {
  await assertSessionOwned(db, userId, sessionId)
  const rows = await db
    .insert(messages)
    .values(items.map(item => ({ sessionId, role: item.role, content: item.content as object })))
    .returning()
  return rows
}

/**
 * Fetch messages before an optional cursor using keyset pagination on the
 * monotonic `id`, scoped to an owned session. Newest-first; callers reverse
 * for transcript rendering.
 */
export async function listMessages(
  db: DbClient,
  userId: string,
  sessionId: string,
  before?: string,
  limit = 50,
): Promise<Message[]> {
  await assertSessionOwned(db, userId, sessionId)
  const capped = Math.max(1, Math.min(100, limit))
  if (before === undefined) {
    return db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(capped)
  }
  const numeric = Number(before)
  if (!Number.isSafeInteger(numeric)) {
    throw new MessageError('invalid pagination cursor', 'INVALID_CURSOR')
  }
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), sql`${messages.id} < ${numeric}`))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(capped)
}
