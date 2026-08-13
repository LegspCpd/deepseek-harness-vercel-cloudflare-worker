/**
 * E2B sandbox adapter: forwards Bash / Python / filesystem tool calls to a
 * cloud sandbox via the `e2b` SDK. This replaces every local subprocess path.
 *
 * Security posture mirrors the project's `dsh-e2b`/`dsh-subprocess-e2b` design:
 *  - Every user-provided shell argument is escaped with `quoteE2BShellArg`, so
 *    `;`, `$(...)`, and backticks cannot escape the intended command.
 *  - Control-plane commands run under a randomized, isolated HOME
 *    (`e2bControlEnvs`) so sandbox metadata never bleeds into user work.
 *  - The E2B API key is bound at the Worker boundary and never injected into
 *    the sandbox environment.
 *  - Every command carries an abort signal + timeout; the shared sandbox is
 *    created once and lazily, and killed on completion/disposal.
 *
 * This is a hand-rolled adaptation of the reusable `@deepseek-ai/dsh-e2b`
 * pure-logic (which is a Cordis Service and cannot be instantiated on
 * Workers); the shell-escaping and env-isolation helpers are reproduced here
 * with identical semantics.
 * @module serverless-worker/adapters/e2b
 */

import { FileType, Sandbox } from 'e2b'
import type { AdapterContext, ToolCall, ToolResult } from '../types/tools.ts'
import type { Env } from '../types/env.ts'

/** Escapes a value as a single shell word for the `/bin/bash -l -c` layer. */
export function quoteE2BShellArg(value: string): string {
  if (value.length === 0) return "''"
  if (/^[A-Za-z0-9_./:+=,-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Control-plane environment: overrides with an isolated, randomized HOME so
 * sandbox machinery never interferes with user commands.
 */
export function e2bControlEnvs(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { ...overrides, HOME: `/.dsh-e2b-control-${crypto.randomUUID()}` }
}

/** A lazily-created, shared E2B sandbox with a bounded lifetime. */
class E2BSandboxPool {
  private readonly apiKey: string
  private readonly timeoutMs: number
  private sandbox: Sandbox | undefined
  private pending: Promise<Sandbox> | undefined

  constructor(apiKey: string, timeoutMs: number) {
    this.apiKey = apiKey
    this.timeoutMs = timeoutMs
  }

  /** Get the shared sandbox, creating it on first use. */
  async get(): Promise<Sandbox> {
    if (this.sandbox !== undefined) return this.sandbox
    if (this.pending === undefined) {
      // Eager create so only the first call pays the provisioning latency.
      this.pending = (async () => {
        const sandbox = await Sandbox.create({
          apiKey: this.apiKey,
          timeoutMs: this.timeoutMs,
          secure: true,
          lifecycle: { onTimeout: 'kill' },
        })
        this.sandbox = sandbox
        return sandbox
      })()
    }
    return this.pending
  }

  /** Kill the sandbox, best-effort, on turn completion or fatal error. */
  async dispose(): Promise<void> {
    const sandbox = this.sandbox
    this.sandbox = undefined
    this.pending = undefined
    if (sandbox !== undefined) {
      try {
        await sandbox.kill()
      } catch (_sandboxAlreadyGone) {
        // The sandbox timed out or was killed by E2B; nothing left to reap.
      }
    }
  }
}

/** Map an E2B command failure to a stable error string. */
function describeCommandFailure(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Run a Bash command in the sandbox with a hard timeout. */
async function runBash(sandbox: Sandbox, script: string, cwd: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`command timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    const result = await sandbox.commands.run(script, {
      cwd,
      envs: e2bControlEnvs(),
      signal: controller.signal,
    })
    return result.stdout.length > 0 ? result.stdout : result.stderr
  } catch (error: unknown) {
    // Surfacing the exit code and stderr keeps the LLM informed on failure.
    const message = describeCommandFailure(error)
    return `exit: error — ${message}`
  } finally {
    clearTimeout(timer)
  }
}

/** Run a Python file/script in the sandbox. */
async function runPython(sandbox: Sandbox, source: string, cwd: string, timeoutMs: number): Promise<string> {
  // Write the script to a uniquely named file then execute it, so tracebacks
  // and runtime state resolve to a real path inside the sandbox.
  const filename = `.dsh-${crypto.randomUUID()}.py`
  await sandbox.files.write(filename, source)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`python timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    const result = await sandbox.commands.run(`python3 ${quoteE2BShellArg(filename)}`, {
      cwd,
      envs: e2bControlEnvs(),
      signal: controller.signal,
    })
    return result.stdout.length > 0 ? result.stdout : result.stderr
  } catch (error: unknown) {
    return `exit: error — ${describeCommandFailure(error)}`
  } finally {
    clearTimeout(timer)
    try {
      await sandbox.files.remove(filename)
    } catch (_cleanupBestEffort) {
      // A stale temp script inside the sandbox is harmless; cleanup is best-effort.
    }
  }
}

/** List files in the sandbox at a path. */
async function listFiles(sandbox: Sandbox, path: string, cwd: string): Promise<string> {
  const target = path.startsWith('/') ? path : `${cwd}/${path}`
  const entries = await sandbox.files.list(target, { depth: 1 })
  if (entries.length === 0) return 'empty directory'
  return entries.map(entry => {
    const isDir = entry.type === FileType.DIR
    const kind = isDir ? 'dir' : entry.type === FileType.FILE ? 'file' : 'other'
    return `${kind}\t${entry.name}${isDir ? '/' : ''}`
  }).join('\n')
}

/** Read a text file from the sandbox. */
async function readFile(sandbox: Sandbox, path: string, cwd: string): Promise<string> {
  const target = path.startsWith('/') ? path : `${cwd}/${path}`
  const bytes = await sandbox.files.read(target, { format: 'bytes' })
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/** The default timeout for a single sandbox command, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Execute a shell/python/file tool call against the shared E2B sandbox.
 * Never throws for user error; returns a structured ToolResult.
 */
export async function executeE2BTool(
  call: ToolCall,
  ctx: AdapterContext,
  env: Env,
  sandboxPool: E2BSandboxPool,
): Promise<ToolResult> {
  const timeoutMs = parseTimeout(env.E2B_SANDBOX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  try {
    const sandbox = await sandboxPool.get()
    let output: string
    switch (call.name) {
      case 'bash':
        output = await runBash(sandbox, stringArg(call, 'command'), ctx.cwd, timeoutMs)
        break
      case 'python':
        output = await runPython(sandbox, stringArg(call, 'source'), ctx.cwd, timeoutMs)
        break
      case 'list_files':
        output = await listFiles(sandbox, stringArg(call, 'path', '.'), ctx.cwd)
        break
      case 'read_file':
        output = await readFile(sandbox, stringArg(call, 'path'), ctx.cwd)
        break
      default:
        return { ok: false, output: `unknown E2B tool: ${call.name}`, detail: null, error: 'unknown tool' }
    }
    return { ok: true, output, detail: output }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, output: `sandbox error: ${message}`, detail: null, error: message }
  }
}

/** Read a required string arg, throwing on absence/mismatch. */
function stringArg(call: ToolCall, key: string, fallback?: string): string {
  const value = call.args[key]
  if (typeof value === 'string') return value
  if (fallback !== undefined) return fallback
  throw new Error(`tool ${call.name} requires string arg "${key}"`)
}

/** Parse an E2B timeout env var into a bounded safe integer. */
function parseTimeout(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 600_000) return fallback
  return parsed
}

export { E2BSandboxPool }
