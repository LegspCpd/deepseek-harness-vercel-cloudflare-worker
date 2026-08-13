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
  /** DeepSeek LLM API key. Secret. */
  readonly DEEPSEEK_API_KEY: string
  /** Token protecting `POST /api/users` user bootstrap. Secret. */
  readonly ADMIN_TOKEN: string
  /** Public URL of the Hugging Face free sandbox Space. Plain variable. */
  readonly HF_SANDBOX_URL: string
  /** Shared secret for the HF sandbox; sent as X-Sandbox-Secret. Secret. */
  readonly HF_SANDBOX_SECRET?: string
  /** Optional DeepSeek base URL override (defaults to api.deepseek.com). */
  readonly DEEPSEEK_BASE_URL?: string
  /** CORS allow-list origin (comma-separated). Plain variable. */
  readonly ALLOWED_ORIGIN: string
  /** Per-sandbox-request timeout in milliseconds. */
  readonly HF_SANDBOX_TIMEOUT_MS?: string
}
