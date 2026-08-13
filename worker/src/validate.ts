/**
 * zod schemas for request and response validation. Hono's `zValidator`
 * parses every inbound payload against these before a handler runs, so
 * malformed or hostile bodies are rejected with a structured 400 rather than
 * crashing mid-stream.
 * @module serverless-worker/validate
 */

import { z } from 'zod'
import type { ChatRequest, HistoryRequest } from './types/agent.ts'

/** Schema for `POST /api/chat` bodies. */
export const chatRequestSchema = z.object({
  sessionId: z.string().uuid().optional(),
  prompt: z.string().min(1).max(64_000),
  tools: z.array(z.string().min(1).max(128)).max(64).optional(),
  systemPrompt: z.string().max(16_000).optional(),
}) satisfies z.ZodType<ChatRequest>

/** Schema for `GET /api/history` query params. */
export const historyRequestSchema = z.object({
  sessionId: z.string().uuid(),
  before: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
}) satisfies z.ZodType<HistoryRequest>

/** Schema for `POST /api/sessions` create body. */
export const createSessionSchema = z.object({
  title: z.string().max(200).optional(),
})

/** Schema for `POST /api/users` bootstrap body. */
export const createUserSchema = z.object({
  name: z.string().min(1).max(100),
})

/** The parsed shapes. */
export type ValidatedChat = z.infer<typeof chatRequestSchema>
export type ValidatedHistory = z.infer<typeof historyRequestSchema>
