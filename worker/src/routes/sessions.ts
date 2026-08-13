/**
 * Sessions and message-history routes.
 *
 * Every handler resolves the owning `userId` from auth and passes it to the
 * repo layer, which scopes every query by that id (BOLA/IDOR guardrail). A
 * request for another user's session is indistinguishable from "not found".
 * @module serverless-worker/routes/sessions
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { DbProvider } from '../db/index.ts'
import { currentUserId } from '../auth/middleware.ts'
import type { AppEnv } from '../auth/middleware.ts'
import { createSession, deleteSession, getSession, listSessions, loadSessionMessages, renameSession } from '../repo/sessions.ts'
import { listMessages } from '../repo/messages.ts'
import { createSessionSchema, historyRequestSchema } from '../validate.ts'

const sessionIdParam = z.object({ id: z.string().uuid() })

/** Build the sessions sub-app. */
export function sessionRoutes(dbProvider: DbProvider): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/', async c => {
    const db = dbProvider.get()
    const userId = currentUserId(c)
    const sessions = await listSessions(db, userId, 50)
    return c.json({ sessions })
  })

  app.post('/', zValidator('json', createSessionSchema), async c => {
    const db = dbProvider.get()
    const userId = currentUserId(c)
    const body = c.req.valid('json')
    const session = await createSession(db, userId, body.title)
    return c.json({ session }, 201)
  })

  app.get('/:id', zValidator('param', sessionIdParam), async c => {
    const db = dbProvider.get()
    const userId = currentUserId(c)
    const session = await getSession(db, userId, c.req.valid('param').id)
    if (session === undefined) return c.json({ error: { code: 'NOT_FOUND', message: 'session not found' } }, 404)
    return c.json({ session })
  })

  app.patch('/:id', zValidator('param', sessionIdParam), zValidator('json', z.object({ title: z.string().max(200) })), async c => {
    const db = dbProvider.get()
    const userId = currentUserId(c)
    const session = await renameSession(db, userId, c.req.valid('param').id, c.req.valid('json').title)
    if (session === undefined) return c.json({ error: { code: 'NOT_FOUND', message: 'session not found' } }, 404)
    return c.json({ session })
  })

  app.delete('/:id', zValidator('param', sessionIdParam), async c => {
    const db = dbProvider.get()
    const userId = currentUserId(c)
    const deleted = await deleteSession(db, userId, c.req.valid('param').id)
    if (!deleted) return c.json({ error: { code: 'NOT_FOUND', message: 'session not found' } }, 404)
    return c.json({ ok: true })
  })

  app.get('/:id/messages', zValidator('param', sessionIdParam), async c => {
    const db = dbProvider.get()
    const userId = currentUserId(c)
    const id = c.req.valid('param').id
    const session = await getSession(db, userId, id)
    if (session === undefined) return c.json({ error: { code: 'NOT_FOUND', message: 'session not found' } }, 404)
    const messages = await loadSessionMessages(db, userId, id)
    return c.json({ messages })
  })

  app.get('/history', zValidator('query', historyRequestSchema), async c => {
    const db = dbProvider.get()
    const userId = currentUserId(c)
    const query = c.req.valid('query')
    const messages = await listMessages(db, userId, query.sessionId, query.before, query.limit)
    return c.json({ messages })
  })

  return app
}
