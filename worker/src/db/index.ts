/**
 * Drizzle client bound to Neon's serverless HTTP driver.
 *
 * The client is created lazily on first use and memoized per isolate. Drizzle
 * builds fully parameterized queries, so user input is never interpolated into
 * SQL. `createDb` does not touch the network until a query runs, so liveness
 * routes like `/health` never depend on the database being reachable.
 * @module serverless-worker/db
 */

import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http'
import type { Env } from '../types/env.ts'
import * as schema from './schema.ts'

export type * from './schema.ts'

/** The database client type used across the repo layer. */
export type DbClient = NeonHttpDatabase<typeof schema>

/** A lazy memoized database client provider for an isolate. */
export interface DbProvider {
  /** Resolve the Drizzle client, creating it on first call. */
  get(): DbClient
}

/**
 * Build a lazy database provider. The underlying `neon()` driver is created on
 * the first `get()`, so routes that never query (e.g. `/health`) succeed even
 * when `DATABASE_URL` is momentarily unset.
 * @param env - Worker environment holding `DATABASE_URL`.
 */
export function createDb(env: Env): DbProvider {
  let cached: DbClient | undefined
  return {
    get(): DbClient {
      if (cached === undefined) {
        cached = drizzle(neon(env.DATABASE_URL), { schema })
      }
      return cached
    },
  }
}
