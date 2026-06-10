// src/lib/messages.ts — persistence for chat conversations + messages.
//
// Model:
//   - A `Conversation` belongs to one (user, project) and holds an ordered
//     list of `Message`s.
//   - Each `Message` stores the full UIMessage as JSON in `content`. The
//     row's `id` mirrors the UIMessage `id`, so saves are idempotent.
//
// Ownership is always enforced by joining through the conversation's
// `(userId, projectId)`.

import type { UIMessage } from 'ai'
import { prisma } from '@/db'
import type { Prisma } from '@/generated/prisma/client'

// ---------- conversations ----------

export type ConversationSummary = {
  id: string
  title: string | null
  projectId: string
  createdAt: Date
  updatedAt: Date
}

/** List a user's conversations for a project, most-recent first. */
export async function listConversations(
  userId: string,
  projectId: string,
): Promise<ConversationSummary[]> {
  return await prisma.conversation.findMany({
    where: { userId, projectId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      title: true,
      projectId: true,
      createdAt: true,
      updatedAt: true,
    },
  })
}

/**
 * Create a new conversation in (userId, projectId). Verifies the project
 * belongs to the user first.
 */
export async function createConversation(
  userId: string,
  projectId: string,
  title?: string | null,
): Promise<ConversationSummary> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  })
  if (!project) {
    throw new Error('project not found for this user')
  }
  return await prisma.conversation.create({
    data: { userId, projectId, title: title ?? null },
    select: {
      id: true,
      title: true,
      projectId: true,
      createdAt: true,
      updatedAt: true,
    },
  })
}

/** Rename a conversation (ownership-scoped). */
export async function renameConversation(
  userId: string,
  conversationId: string,
  title: string | null,
): Promise<void> {
  const result = await prisma.conversation.updateMany({
    where: { id: conversationId, userId },
    data: { title },
  })
  if (result.count === 0) {
    throw new Error('conversation not found for this user')
  }
}

/** Delete a conversation and all its messages (ownership-scoped). */
export async function deleteConversation(
  userId: string,
  conversationId: string,
): Promise<void> {
  // deleteMany returns count; we want a clean "not found" error if 0.
  const result = await prisma.conversation.deleteMany({
    where: { id: conversationId, userId },
  })
  if (result.count === 0) {
    throw new Error('conversation not found for this user')
  }
}

/**
 * Resolve a conversation's `(userId, projectId)`. Used by the chat route to
 * verify ownership in a single query before doing anything else.
 */
export async function getConversationContext(
  userId: string,
  conversationId: string,
): Promise<{ projectId: string } | null> {
  const c = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { projectId: true },
  })
  return c
}

// ---------- messages ----------

/**
 * Persist a single UIMessage in a conversation. Idempotent: re-saving the
 * same id will overwrite the content (useful for partial assistant
 * messages that get finalized later).
 *
 * Also bumps the conversation's `updatedAt` so the sidebar can sort by
 * recent activity.
 */
export async function saveMessage(
  userId: string,
  conversationId: string,
  message: UIMessage,
): Promise<void> {
  // Ownership guard.
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true, projectId: true },
  })
  if (!conv) {
    throw new Error('conversation not found for this user')
  }

  // UIMessage is plain JSON-serializable.
  const content = message as unknown as Prisma.InputJsonValue

  await prisma.$transaction([
    prisma.message.upsert({
      where: { id: message.id },
      create: {
        id: message.id,
        conversationId: conv.id,
        userId,
        projectId: conv.projectId,
        role: message.role,
        content,
      },
      update: {
        role: message.role,
        content,
      },
    }),
    // Touch the conversation so listConversations sorts it to the top.
    prisma.conversation.update({
      where: { id: conv.id },
      data: { updatedAt: new Date() },
    }),
  ])
}

/** Load all messages in a conversation, oldest-first, as UIMessage[]. */
export async function listMessages(
  userId: string,
  conversationId: string,
): Promise<UIMessage[]> {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true },
  })
  if (!conv) {
    throw new Error('conversation not found for this user')
  }

  const rows = await prisma.message.findMany({
    where: { conversationId: conv.id },
    orderBy: { createdAt: 'asc' },
    select: { content: true },
  })

  return rows.map((r) => r.content as unknown as UIMessage)
}

/**
 * Drop any persisted messages in this conversation whose ids are not in
 * `keepIds`. Used at the start of every chat request to make the DB match
 * the client's canonical state — this handles `regenerate` (which strips
 * the last assistant message) and any other client-side edits cleanly.
 */
export async function pruneMessagesNotIn(
  userId: string,
  conversationId: string,
  keepIds: string[],
): Promise<number> {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true },
  })
  if (!conv) {
    throw new Error('conversation not found for this user')
  }
  if (keepIds.length === 0) {
    const r = await prisma.message.deleteMany({
      where: { conversationId: conv.id },
    })
    return r.count
  }
  const result = await prisma.message.deleteMany({
    where: {
      conversationId: conv.id,
      id: { notIn: keepIds },
    },
  })
  return result.count
}
