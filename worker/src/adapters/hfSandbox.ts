/**
 * Hugging Face free-sandbox adapter.
 *
 * The engine never runs local subprocesses. Instead it forwards Bash / Python /
 * filesystem tool calls over HTTP to a self-hosted Hugging Face Space (Docker)
 * sandbox. This keeps the stack 100% free and card-free, replacing E2B.
 *
 * Security posture (guardrails 2 & 5):
 *  - The sandbox URL and shared secret come from the Worker `env` at runtime;
 *    never hardcoded.
 *  - The shared secret is sent only as the `X-Sandbox-Secret` header and is
 *    never exposed in responses.
 *  - `quoteShellArg` escapes a value as one POSIX shell word, so caller input
 *    cannot break out of a command vector (defense-in-depth on the wire).
 *  - Every request carries an AbortController timeout so a hung sandbox never
 *    wedges the SSE turn (guardrail 4).
 * @module serverless-worker/adapters/hfSandbox
 */

import type { AdapterContext, ToolCall, ToolResult } from '../types/tools.ts'
import type { Env } from '../types/env.ts'

/** The JSON shape a sandbox `/run` response returns. */
interface RunResponse {
  readonly stdout: string
  readonly stderr: string
  readonly exit_code: number
  readonly timed_out: boolean
}

/** The JSON shape a sandbox `/fs/list` response returns. */
interface ListEntry {
  readonly name: string
  readonly type: 'dir' | 'file'
  readonly size: number | null
}

/** Escapes a value as a single POSIX shell word. */
export function quoteShellArg(value: string): string {
  if (value.length === 0) return "''"
  if (/^[A-Za-z0-9_./:+=,-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** A lightweight HTTP client for the HF sandbox with hard timeouts. */
export class HfSandboxClient {
  private readonly baseUrl: string
  private readonly secret: string
  private readonly timeoutMs: number

  constructor(baseUrl: string, secret: string, timeoutMs: number) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.secret = secret
    this.timeoutMs = timeoutMs
  }

  /** Run a command or script in the sandbox. */
  async run(lang: 'bash' | 'python', content: string, cwd: string): Promise<RunResponse> {
    const body = { lang, command: content, cwd }
    return this.post('/run', body)
  }

  /** List a directory in the sandbox. */
  async listDir(path: string): Promise<readonly ListEntry[]> {
    const url = `${this.baseUrl}/fs/list?path=${encodeURIComponent(path)}`
    const response = await this.getJson<{ entries: ListEntry[] }>(url)
    return response.entries
  }

  /** Read a text file in the sandbox. */
  async readFile(path: string): Promise<string> {
    const url = `${this.baseUrl}/fs/read?path=${encodeURIComponent(path)}`
    const response = await this.getJson<{ content: string }>(url)
    return response.content
  }

  /** POST JSON to the sandbox with a timeout. */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`sandbox request timed out after ${this.timeoutMs}ms`)), this.timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeader(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`sandbox returned ${response.status}: ${(await response.text()).slice(0, 300)}`)
      }
      return (await response.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }

  /** GET JSON from the sandbox with a timeout. */
  private async getJson<T>(url: string): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`sandbox request timed out after ${this.timeoutMs}ms`)), this.timeoutMs)
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.authHeader(),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`sandbox returned ${response.status}: ${(await response.text()).slice(0, 300)}`)
      }
      return (await response.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }

  private authHeader(): Record<string, string> {
    return this.secret.length > 0 ? { 'X-Sandbox-Secret': this.secret } : {}
  }
}

/** The default per-request timeout for the HF sandbox, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 90_000

/** Resolve the HF sandbox base URL from env, throwing when unconfigured. */
function resolveBaseUrl(env: Env): string {
  const url = env.HF_SANDBOX_URL
  if (url === undefined || url.length === 0) {
    throw new Error('HF_SANDBOX_URL is not configured')
  }
  return url
}

/** Read the shared sandbox secret (empty means "no auth" on the sandbox side). */
function resolveSecret(env: Env): string {
  return env.HF_SANDBOX_SECRET ?? ''
}

/** Parse a timeout env var into a bounded safe integer. */
function parseTimeout(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 600_000) return fallback
  return parsed
}

/** Resolve a caller path against the sandbox working directory. */
function resolvePath(path: string, cwd: string): string {
  return path.startsWith('/') ? path : `${cwd}/${path}`.replace(/\/+/g, '/')
}

/** Read a required string arg, throwing on absence/mismatch. */
function stringArg(call: ToolCall, key: string, fallback?: string): string {
  const value = call.args[key]
  if (typeof value === 'string') return value
  if (fallback !== undefined) return fallback
  throw new Error(`tool ${call.name} requires string arg "${key}"`)
}

/** Format a sandbox run result into a model-visible string. */
function formatRun(run: RunResponse): string {
  const parts: string[] = []
  if (run.stdout.length > 0) parts.push(run.stdout)
  if (run.stderr.length > 0) parts.push(`[stderr]\n${run.stderr}`)
  if (parts.length === 0) parts.push(run.timed_out ? 'command timed out' : 'no output')
  if (run.exit_code !== 0) parts.push(`[exit ${run.exit_code}]`)
  return parts.join('\n')
}

/**
 * Execute a shell/python/file tool call against the HF sandbox. Never throws
 * for user or sandbox errors; returns a structured ToolResult so the LLM loop
 * always has something to feed back.
 */
export async function executeHfTool(
  call: ToolCall,
  ctx: AdapterContext,
  env: Env,
): Promise<ToolResult> {
  const client = new HfSandboxClient(resolveBaseUrl(env), resolveSecret(env), parseTimeout(env.HF_SANDBOX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS))
  try {
    let output: string
    switch (call.name) {
      case 'bash': {
        const run = await client.run('bash', stringArg(call, 'command'), ctx.cwd)
        output = formatRun(run)
        break
      }
      case 'python': {
        const run = await client.run('python', stringArg(call, 'source'), ctx.cwd)
        output = formatRun(run)
        break
      }
      case 'list_files': {
        const path = resolvePath(stringArg(call, 'path', '.'), ctx.cwd)
        const entries = await client.listDir(path)
        if (entries.length === 0) {
          output = 'empty directory'
        } else {
          output = entries.map(entry => `${entry.type === 'dir' ? 'dir' : 'file'}\t${entry.name}${entry.type === 'dir' ? '/' : ''}`).join('\n')
        }
        break
      }
      case 'read_file': {
        const path = resolvePath(stringArg(call, 'path'), ctx.cwd)
        output = await client.readFile(path)
        break
      }
      default:
        return { ok: false, output: `unknown sandbox tool: ${call.name}`, detail: null, error: 'unknown tool' }
    }
    return { ok: true, output, detail: output }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, output: `sandbox error: ${message}`, detail: null, error: message }
  }
}
