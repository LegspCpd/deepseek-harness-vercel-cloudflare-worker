/**
 * Lightweight agent loop for the serverless engine.
 *
 * Flow for one turn:
 *   1. Load the session transcript from Neon.
 *   2. Stream a completion from the DeepSeek API.
 *   3. Stream `text` frames as tokens arrive.
 *   4. If the model issues tool calls, dispatch each via the router
 *      (local API tools or E2B sandbox), emit `tool` frames, persist the
 *      tool messages, then loop back for the follow-up completion.
 *   5. Persist the user and assistant messages to Neon.
 *
 * Every async boundary is try/caught by the caller in `sse.ts`; this module
 * additionally isolates each step so a tool failure becomes a result the
 * model can see rather than a crashed turn.
 * @module serverless-worker/engine/agent
 */

import type { DbClient } from '../db/index.ts'
import { appendMessage } from '../repo/messages.ts'
import { loadSessionMessages } from '../repo/sessions.ts'
import type { SseSink } from '../sse.ts'
import type { Env } from '../types/env.ts'
import type { ChatRequest } from '../types/agent.ts'
import type { ToolDefinition } from '../types/tools.ts'
import { dispatchTool, llmFunctionDeclarations, resolveToolDefinitions } from './router.ts'
import { E2BSandboxPool } from '../adapters/e2b.ts'

/** A tool invocation parsed out of an assistant message. */
interface ParsedToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

/** Maximum tool-call iterations in one turn before giving up. */
const MAX_TOOL_ITERATIONS = 8

/** A shared, per-turn sandbox pool. */
interface TurnSandbox {
  readonly pool: E2BSandboxPool
  readonly dispose: () => Promise<void>
}

/**
 * Run a single agent turn and stream SSE frames.
 * @param request - The validated chat turn with a resolved session id.
 * @param db - The Drizzle client for persistence.
 * @param env - Worker environment holding LLM/E2B secrets.
 * @param sink - SSE sink for `text` and `tool` frames.
 */
/** A chat turn with a fully-resolved session id and owner. */
export interface AgentTurnRequest extends Omit<ChatRequest, 'sessionId'> {
  readonly sessionId: string
  readonly userId: string
}

export async function runAgentTurn(
  request: AgentTurnRequest,
  db: DbClient,
  env: Env,
  sink: SseSink,
): Promise<void> {
  const sandbox = await openSandbox(env)
  try {
    const transcript = await loadSessionMessages(db, request.userId, request.sessionId)
    const definitions = resolveToolDefinitions(request.tools)
    const messages = buildMessages(transcript, request.prompt, request.systemPrompt, definitions)

    await appendMessage(db, request.userId, request.sessionId, 'user', { type: 'text', text: request.prompt })

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const assistant = await streamCompletion(request, db, env, messages, definitions, sink, sandbox.pool)
      if (assistant === undefined) break
      // Push the assistant turn into the loop with its tool_calls intact.
      messages.push(assistant.message)

      if (assistant.toolCalls.length === 0) break

      for (const call of assistant.toolCalls) {
        const result = await dispatchTool({ name: call.name, args: call.arguments }, definitions, request.sessionId, env, sandbox.pool)
        await sink.tool({
          name: call.name,
          args: call.arguments,
          result: result.detail,
          ...(result.error !== undefined ? { error: result.error } : {}),
        })
        await appendMessage(db, request.userId, request.sessionId, 'tool', {
          tool_call_id: call.id,
          name: call.name,
          output: result.output,
        })
        messages.push({
          role: 'tool',
          content: result.output,
          tool_call_id: call.id,
        })
      }
    }
  } finally {
    await sandbox.dispose()
  }
}

/** Open the per-turn E2B sandbox pool. */
async function openSandbox(env: Env): Promise<TurnSandbox> {
  const pool = new E2BSandboxPool(env.E2B_API_KEY, parseSandboxTimeout(env.E2B_SANDBOX_TIMEOUT_MS))
  return {
    pool,
    dispose: () => pool.dispose(),
  }
}

/** Parse the sandbox lifetime env var into a bounded integer. */
function parseSandboxTimeout(raw: string | undefined): number {
  if (raw === undefined) return 300_000
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 3_600_000) return 300_000
  return parsed
}

/** Build the model message array from transcript + current prompt. */
function buildMessages(
  transcript: readonly { role: string; content: unknown }[],
  prompt: string,
  systemPrompt: string | undefined,
  definitions: readonly ToolDefinition[],
): DeepSeekMessage[] {
  const messages: DeepSeekMessage[] = []
  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  for (const message of transcript) {
    const role = message.role as DeepSeekMessage['role']
    if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') {
      messages.push({ role, content: serializeMessageContent(message.content, role) })
    }
  }
  messages.push({ role: 'user', content: prompt })
  // DeepSeek requires tool messages to follow an assistant tool-call; strip a
  // trailing tool message if the transcript ended mid-loop (defensive).
  while (messages.length > 0 && messages[messages.length - 1]?.role === 'tool') {
    messages.pop()
  }
  return messages
}

/** Normalize a stored content blob into a model-acceptable string/parts. */
function serializeMessageContent(content: unknown, role: string): string {
  if (typeof content === 'string') return content
  if (content !== null && typeof content === 'object') {
    const text = (content as Record<string, unknown>)['text']
    if (typeof text === 'string') return text
  }
  return JSON.stringify(content ?? (role === 'assistant' ? '' : '[empty]'))
}

/**
 * Stream one completion from DeepSeek, emitting text tokens and persisting the
 * assistant message. Returns the assistant content for tool-call inspection, or
 * `undefined` if the stream produced no usable assistant content.
 */
async function streamCompletion(
  request: AgentTurnRequest,
  db: DbClient,
  env: Env,
  messages: readonly DeepSeekMessage[],
  definitions: readonly ToolDefinition[],
  sink: SseSink,
  pool: E2BSandboxPool,
): Promise<{ message: DeepSeekMessage; toolCalls: ParsedToolCall[] } | undefined> {
  const url = `${env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'}/chat/completions`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      stream: true,
      messages,
      tools: definitions.length > 0 ? llmFunctionDeclarations(definitions) : undefined,
      tool_choice: 'auto',
      stream_options: { include_usage: false },
    }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`DeepSeek API ${response.status}: ${body.slice(0, 400)}`)
  }
  if (response.body === null) throw new Error('DeepSeek returned an empty stream body')

  let content = ''
  const toolCalls: AccumulatingToolCall[] = []
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of readChunks(response.body)) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary: number
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary).trim()
      buffer = buffer.slice(boundary + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(payload)
      } catch {
        continue
      }
      applyDelta(parsed, (text, toolCall) => {
        if (text !== undefined && text.length > 0) {
          content += text
          void sink.text(text)
        }
        if (toolCall !== undefined) {
          mergeToolDelta(toolCalls, toolCall)
        }
      })
    }
  }

  if (content.length === 0 && toolCalls.length === 0) {
    return undefined
  }
  // Resolve accumulated argument JSON into final parsed arguments.
  const resolvedCalls = extractToolCalls(toolCalls)
  // DeepSeek tool-call format for an assistant message.
  const callParts = resolvedCalls.map(call => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }))
  const message: DeepSeekMessage = callParts.length === 0
    ? { role: 'assistant', content }
    : {
        role: 'assistant',
        content: content.length > 0
          ? [{ type: 'text', text: content }, { type: 'tool_calls', tool_calls: callParts }]
          : [{ type: 'tool_calls', tool_calls: callParts }],
      }
  await appendMessage(db, request.userId, request.sessionId, 'assistant', message.content)
  return { message, toolCalls: resolvedCalls }
}

/** Read the response body as an async iterable of Uint8Array chunks. */
async function* readChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value !== undefined) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/** A DeepSeek chat message. */
interface DeepSeekMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string | unknown[]
  /** Required for `tool` role: references the assistant tool_call id. */
  readonly tool_call_id?: string
}

/**
 * A tool call the model requested, with its id/name and either accumulated
 * argument JSON (during streaming) or the final parsed arguments.
 */
interface AccumulatingToolCall {
  readonly id: string
  name: string
  /** Internal streaming carrier: `__accumulator` holds raw argument JSON. */
  arguments: { __accumulator: string }
}

/** Apply a streamed delta to the running text and tool-call accumulators. */
function applyDelta(parsed: unknown, emit: (text?: string, toolCall?: AccumulatingToolCall) => void): void {
  if (parsed === null || typeof parsed !== 'object') return
  const root = parsed as Record<string, unknown>
  const choices = root['choices']
  if (!Array.isArray(choices)) return
  const first = choices[0] as Record<string, unknown> | undefined
  if (first === undefined) return
  const delta = first['delta'] as Record<string, unknown> | undefined
  if (delta === undefined) return
  if (typeof delta['content'] === 'string') {
    emit(delta['content'] as string)
  }
  const toolCalls = delta['tool_calls']
  if (Array.isArray(toolCalls)) {
    for (const raw of toolCalls) {
      const call = raw as Record<string, unknown>
      if (call === null || typeof call !== 'object') continue
      const fn = call['function'] as Record<string, unknown> | undefined
      const name = typeof fn?.['name'] === 'string' ? (fn['name'] as string) : ''
      const argsText = typeof fn?.['arguments'] === 'string' ? (fn['arguments'] as string) : ''
      const index = typeof call['index'] === 'number' ? (call['index'] as number) : 0
      emit(undefined, {
        id: typeof call['id'] === 'string' ? (call['id'] as string) : `call_${index}`,
        name,
        arguments: { __accumulator: argsText },
      })
    }
  }
}

/** Merge a partial tool-call delta into the accumulator by call index. */
function mergeToolDelta(accumulator: AccumulatingToolCall[], delta: AccumulatingToolCall): void {
  const index = Number(delta.id.match(/^call_(\d+)$/)?.[1] ?? '0')
  const existing = accumulator[index]
  if (existing === undefined) {
    accumulator[index] = delta
    return
  }
  if (existing.name.length === 0 && delta.name.length > 0) existing.name = delta.name
  existing.arguments.__accumulator += delta.arguments.__accumulator
}

/** Extract final tool calls, parsing accumulated JSON arguments. */
function extractToolCalls(accumulator: readonly AccumulatingToolCall[]): ParsedToolCall[] {
  return accumulator.map(call => ({
    id: call.id,
    name: call.name,
    arguments: parseArguments(call.arguments.__accumulator),
  }))
}

/** Parse accumulated JSON arguments defensively. */
function parseArguments(blob: string): Record<string, unknown> {
  if (blob.length === 0) return {}
  try {
    const parsed = JSON.parse(blob) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return { __raw: blob }
  }
}
