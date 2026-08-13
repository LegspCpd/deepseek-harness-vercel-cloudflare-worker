/**
 * Tool registry and two-layer dispatch decision.
 *
 * Every tool is declared with a `ToolDefinition`. The router classifies each
 * call by its category:
 *  - `api`          -> runs natively in the Worker (`adapters/local.ts`)
 *  - `shell|python|file` -> forwarded to the Hugging Face free sandbox
 *                           (`adapters/hfSandbox.ts`) over HTTP
 * @module serverless-worker/engine/router
 */

import { executeLocalTool } from '../adapters/local.ts'
import { executeHfTool } from '../adapters/hfSandbox.ts'
import type { ToolCall, ToolDefinition, ToolResult } from '../types/tools.ts'
import type { Env } from '../types/env.ts'

/** All tools the engine exposes, in registry order. */
const REGISTRY: readonly ToolDefinition[] = [
  {
    name: 'current_time',
    category: 'api',
    description: 'Return the current UTC timestamp. Use when the model needs the wall-clock time.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'web_fetch',
    category: 'api',
    description: 'Fetch a URL and return its text content. Use for reading public web pages.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The absolute http(s) URL to fetch.' },
        maxBytes: { type: 'number', description: 'Optional cap on returned bytes (default 8192).' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'bash',
    category: 'shell',
    description: 'Run a Bash command inside the sandbox and return stdout/stderr.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The Bash command to execute.' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'python',
    category: 'python',
    description: 'Run a Python 3 script inside the sandbox and return stdout/stderr.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'The Python source code to run.' } },
      required: ['source'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    category: 'file',
    description: 'List entries in a directory inside the sandbox.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path; defaults to the session cwd.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    category: 'file',
    description: 'Read a text file from inside the sandbox.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute or session-cwd-relative file path.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
]

/** Return the tool categories currently exposed (for `GET /api/tools`). */
export function listToolCategories(): readonly string[] {
  return [...new Set(REGISTRY.map(tool => tool.category))]
}

/** Filter the registry to an explicit whitelist when provided. */
export function resolveToolDefinitions(whitelist: readonly string[] | undefined): readonly ToolDefinition[] {
  if (whitelist === undefined || whitelist.length === 0) return REGISTRY
  const allowed = new Set(whitelist)
  return REGISTRY.filter(tool => allowed.has(tool.name))
}

/** The JSON Schema list forwarded to the LLM as function declarations. */
export function llmFunctionDeclarations(definitions: readonly ToolDefinition[]): Record<string, unknown>[] {
  return definitions.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))
}

/** The sandbox working directory for a session (isolated per session id). */
function sandboxCwd(sessionId: string): string {
  return `/workspace/${sessionId}`
}

/** Dispatch a single tool call to its adapter and return a result. */
export async function dispatchTool(
  call: ToolCall,
  definitions: readonly ToolDefinition[],
  sessionId: string,
  env: Env,
): Promise<ToolResult> {
  const definition = definitions.find(candidate => candidate.name === call.name)
  if (definition === undefined) {
    return { ok: false, output: `tool "${call.name}" is not registered`, detail: null, error: 'not registered' }
  }
  const ctx = { sessionId, cwd: sandboxCwd(sessionId) }
  switch (definition.category) {
    case 'api':
      return executeLocalTool(call)
    case 'shell':
    case 'python':
    case 'file':
      return executeHfTool(call, ctx, env)
    default:
      return { ok: false, output: `tool "${call.name}" has unknown category`, detail: null, error: 'unknown category' }
  }
}
