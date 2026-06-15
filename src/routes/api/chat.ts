// /api/chat — streams the legal-kb agent's responses as a UI message stream.
//
// Request body (JSON):
//   {
//     messages: UIMessage[],   // history from useChat
//     userId: string,          // WorkOS user id (TODO: derive server-side)
//     conversationId: string,  // which conversation (=> which project/index)
//     model: string,           // e.g. "openai/gpt-4o-mini" or "anthropic/..."
//   }
//
// We resolve the conversation -> project -> indexId, look up the user's
// decrypted API keys, build a fresh agent (cheap), and pipe the agent's
// UI message stream back as the Response. Persistence is handled around
// the stream (user msg before, assistant msg in onFinish).

import { createFileRoute } from '@tanstack/react-router'
import { createAgentUIStreamResponse } from 'ai'
import type { UIMessage } from 'ai'
import { buildAgent } from '@/lib/agent'
import { getDecryptedApiKeys } from '@/lib/apiKeys'
import {
  getConversationContext,
  pruneMessagesNotIn,
  saveMessage,
} from '@/lib/messages'
import { prisma } from '@/db'

type ChatBody = {
  messages: UIMessage[]
  userId: string
  conversationId: string
  model: string
}

function isChatBody(v: unknown): v is ChatBody {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    Array.isArray(o.messages) &&
    typeof o.userId === 'string' &&
    typeof o.conversationId === 'string' &&
    typeof o.model === 'string'
  )
}

export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: 'invalid JSON body' }, { status: 400 })
        }
        if (!isChatBody(body)) {
          return Response.json(
            {
              error:
                'missing/invalid fields: messages, userId, conversationId, model',
            },
            { status: 400 },
          )
        }
        const { messages, userId, conversationId, model } = body

        // 1. Resolve conversation -> project (ownership-scoped).
        const convCtx = await getConversationContext(userId, conversationId)
        if (!convCtx) {
          return Response.json(
            { error: 'conversation not found for this user' },
            { status: 404 },
          )
        }
        const { projectId } = convCtx

        // 2. Resolve the user's keys.
        const keys = await getDecryptedApiKeys(userId)
        if (!keys || !keys.llamacloudKey || !keys.llamacloudProjectId) {
          return Response.json(
            {
              error:
                'configure your LlamaCloud credentials on the profile page first',
            },
            { status: 400 },
          )
        }

        // 3. Validate model + provider key match.
        if (model.startsWith('openai/') && !keys.openaiKey) {
          return Response.json(
            { error: 'OpenAI API key missing. Add it on the profile page.' },
            { status: 400 },
          )
        }
        if (model.startsWith('anthropic/') && !keys.anthropicKey) {
          return Response.json(
            { error: 'Anthropic API key missing. Add it on the profile page.' },
            { status: 400 },
          )
        }

        // 4. Look up the project's indexId.
        const project = await prisma.project.findFirst({
          where: { id: projectId, userId },
          select: { indexId: true, name: true },
        })
        if (!project) {
          // Should never happen if convCtx resolved, but be defensive.
          return Response.json(
            { error: 'project not found for this user' },
            { status: 404 },
          )
        }

        // 5. Reconcile DB history with what the client sent, then save the
        //    trailing user message. The client's `messages` is the canonical
        //    state at request time — anything persisted but absent here
        //    (e.g. an assistant message about to be regenerated) is dropped.
        try {
          await pruneMessagesNotIn(
            userId,
            conversationId,
            messages.map((m) => m.id),
          )
          const lastMessage = messages[messages.length - 1]
          if (lastMessage.role === 'user') {
            await saveMessage(userId, conversationId, lastMessage)
          }
        } catch (err) {
          console.error('[chat] failed to save user message:', err)
          return Response.json(
            { error: 'failed to save message' },
            { status: 500 },
          )
        }

        // 6. Build the agent + stream.
        const agent = buildAgent(
          model,
          keys.llamacloudKey,
          keys.llamacloudProjectId,
          project.indexId,
          keys.openaiKey ?? undefined,
          keys.anthropicKey ?? undefined,
        )

        // `generateMessageId` is required for the assistant `responseMessage`
        // to get a stable, non-empty id. Without it the SDK leaves `id: ""`,
        // which collides with itself on every turn (same primary key) and
        // causes the row to be clobbered / pruned. We use crypto.randomUUID
        // so ids are guaranteed unique across conversations.
        return createAgentUIStreamResponse({
          agent,
          uiMessages: messages,
          generateMessageId: () => crypto.randomUUID(),
          onFinish: async ({ responseMessage, isAborted, finishReason }) => {
            // Defensive: if for any reason the id is still empty, mint one
            // here. saveMessage upserts by id, so an empty id would clobber
            // the previous assistant turn.
            if (!responseMessage.id) {
              responseMessage.id = crypto.randomUUID()
            }
            try {
              await saveMessage(userId, conversationId, responseMessage)
            } catch (err) {
              console.error('[chat] failed to save assistant message:', err)
            }
          },
          onError: (err) => {
            console.error('[chat] stream onError:', err)
            return err instanceof Error ? err.message : 'stream error'
          },
        })
      },
    },
  },
})
