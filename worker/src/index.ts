/**
 * Cloudflare Workers entry point — a Hono application.
 *
 * Wiring:
 *  - `cors` middleware enforces the origin allow-list.
 *  - `POST /api/users` (bootstrap) is protected by an `ADMIN_TOKEN` header.
 *  - every other `/api/*` route runs `requireUser`, which resolves the API key
 *    to a `userId` and injects it on the context; repo layers then scope every
 *    query by that id (BOLA/IDOR guardrail).
 *  - `app.onError` catches anything that escapes a handler and turns it into a
 *    structured 500; SSE streams additionally emit an `error` frame (guardrail 4).
 * @module serverless-worker/index
 */

import { Hono } from 'hono'
import { createCors, requireUser, type AppEnv } from './auth/middleware.ts'
import { createDb } from './db/index.ts'
import { chatRoutes } from './routes/chat.ts'
import { sessionRoutes } from './routes/sessions.ts'
import { pluginConfigRoutes } from './routes/pluginConfigs.ts'
import { toolsRoutes } from './routes/tools.ts'
import { bootstrapRoutes, authedUserRoutes } from './routes/users.ts'
import type { Env } from './types/env.ts'

/** Build the fully-wired Hono application. */
function buildApp(env: Env): Hono<AppEnv> {
  const dbProvider = createDb(env)
  const app = new Hono<AppEnv>()

  // CORS allow-list from ALLOWED_ORIGIN.
  app.use('*', createCors(env))

  // Public liveness probe — never touches the database.
  app.get('/health', c => c.json({ ok: true, service: 'dsh-serverless-engine' }))

  // Bootstrap: POST /api/users creates the first user(s). Protected by
  // ADMIN_TOKEN inside, so it does not require a user API key yet.
  app.route('/api', bootstrapRoutes(dbProvider))

  // Every other /api route requires a valid API key.
  app.use('/api/*', requireUser(dbProvider))

  app.route('/api', authedUserRoutes(dbProvider))
  app.route('/api', chatRoutes(dbProvider))
  app.route('/api', sessionRoutes(dbProvider))
  app.route('/api', pluginConfigRoutes(dbProvider))
  app.route('/api', toolsRoutes())

  // Structured JSON errors for anything that escapes a handler.
  app.onError((error, c) => {
    console.error('unhandled error', error)
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } },
      500,
    )
  })

  return app
}

/** The Worker fetch handler. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await buildApp(env).fetch(request, env)
  },
}
