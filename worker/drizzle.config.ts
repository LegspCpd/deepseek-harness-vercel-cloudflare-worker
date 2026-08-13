import { defineConfig } from 'drizzle-kit'

/**
 * Drizzle Kit config. `drizzle-kit generate` writes migrations from the
 * schema; `drizzle-kit migrate` applies them to the Neon database.
 * @module serverless-worker/drizzle.config
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL as string,
  },
  strict: true,
  verbose: true,
})
