/**
 * Wire-level types shared by the worker engine, the SSE protocol, and the
 * Vercel frontend client. These are pure data contracts and are mirrored by
 * the frontend client; keep them in lockstep.
 * @module serverless-worker/types/agent
 */

/** Roles accepted in a persisted message and the chat transcript. */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** A single persisted chat message. */
export interface ChatMessage {
  readonly id: string
  readonly sessionId: string
  readonly role: MessageRole
  /** Structured payload (text, tool call, tool result) stored as JSONB. */
  readonly content: unknown
  readonly createdAt: string
}

/** A session's plugin configuration. */
export interface PluginConfig {
  readonly id: string
  readonly pluginName: string
  readonly config: unknown
  readonly updatedAt: string
}

/** Inbound SSE chat request body. */
export interface ChatRequest {
  /** The session to continue; when omitted, the engine creates a new one. */
  readonly sessionId?: string
  readonly prompt: string
  /** Optional explicit tool whitelist; when absent, all registered tools run. */
  readonly tools?: readonly string[]
  /** Optional system-prompt override for this request. */
  readonly systemPrompt?: string
}

/** Inbound history-fetch request. */
export interface HistoryRequest {
  readonly sessionId: string
  readonly before?: string
  readonly limit?: number
}

/** SSE event name emitted on the chat stream. */
export type SseEventName = 'text' | 'tool' | 'done' | 'error'

/** Structured payload for an `event: tool` frame. */
export interface ToolEvent {
  readonly name: string
  readonly args: unknown
  readonly result: unknown
  readonly error?: string
}

/** Structured payload for an `event: error` frame. */
export interface ErrorEvent {
  readonly code: string
  readonly message: string
}

/** The tool categories the engine can dispatch. */
export type ToolCategory = 'api' | 'shell' | 'file' | 'python'
