/**
 * Tool contract shared by the engine router and the two adapter layers.
 * @module serverless-worker/types/tools
 */

import type { ToolCategory } from './agent.ts'

/** A normalized tool call the LLM issued. */
export interface ToolCall {
  readonly name: string
  readonly args: Record<string, unknown>
}

/** A registered tool available to the agent. */
export interface ToolDefinition {
  readonly name: string
  /** Which adapter category runs this tool. */
  readonly category: ToolCategory
  /** JSON Schema for the tool's arguments (sent to the LLM). */
  readonly inputSchema: Record<string, unknown>
  /** Short description for the LLM's function list. */
  readonly description: string
}

/** The runtime context an adapter needs to execute a tool. */
export interface AdapterContext {
  readonly sessionId: string
  /** A stable working directory inside the sandbox. */
  readonly cwd: string
}

/** The result of a tool execution. */
export interface ToolResult {
  readonly ok: boolean
  /** Rendered result text for the LLM loop. */
  readonly output: string
  /** Structured result for `event: tool` frames and persistence. */
  readonly detail: unknown
  readonly error?: string
}
