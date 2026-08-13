/**
 * Hono middleware for authentication and CORS.
 *
 * `requireUser` parses the `Authorization: Bearer <api_key>` header, looks the
 * key up against the scrypt hash in `users`, and stores the resolved `userId`
 * and `user` on the Hono context. Every protected route runs this middleware
 * so downstream handlers are guaranteed a valid owner identity — the basis for
 * the BOLA/IDOR guardrail.
 * @module serverless-worker/auth/middleware
 */

import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { eq } from 'drizzle-orm'
import type { Env } from '../types/env.ts'
import type { User } from '../db/schema.ts'
import { users } from '../db/schema.ts'
import type { DbProvider } from '../db/index.ts'
import { parseApiKey, verifySecret } from './crypto.ts'

/** Context variable keys this middleware sets. */
export interface AuthVars {
  userId: string
  user: User
}

/** The variables a Hono route can read after `requireUser`. */
export type AppEnv = { Bindings: Env; Variables: AuthVars }

/** The shared Hono app type used across routes. */
export type App = Hono<AppEnv>

/** Extracted bearer token from a request, if present. */
function bearerToken(c: Context<AppEnv>): string | undefined {
  const header = c.req.header('Authorization')
  if (header === undefined || !header.startsWith('Bearer ')) return undefined
  const token = header.slice('Bearer '.length).trim()
  return token.length > 0 ? token : undefined
}

/**
 * Build a CORS middleware with an origin allow-list from `ALLOWED_ORIGIN`.
 * Requests from non-listed origins get no CORS headers and are blocked by the
 * browser, though the engine may still serve them server-to-server.
 */
export function createCors(env: Env): MiddlewareHandler {
  const allowed = env.ALLOWED_ORIGIN.split(',')
    .map(origin => origin.trim())
    .filter(origin => origin.length > 0)
  return cors({
    origin: origin => {
      if (allowed.length === 0) return origin
      return allowed.includes(origin) ? origin : ''
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  })
}

/**
 * Hono middleware that authenticates the request and injects the owning user.
 * The API key (`dsk_<keyId>_<secret>`) is split, the user is located by its
 * public `apiKeyId` via the index, and only that one scrypt verification runs.
 * Responds 401 when the token is missing or invalid.
 */
export function requireUser(dbProvider: DbProvider): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearerToken(c)
    if (token === undefined) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'missing bearer token' } }, 401)
    }
    const parsed = parseApiKey(token)
    if (parsed === undefined) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'invalid token format' } }, 401)
    }
    const db = dbProvider.get()
    const row = await db.select().from(users).where(eq(users.apiKeyId, parsed.keyId)).limit(1)
    const user = row[0]
    if (user === undefined || !verifySecret(parsed.secret, user.apiKeyHash)) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'invalid token' } }, 401)
    }
    c.set('userId', user.id)
    c.set('user', user)
    return next()
  }
}

/** Read the authenticated user id set by `requireUser`. */
export function currentUserId(c: Context<AppEnv>): string {
  return c.get('userId')
}

/** Read the authenticated user set by `requireUser`. */
export function currentUser(c: Context<AppEnv>): User {
  return c.get('user')
}
