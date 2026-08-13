/**
 * API client for the serverless engine.
 *
 * Every request attaches the user's API key as a Bearer token (read live from
 * config). An SSE client streams chat turns via `fetch` + parsed `data:` frames,
 * which EventSource cannot do for POST bodies.
 * @module vercel-ui/api
 */

import { loadApiKey, runtimeConfig } from './config'

/** A chat message in the transcript. */
export interface ChatMessage {
  readonly id: string
  readonly sessionId: string
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: unknown
  readonly createdAt: string
}

/** A session record. */
export interface SessionRecord {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly meta: Record<string, unknown>
}

/** A tool event received over SSE. */
export interface ToolEvent {
  readonly name: string
  readonly args: unknown
  readonly result: unknown
  readonly error?: string
}

/** The public (hash-free) view of the authenticated user. */
export interface SafeUser {
  readonly id: string
  readonly name: string
  readonly createdAt: string
}

/** Callbacks for SSE stream events. */
export interface SseHandlers {
  onText?: (text: string) => void
  onTool?: (tool: ToolEvent) => void
  onError?: (message: string) => void
  onDone?: () => void
}

/** Resolve a path against the worker base URL. */
function endpoint(path: string): string {
  return `${runtimeConfig.workerUrl}${path}`
}

/** Build auth headers; empty token is omitted. */
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra }
  const apiKey = loadApiKey()
  if (apiKey.length > 0) headers['Authorization'] = `Bearer ${apiKey}`
  return headers
}

/** POST JSON and decode a JSON response, throwing on non-2xx. */
async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(endpoint(path), init)
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`request failed: ${response.status} ${text}`)
  }
  return (await response.json()) as T
}

/** POST JSON. */
async function postJson<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  return requestJson<T>(path, { method: 'POST', headers: authHeaders(headers), body: JSON.stringify(body) })
}

/** GET JSON. */
async function getJson<T>(path: string): Promise<T> {
  return requestJson<T>(path, { method: 'GET', headers: authHeaders() })
}

/** DELETE JSON. */
async function deleteJson<T>(path: string): Promise<T> {
  return requestJson<T>(path, { method: 'DELETE', headers: authHeaders() })
}

/**
 * Bootstrap a user via the engine. Requires the ADMIN_TOKEN, which is sent in
 * the `x-admin-token` header and never persisted by the frontend.
 */
export async function createUserWithKey(name: string, adminToken: string): Promise<{ apiKey: string }> {
  const data = await postJson<{ apiKey: string }>(
    '/api/users',
    { name },
    { 'x-admin-token': adminToken },
  )
  return data
}

/** Fetch the authenticated user's public profile. */
export async function fetchMe(): Promise<SafeUser> {
  return getJson<{ user: SafeUser }>('/api/users/me').then(data => data.user)
}

/** Rotate the authenticated user's API key. */
export async function rotateKey(): Promise<{ apiKey: string }> {
  return postJson<{ apiKey: string }>('/api/users/me/rotate-key', {})
}

/** Delete the authenticated user's account. */
export async function deleteMe(): Promise<void> {
  await deleteJson<{ ok: boolean }>('/api/users/me')
}

/** Create a new session. */
export async function createSession(title?: string): Promise<SessionRecord> {
  const data = await postJson<{ session: SessionRecord }>('/api/sessions', { title })
  return data.session
}

/** List sessions, newest first. */
export async function listSessions(): Promise<SessionRecord[]> {
  const data = await getJson<{ sessions: SessionRecord[] }>('/api/sessions')
  return data.sessions
}

/** Load the full message transcript for a session. */
export async function loadMessages(sessionId: string): Promise<ChatMessage[]> {
  const data = await getJson<{ messages: ChatMessage[] }>(`/api/sessions/${sessionId}/messages`)
  return data.messages
}

/**
 * Stream a chat turn via SSE. Resolves when the stream ends (done or error).
 * Throws on transport-level failures; engine errors arrive via `onError`.
 */
export async function streamChat(
  sessionId: string,
  prompt: string,
  handlers: SseHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(endpoint('/api/chat'), {
    method: 'POST',
    headers: authHeaders({ Accept: 'text/event-stream' }),
    body: JSON.stringify({ sessionId, prompt }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`chat request failed: ${response.status} ${text}`)
  }
  if (response.body === null) throw new Error('chat stream has no body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        handleFrame(frame, handlers)
      }
    }
    handlers.onDone?.()
  } catch (error: unknown) {
    if (signal?.aborted === true) {
      handlers.onDone?.()
      return
    }
    handlers.onError?.(error instanceof Error ? error.message : String(error))
  } finally {
    reader.releaseLock()
  }
}

/** Parse and dispatch a single SSE frame. */
function handleFrame(frame: string, handlers: SseHandlers): void {
  let event = 'message'
  let data = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (data.length === 0) return
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return
  }
  switch (event) {
    case 'text':
      if (handlers.onText !== undefined && isTextPayload(payload)) handlers.onText(payload.text)
      break
    case 'tool':
      if (handlers.onTool !== undefined) handlers.onTool(payload as ToolEvent)
      break
    case 'error':
      if (handlers.onError !== undefined && isErrorPayload(payload)) handlers.onError(payload.message)
      break
    case 'done':
      handlers.onDone?.()
      break
    default:
      break
  }
}

function isTextPayload(payload: unknown): payload is { text: string } {
  return payload !== null && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string'
}

function isErrorPayload(payload: unknown): payload is { message: string } {
  return payload !== null && typeof payload === 'object' && typeof (payload as { message?: unknown }).message === 'string'
}

/** Extract a renderable string from a stored content blob. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || typeof content !== 'object') return ''
  const record = content as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (typeof record.output === 'string') return record.output
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (part !== null && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
          return (part as Record<string, unknown>).text as string
        }
        return ''
      })
      .join('')
  }
  return JSON.stringify(content)
}
