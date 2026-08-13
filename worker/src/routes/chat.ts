/**
 * Chat route: streams an agent turn over SSE.
 *
 * The turn emitter runs under Hono's `streamSSE`, whose third (error) handler
 * observes any throw from the emitter. `withSseStream` already writes an
 * `error` frame before re-throwing, and Hono closes the stream — so the client
 * always receives either a `done` or an `error` frame (guardrail 4).
 * @module serverless-worker/routes/chat
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { streamSSE } from 'hono/streaming'
import type { DbProvider } from '../db/index.ts'
import { runAgentTurn } from '../engine/agent.ts'
import { createSession } from '../repo/sessions.ts'
import { currentUserId } from '../auth/middleware.ts'
import { withSseStream } from '../sse.ts'
import type { AppEnv } from '../auth/middleware.ts'
import { chatRequestSchema } from '../validate.ts'

/** Build the chat sub-app. */
export function chatRoutes(dbProvider: DbProvider): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/chat', zValidator('json', chatRequestSchema), async c => {
    const body = c.req.valid('json')
    const userId = currentUserId(c)
    const db = dbProvider.get()

    let sessionId = body.sessionId
    if (sessionId === undefined) {
      const session = await createSession(db, userId)
      sessionId = session.id
    }

    c.header('Content-Type', 'text/event-stream; charset=utf-8')
    c.header('Cache-Control', 'no-cache, no-transform')
    c.header('Connection', 'keep-alive')
    c.header('Content-Encoding', 'Identity')

    return streamSSE(
      c,
      async stream => {
        await withSseStream(stream, async sink => {
          await runAgentTurn(
            { sessionId: sessionId as string, userId, prompt: body.prompt, tools: body.tools, systemPrompt: body.systemPrompt },
            db,
            c.env,
            sink,
          )
        })
      },
      async (error, stream) => {
        console.error('chat stream failed', error)
        // withSseStream already emitted an error frame; Hono will close here.
      },
    )
  })

  return app
}
