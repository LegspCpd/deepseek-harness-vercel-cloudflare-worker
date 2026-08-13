/**
 * Server-Sent Events (SSE) helpers.
 *
 * The engine streams a chat turn as a single `text/event-stream` response. Two
 * backends are provided:
 *  - `toSseSink(stream)` adapts a Hono `StreamSSE` to the engine's `SseSink`.
 *  - `withSse(controller, emit)` is the raw ReadableStream fallback.
 *
 * Both guarantee an `event: error` frame plus closure on failure, so the
 * client never hangs on a dangling connection (guardrail 4).
 * @module serverless-worker/sse
 */

import type { SSEStreamingApi } from 'hono/streaming'
import type { ErrorEvent, ToolEvent } from './types/agent.ts'

/** The sink a turn emitter writes frames to. */
export interface SseSink {
  /** Write a text token frame. */
  text(text: string): Promise<void>
  /** Write a tool lifecycle frame. */
  tool(tool: ToolEvent): Promise<void>
}

/** An emitter drives a turn by writing to a sink. */
export type TurnEmitter = (sink: SseSink) => Promise<void>

/** Build an SSE error payload. */
export function errorEvent(message: string, code = 'SSE_STREAM_ERROR'): ErrorEvent {
  return { code, message }
}

/**
 * Adapt a Hono `StreamSSE` to the engine `SseSink`. The emitter runs inside;
 * any throw writes an `error` frame (and the stream closes via Hono).
 * @param stream - The Hono SSE stream to write to.
 * @param emit - Async turn body that writes text/tool frames.
 */
export async function withSseStream(stream: SSEStreamingApi, emit: TurnEmitter): Promise<void> {
  const sink: SseSink = {
    async text(text: string): Promise<void> {
      await stream.writeSSE({ event: 'text', data: JSON.stringify({ text }) })
    },
    async tool(tool: ToolEvent): Promise<void> {
      await stream.writeSSE({ event: 'tool', data: JSON.stringify(tool) })
    },
  }
  try {
    await emit(sink)
    await stream.writeSSE({ event: 'done', data: JSON.stringify({ ok: true }) })
  } catch (error: unknown) {
    const payload = errorEvent(error instanceof Error ? error.message : String(error))
    // Best-effort error frame before Hono closes the stream on this throw.
    try {
      await stream.writeSSE({ event: 'error', data: JSON.stringify(payload) })
    } catch (_writeFailed) {
      // The stream already aborted (client gone); nothing more to flush.
    }
    // Re-throw so Hono's streamSSE error handler also observes the failure.
    throw error
  }
}

/**
 * Drive a turn emitter against a raw ReadableStream controller, guaranteeing
 * an `error` frame and closure on failure.
 * @param controller - The ReadableStream controller for the SSE response.
 * @param emit - Async turn body that writes text/tool frames.
 */
export async function withSse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  emit: TurnEmitter,
): Promise<void> {
  const ENCODER = new TextEncoder()
  const frame = (event: string, data: string): Uint8Array =>
    ENCODER.encode(`event: ${event}\ndata: ${data}\n\n`)
  const sink: SseSink = {
    async text(text: string): Promise<void> {
      controller.enqueue(frame('text', JSON.stringify({ text })))
    },
    async tool(tool: ToolEvent): Promise<void> {
      controller.enqueue(frame('tool', JSON.stringify(tool)))
    },
  }
  try {
    await emit(sink)
    controller.enqueue(frame('done', JSON.stringify({ ok: true })))
  } catch (error: unknown) {
    const payload = errorEvent(error instanceof Error ? error.message : String(error))
    controller.enqueue(frame('error', JSON.stringify(payload)))
  } finally {
    try {
      controller.close()
    } catch (_alreadyClosed) {
      // The peer disconnected; nothing more to flush.
    }
  }
}
