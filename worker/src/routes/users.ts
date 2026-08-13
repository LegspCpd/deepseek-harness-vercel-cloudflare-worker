/**
 * Users routes: bootstrap and self-service API-key management.
 *
 * Creating the FIRST user is protected by an `ADMIN_TOKEN` so an unauthenticated
 * stranger cannot register against your engine. Once a user holds an API key,
 * they can read their own profile, rotate their key, or delete their account.
 * @module serverless-worker/routes/users
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import type { DbProvider } from '../db/index.ts'
import { currentUser, currentUserId } from '../auth/middleware.ts'
import type { AppEnv } from '../auth/middleware.ts'
import { createUser, deleteUser, getUser, rotateApiKey } from '../repo/users.ts'
import { createUserSchema } from '../validate.ts'

/** Compare a secret in constant time to avoid timing leaks. */
function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}

/**
 * Unauthenticated bootstrap: `POST /api/users` creates a user + API key.
 * Protected by the `x-admin-token` header so strangers cannot self-register.
 */
export function bootstrapRoutes(dbProvider: DbProvider): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.post('/users', zValidator('json', createUserSchema), async c => {
    const adminToken = c.req.header('x-admin-token')
    const expected = c.env.ADMIN_TOKEN
    if (adminToken === undefined || expected === undefined || !safeEqual(adminToken, expected)) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'admin token required' } }, 401)
    }
    const db = dbProvider.get()
    const body = c.req.valid('json')
    const created = await createUser(db, body.name)
    // The plaintext API key is shown exactly once; it is not retrievable again.
    return c.json({ user: created.user, apiKey: created.apiKey }, 201)
  })
  return app
}

/** Authenticated self-service routes: own profile, key rotation, deletion. */
export function authedUserRoutes(dbProvider: DbProvider): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/users/me', async c => {
    const db = dbProvider.get()
    const user = currentUser(c)
    const fresh = await getUser(db, user.id)
    if (fresh === undefined) return c.json({ error: { code: 'NOT_FOUND', message: 'user not found' } }, 404)
    const { apiKeyHash: _hash, ...safe } = fresh
    return c.json({ user: safe })
  })

  app.post('/users/me/rotate-key', async c => {
    const db = dbProvider.get()
    const userId = currentUserId(c)
    const rotated = await rotateApiKey(db, userId)
    return c.json(rotated)
  })

  app.delete('/users/me', async c => {
    const db = dbProvider.get()
    const userId = currentUserId(c)
    await deleteUser(db, userId)
    return c.json({ ok: true })
  })

  return app
}
