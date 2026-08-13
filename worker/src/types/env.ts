/**
 * Cloudflare Workers environment bindings and secrets.
 *
 * Every secret lives ONLY here (bound via `wrangler secret put` / the CF
 * dashboard) and is never embedded in the frontend bundle. The frontend only
 * ever sees the public worker URL through `NEXT_PUBLIC_WORKER_URL`.
 * @module serverless-worker/types/env
 */

/** Worker environment: statically known bindings plus secrets. */
export interface Env {
  /** Neon PostgreSQL pooled connection string. Secret. */
  readonly DATABASE_URL: string
  /** E2B sandbox API key; never forwarded into a sandbox. Secret. */
  readonly E2B_API_KEY: string
  /** DeepSeek LLM API key. Secret. */
  readonly DEEPSEEK_API_KEY: string
  /** Token protecting `POST /api/users` user bootstrap. Secret. */
  readonly ADMIN_TOKEN: string
  /** Optional DeepSeek base URL override (defaults to api.deepseek.com). */
  readonly DEEPSEEK_BASE_URL?: string
  /** CORS allow-list origin (comma-separated). Plain variable. */
  readonly ALLOWED_ORIGIN: string
  /** E2B sandbox lifetime in milliseconds before E2B kills it. */
  readonly E2B_SANDBOX_TIMEOUT_MS?: string
}
