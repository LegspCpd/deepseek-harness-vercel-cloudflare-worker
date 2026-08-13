/**
 * Local (in-Worker) adapters for pure API / JS tools. These run natively in
 * the Workers isolate and never touch a subprocess or the sandbox. Example
 * tools: web search, current time, simple deterministic computations.
 *
 * Each handler is a pure async function of its arguments and must throw only
 * for genuinely unexpected conditions; user-triggerable failures return a
 * structured result instead.
 * @module serverless-worker/adapters/local
 */

import type { ToolCall, ToolResult } from '../types/tools.ts'

/** Return the current UTC time and the ISO date. */
async function currentTime(): Promise<string> {
  const now = new Date()
  return `now: ${now.toISOString()}`
}

/** A tiny web-fetch tool: GET a URL and return up to `maxBytes` of text. */
async function webFetch(call: ToolCall): Promise<string> {
  const url = stringArg(call, 'url')
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`web_fetch: only http(s) URLs are allowed, got ${url}`)
  }
  const maxBytes = numberArg(call, 'maxBytes', 8192)
  const response = await fetch(url, { headers: { 'User-Agent': 'dsh-serverless-engine' } })
  if (!response.ok) {
    throw new Error(`web_fetch: ${response.status} ${response.statusText}`)
  }
  const text = await response.text()
  return text.slice(0, Math.max(1, maxBytes))
}

/** Dispatch a local tool call to its handler. Never throws for user errors. */
export async function executeLocalTool(call: ToolCall): Promise<ToolResult> {
  try {
    let output: string
    switch (call.name) {
      case 'current_time':
        output = await currentTime()
        break
      case 'web_fetch':
        output = await webFetch(call)
        break
      default:
        return { ok: false, output: `unknown local tool: ${call.name}`, detail: null, error: 'unknown tool' }
    }
    return { ok: true, output, detail: output }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, output: `local tool error: ${message}`, detail: null, error: message }
  }
}

/** Read a required string arg, throwing on absence/mismatch. */
function stringArg(call: ToolCall, key: string): string {
  const value = call.args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`tool ${call.name} requires non-empty string arg "${key}"`)
  }
  return value
}

/** Read an optional numeric arg with a fallback. */
function numberArg(call: ToolCall, key: string, fallback: number): number {
  const value = call.args[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fallback
  return value
}
