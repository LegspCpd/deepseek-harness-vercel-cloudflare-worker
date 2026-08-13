/**
 * Tools route: exposes the registered tool catalog to authenticated clients.
 * @module serverless-worker/routes/tools
 */

import { Hono } from 'hono'
import { listToolCategories } from '../engine/router.ts'
import type { AppEnv } from '../auth/middleware.ts'

/** Build the tools sub-app. */
export function toolsRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get('/tools', c => c.json({ tools: listToolCategories() }))
  return app
}
