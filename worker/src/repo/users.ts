/**
 * Users data-access layer.
 *
 * Creating a user also generates a fresh API key whose plaintext is returned
 * exactly once. The key secret is stored only as a scrypt hash; the public
 * key id is stored plaintext for indexed authentication.
 * @module serverless-worker/repo/users
 */

import { eq } from 'drizzle-orm'
import type { DbClient } from '../db/index.ts'
import type { User } from '../db/schema.ts'
import { users } from '../db/schema.ts'
import { generateApiKey, hashSecret } from '../auth/crypto.ts'

/** A user with its generated API key material (plaintext shown once). */
export interface CreatedUser {
  readonly user: User
  readonly apiKey: string
  readonly apiKeyId: string
}

/** Create a user and a fresh API key. */
export async function createUser(db: DbClient, name: string): Promise<CreatedUser> {
  const material = generateApiKey()
  const rows = await db
    .insert(users)
    .values({ name, apiKeyId: material.apiKeyId, apiKeyHash: material.apiKeyHash })
    .returning()
  return {
    user: rows[0] as User,
    apiKey: material.apiKey,
    apiKeyId: material.apiKeyId,
  }
}

/** Fetch a user by id. */
export async function getUser(db: DbClient, id: string): Promise<User | undefined> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1)
  return rows[0]
}

/** Rotate a user's API key, invalidating the previous one. */
export async function rotateApiKey(db: DbClient, userId: string): Promise<{ apiKey: string; apiKeyId: string }> {
  const material = generateApiKey()
  await db
    .update(users)
    .set({ apiKeyId: material.apiKeyId, apiKeyHash: material.apiKeyHash })
    .where(eq(users.id, userId))
  return { apiKey: material.apiKey, apiKeyId: material.apiKeyId }
}

/**
 * Reset a user's API key hash from a caller-supplied secret (used by an admin
 * bootstrap flow, not exposed to end users).
 */
export async function setApiKey(db: DbClient, userId: string, secret: string): Promise<void> {
  await db
    .update(users)
    .set({ apiKeyId: 'admin', apiKeyHash: hashSecret(secret) })
    .where(eq(users.id, userId))
}

/** Delete a user and all their data (cascades from sessions/plugin_configs). */
export async function deleteUser(db: DbClient, userId: string): Promise<boolean> {
  const rows = await db.delete(users).where(eq(users.id, userId)).returning({ id: users.id })
  return rows.length > 0
}
