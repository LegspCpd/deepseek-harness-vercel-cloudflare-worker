/**
 * plugin_configs data-access layer built on Drizzle.
 *
 * Every query scopes by `userId` (BOLA/IDOR guardrail). A user can only read,
 * update, or delete their own plugin configurations; the unique key is
 * `(userId, pluginName)`.
 * @module serverless-worker/repo/pluginConfigs
 */

import { and, desc, eq } from 'drizzle-orm'
import type { DbClient } from '../db/index.ts'
import { pluginConfigs } from '../db/schema.ts'

/** A plugin-config record as exposed by the API. */
export interface PluginConfigRecord {
  readonly id: string
  readonly pluginName: string
  readonly config: unknown
  readonly updatedAt: string
}

function mapConfig(row: typeof pluginConfigs.$inferSelect): PluginConfigRecord {
  return {
    id: row.id,
    pluginName: row.pluginName,
    config: row.config,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Upsert a user's plugin config, keyed by `(userId, pluginName)`. */
export async function upsertPluginConfig(
  db: DbClient,
  userId: string,
  pluginName: string,
  config: unknown,
): Promise<PluginConfigRecord> {
  const rows = await db
    .insert(pluginConfigs)
    .values({ userId, pluginName, config: (config ?? {}) as object })
    .onConflictDoUpdate({
      target: [pluginConfigs.userId, pluginConfigs.pluginName],
      set: { config: (config ?? {}) as object, updatedAt: new Date() },
    })
    .returning()
  return mapConfig(rows[0] as typeof pluginConfigs.$inferSelect)
}

/** Fetch a user's plugin config, or `undefined` when absent. */
export async function getPluginConfig(
  db: DbClient,
  userId: string,
  pluginName: string,
): Promise<PluginConfigRecord | undefined> {
  const rows = await db
    .select()
    .from(pluginConfigs)
    .where(and(eq(pluginConfigs.userId, userId), eq(pluginConfigs.pluginName, pluginName)))
    .limit(1)
  const row = rows[0]
  return row === undefined ? undefined : mapConfig(row)
}

/** List the user's plugin configs, sorted by plugin name. */
export async function listPluginConfigs(db: DbClient, userId: string): Promise<PluginConfigRecord[]> {
  const rows = await db
    .select()
    .from(pluginConfigs)
    .where(eq(pluginConfigs.userId, userId))
    .orderBy(desc(pluginConfigs.updatedAt))
  return rows.map(mapConfig)
}

/** Delete a user's plugin config. Returns whether a row was removed. */
export async function deletePluginConfig(db: DbClient, userId: string, pluginName: string): Promise<boolean> {
  const rows = await db
    .delete(pluginConfigs)
    .where(and(eq(pluginConfigs.userId, userId), eq(pluginConfigs.pluginName, pluginName)))
    .returning({ id: pluginConfigs.id })
  return rows.length > 0
}
