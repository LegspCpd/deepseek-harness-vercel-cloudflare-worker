/**
 * plugin_configs routes. Every handler scopes by the authenticated `userId`.
 * @module serverless-worker/routes/pluginConfigs
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { DbProvider } from '../db/index.ts'
import { currentUserId } from '../auth/middleware.ts'
import type { AppEnv } from '../auth/middleware.ts'
import { deletePluginConfig, listPluginConfigs, upsertPluginConfig } from '../repo/pluginConfigs.ts'

const upsertSchema = z.object({ pluginName: z.string().min(1).max(128), config: z.unknown() })
const nameParam = z.object({ name: z.string().min(1).max(128) })

/** Build the plugin-configs sub-app. */
export function pluginConfigRoutes(dbProvider: DbProvider): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/', async c => {
    const db = dbProvider.get()
    const userId = currentUserId(c)
    const configs = await listPluginConfigs(db, userId)
    return c.json({ configs })
  })

  app.post('/', zValidator('json', upsertSchema), async c => {
    const db = dbProvider.get()
    const userId = currentUserId(c)
    const body = c.req.valid('json')
    const config = await upsertPluginConfig(db, userId, body.pluginName, body.config)
    return c.json({ config })
  })

  app.put('/:name', zValidator('param', nameParam), zValidator('json', z.object({ config: z.unknown() })), async c => {
    const db = dbProvider.get()
    const userId = currentUserId(c)
    const config = await upsertPluginConfig(db, userId, c.req.valid('param').name, c.req.valid('json').config)
    return c.json({ config })
  })

  app.delete('/:name', zValidator('param', nameParam), async c => {
    const db = dbProvider.get()
    const userId = currentUserId(c)
    const deleted = await deletePluginConfig(db, userId, c.req.valid('param').name)
    if (!deleted) return c.json({ error: { code: 'NOT_FOUND', message: 'plugin config not found' } }, 404)
    return c.json({ ok: true })
  })

  return app
}
