/**
 * Drizzle schema for the serverless engine's Neon database.
 *
 * Every table that holds user data carries a `userId` ownership column, and
 * every repository query MUST filter by it (`WHERE id = $1 AND userId = $2`).
 * This is the enforcement point for the BOLA/IDOR guardrail: a user can never
 * read, update, or delete another user's rows.
 * @module serverless-worker/db/schema
 */

import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, bigserial } from 'drizzle-orm/pg-core'

/** Registered users, each with a scrypt-hashed API key. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /**
     * Public key id embedded in the API key prefix (`dsk_<keyId>_<secret>`).
     * Indexed so authentication does a single-row lookup before scrypt.
     */
    apiKeyId: text('api_key_id').notNull(),
    /** scrypt hash of the API key secret; never store the plaintext key. */
    apiKeyHash: text('api_key_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('users_api_key_id_idx').on(table.apiKeyId),
  ],
)

/** A chat session, owned by exactly one user. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('New session'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    meta: jsonb('meta').notNull().default({}),
  },
  table => [
    index('sessions_user_created_idx').on(table.userId, table.createdAt.desc()),
  ],
)

/** Append-only chat message log. Ownership flows through the session. */
export const messages = pgTable(
  'messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['system', 'user', 'assistant', 'tool'] }).notNull(),
    content: jsonb('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('messages_session_created_idx').on(table.sessionId, table.createdAt.desc()),
  ],
)

/** Per-user plugin configuration. */
export const pluginConfigs = pgTable(
  'plugin_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pluginName: text('plugin_name').notNull(),
    config: jsonb('config').notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex('plugin_configs_user_name_idx').on(table.userId, table.pluginName),
  ],
)

/** The row type for a user. */
export type User = typeof users.$inferSelect
/** The row type for a session. */
export type Session = typeof sessions.$inferSelect
/** The row type for a message. */
export type Message = typeof messages.$inferSelect
/** The row type for a plugin config. */
export type PluginConfig = typeof pluginConfigs.$inferSelect
