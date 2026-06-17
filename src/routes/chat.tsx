// Chat page: project picker + conversation sidebar + model picker + agent
// chat backed by /api/chat.
//
// Hierarchy:
//   project -> N conversations -> N messages
// `useChat` is instantiated per conversation (via key={conversationId}) so
// switching threads gives a fully clean slate.
//
// The transport's `body` is a function (Resolvable) so model selection is
// read fresh on every send instead of being baked in at hook init.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useAuth } from '@workos-inc/authkit-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, isToolUIPart } from 'ai'
import type { UIMessage, UIMessagePart, UIDataTypes, UITools } from 'ai'
import { Streamdown } from 'streamdown'
import { z } from 'zod'
import type { ConversationSummary } from '@/lib/messages'
import type { IndexedCitation } from '@/lib/citations'
import {
  collectCitationsFromMessage,
  isCiteMarker,
  parseCiteMarker,
} from '@/lib/citations'
import { CiteChip } from '@/components/CiteChip'
import {
  createConversation,
  deleteConversation,
  listConversations,
  listMessages,
  renameConversation,
} from '@/lib/messages'
import { listProjectsFn } from './projects'
import { getCredentials } from './user-profile'

// ---------- server fns ----------
//
// TODO: derive userId from the WorkOS session on the server instead of
// trusting the client. Same pattern as projects/files for now.

const listConversationsFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) =>
    z.object({ userId: z.string(), projectId: z.string() }).parse(data),
  )
  .handler(async ({ data }) => {
    return await listConversations(data.userId, data.projectId)
  })

const createConversationFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) =>
    z
      .object({
        userId: z.string(),
        projectId: z.string(),
        title: z.string().nullable().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    return await createConversation(data.userId, data.projectId, data.title)
  })

const renameConversationFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) =>
    z
      .object({
        userId: z.string(),
        conversationId: z.string(),
        title: z.string().nullable(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    await renameConversation(data.userId, data.conversationId, data.title)
    return { ok: true as const }
  })

const deleteConversationFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) =>
    z.object({ userId: z.string(), conversationId: z.string() }).parse(data),
  )
  .handler(async ({ data }) => {
    await deleteConversation(data.userId, data.conversationId)
    return { ok: true as const }
  })

const listMessagesFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) =>
    z.object({ userId: z.string(), conversationId: z.string() }).parse(data),
  )
  .handler(async ({ data }) => {
    // UIMessage's `metadata: unknown` defeats TanStack Start's serialization
    // type-check, but the value itself round-trips through JSON cleanly.
    // Serialize to a string and parse on the client.
    const messages = await listMessages(data.userId, data.conversationId)
    return JSON.stringify(messages)
  })

export const Route = createFileRoute('/chat')({
  ssr: false,
  component: Chat,
})

// ---------- available models ----------
// Edit this list to expose/hide models. The prefix decides which provider
// key is required and which @ai-sdk/* package is used in src/lib/agent.ts.

type ModelOption = {
  id: string // sent to /api/chat — what `modelToProvider` parses
  label: string
  provider: 'openai' | 'anthropic'
}

const MODELS: ModelOption[] = [
  // OpenAI
  { id: 'openai/gpt-5.1', label: 'GPT-5.1', provider: 'openai' },
  { id: 'openai/gpt-5-2', label: 'GPT-5.2', provider: 'openai' },
  { id: 'openai/gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'openai' },
  { id: 'openai/gpt-5.4', label: 'GPT-5.4', provider: 'openai' },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5', provider: 'openai' },
  // Anthropic
  {
    id: 'anthropic/claude-opus-4-8',
    label: 'Claude Opus 4.8',
    provider: 'anthropic',
  },
  {
    id: 'anthropic/claude-opus-4-7',
    label: 'Claude Opus 4.7',
    provider: 'anthropic',
  },
  {
    id: 'anthropic/claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    provider: 'anthropic',
  },
  {
    id: 'anthropic/claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    provider: 'anthropic',
  },
]

const DEFAULT_MODEL_ID = MODELS[0].id

// ---------- component ----------

function Chat() {
  const { user, isLoading, signIn } = useAuth()

  if (isLoading) {
    return (
      <main className="demo-page demo-center">
        <section className="demo-panel w-full max-w-md">
          <p className="demo-muted text-center">Loading…</p>
        </section>
      </main>
    )
  }

  if (!user) {
    return (
      <main className="demo-page demo-center">
        <section className="demo-panel w-full max-w-md">
          <p className="island-kicker mb-2 text-center">legal-kb</p>
          <h1 className="demo-title mb-6 text-center">Sign in required</h1>
          <p className="demo-muted text-center mb-6">
            Sign in to chat with your projects.
          </p>
          <button onClick={() => signIn()} className="demo-button w-full">
            Sign In with AuthKit
          </button>
        </section>
      </main>
    )
  }

  return <ChatAuthed userId={user.id} />
}

function ChatAuthed({ userId }: { userId: string }) {
  const queryClient = useQueryClient()
  const [projectId, setProjectId] = useState<string>('')
  const [conversationId, setConversationId] = useState<string>('')
  const [modelId, setModelId] = useState<string>(DEFAULT_MODEL_ID)

  const { data: projects, isLoading: isLoadingProjects } = useQuery({
    queryKey: ['projects', userId],
    queryFn: () => listProjectsFn({ data: { userId } }),
  })

  const { data: credentials, isLoading: isLoadingCredentials } = useQuery({
    queryKey: ['credentials', userId],
    queryFn: () => getCredentials({ data: { userId } }),
  })

  const hasLlamaCloud = Boolean(
    credentials?.llamacloudKey && credentials.llamacloudProjectId,
  )

  // Default the project selection to the first one once loaded.
  useEffect(() => {
    if (!projectId && projects && projects.length > 0) {
      setProjectId(projects[0].id)
    }
  }, [projects, projectId])

  // Conversations for the selected project.
  const conversationsQuery = useQuery({
    queryKey: ['conversations', userId, projectId],
    queryFn: () => listConversationsFn({ data: { userId, projectId } }),
    enabled: !!projectId,
  })
  const conversations = conversationsQuery.data

  // When the project changes (or conversations load), make sure the current
  // selection is still valid; otherwise pick the first one.
  useEffect(() => {
    if (!conversations) return
    if (conversationId && conversations.some((c) => c.id === conversationId)) {
      return
    }
    setConversationId(conversations[0]?.id ?? '')
  }, [conversations, conversationId])

  // Reset the conversation selection eagerly on project switch so we don't
  // briefly show a stale thread from the previous project.
  useEffect(() => {
    setConversationId('')
  }, [projectId])

  const onNewConversation = async () => {
    if (!projectId) return
    try {
      const c = await createConversationFn({
        data: { userId, projectId, title: null },
      })
      // Optimistically prepend to the cache and select it.
      queryClient.setQueryData<ConversationSummary[]>(
        ['conversations', userId, projectId],
        (prev) => [c, ...(prev ?? [])],
      )
      setConversationId(c.id)
    } catch (err) {
      console.error('failed to create conversation:', err)
      alert(
        err instanceof Error ? err.message : 'Failed to create conversation',
      )
    }
  }

  const onRenameConversation = async (c: ConversationSummary) => {
    const next = prompt('Rename conversation', c.title ?? '')
    if (next === null) return // cancelled
    const title = next.trim() === '' ? null : next.trim()
    try {
      await renameConversationFn({
        data: { userId, conversationId: c.id, title },
      })
      queryClient.setQueryData<ConversationSummary[]>(
        ['conversations', userId, projectId],
        (prev) =>
          (prev ?? []).map((row) =>
            row.id === c.id ? { ...row, title } : row,
          ),
      )
    } catch (err) {
      console.error('failed to rename conversation:', err)
      alert(err instanceof Error ? err.message : 'Failed to rename')
    }
  }

  const onDeleteConversation = async (c: ConversationSummary) => {
    if (
      !confirm(
        `Delete “${c.title ?? 'Untitled conversation'}”? This cannot be undone.`,
      )
    ) {
      return
    }
    try {
      await deleteConversationFn({
        data: { userId, conversationId: c.id },
      })
      queryClient.setQueryData<ConversationSummary[]>(
        ['conversations', userId, projectId],
        (prev) => (prev ?? []).filter((row) => row.id !== c.id),
      )
      // Drop the cached message history for that conversation.
      queryClient.removeQueries({
        queryKey: ['messages', userId, c.id],
      })
      if (conversationId === c.id) {
        setConversationId('')
      }
    } catch (err) {
      console.error('failed to delete conversation:', err)
      alert(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  const selectedModel = MODELS.find((m) => m.id === modelId) ?? MODELS[0]
  const providerKeyMissing =
    selectedModel.provider === 'openai'
      ? !credentials?.openaiKey
      : !credentials?.anthropicKey

  return (
    <main className="page-wrap flex flex-col px-4 pt-4 pb-0 gap-4 max-w-[1400px] mx-auto h-[calc(100vh-72px)]">
      {/* Header */}
      <section className="island-shell rounded-2xl p-5 sm:p-6">
        <p className="island-kicker mb-2">Chat</p>
        <h1 className="display-title m-0 text-2xl font-bold text-[var(--sea-ink)]">
          Agent chat
        </h1>
        <p className="m-0 mt-1 text-sm text-[var(--sea-ink-soft)]">
          The agent can retrieve, find, read, and grep across the files in the
          selected project.
        </p>
      </section>

      {/* Credential warning */}
      {!isLoadingCredentials && !hasLlamaCloud && (
        <section className="island-shell rounded-2xl p-5 border border-[rgba(255,170,0,0.35)] bg-[rgba(255,170,0,0.08)]">
          <p className="island-kicker mb-1">Heads up</p>
          <h2 className="text-base font-semibold text-[var(--sea-ink)] m-0 mb-1">
            Configure your LlamaCloud credentials first
          </h2>
          <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
            Add your LlamaCloud key and project ID on the{' '}
            <Link
              to="/user-profile"
              className="font-semibold text-[var(--lagoon-deep)] underline underline-offset-2"
            >
              profile page
            </Link>
            .
          </p>
        </section>
      )}

      {/* Pickers */}
      <section className="island-shell rounded-2xl p-5 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="demo-muted block text-xs font-medium mb-1">
            Project
          </label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2 text-sm"
            disabled={isLoadingProjects || !projects || projects.length === 0}
          >
            {isLoadingProjects && <option>Loading…</option>}
            {!isLoadingProjects && projects && projects.length === 0 && (
              <option value="">No projects yet</option>
            )}
            {projects?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {!isLoadingProjects && projects && projects.length === 0 && (
            <p className="m-0 mt-1 text-xs text-[var(--sea-ink-soft)]">
              <Link
                to="/projects"
                className="underline underline-offset-2 font-semibold text-[var(--lagoon-deep)]"
              >
                Create one
              </Link>{' '}
              to get started.
            </p>
          )}
        </div>
        <div>
          <label className="demo-muted block text-xs font-medium mb-1">
            Model
          </label>
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className="w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2 text-sm"
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {providerKeyMissing && (
            <p className="m-0 mt-1 text-xs text-amber-700">
              No {selectedModel.provider} key configured.{' '}
              <Link
                to="/user-profile"
                className="underline underline-offset-2 font-semibold"
              >
                Add one
              </Link>
              .
            </p>
          )}
        </div>
      </section>

      {/* Conversation sidebar + chat panel. */}
      {projectId ? (
        <section className="grid gap-4 md:grid-cols-[280px_1fr] items-stretch flex-1 min-h-0">
          <ConversationSidebar
            conversations={conversations}
            isLoading={conversationsQuery.isLoading}
            isError={conversationsQuery.isError}
            activeId={conversationId}
            onSelect={setConversationId}
            onNew={onNewConversation}
            onRename={onRenameConversation}
            onDelete={onDeleteConversation}
          />
          {conversationId ? (
            <ChatPanel
              key={conversationId}
              userId={userId}
              conversationId={conversationId}
              modelId={modelId}
              hasLlamaCloud={hasLlamaCloud}
              providerKeyMissing={providerKeyMissing}
              selectedProvider={selectedModel.provider}
              chipUserId={userId}
            />
          ) : (
            <div className="island-shell rounded-2xl p-5 min-h-[40vh] flex items-center justify-center">
              <div className="text-center max-w-sm">
                <p className="demo-muted text-sm m-0 mb-3">
                  {conversationsQuery.isLoading
                    ? 'Loading conversations…'
                    : 'No conversation selected.'}
                </p>
                {!conversationsQuery.isLoading && (
                  <button
                    type="button"
                    onClick={onNewConversation}
                    className="demo-button"
                  >
                    Start a new conversation
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      ) : (
        <section className="island-shell rounded-2xl p-5 min-h-[40vh]">
          <p className="demo-muted text-sm m-0">
            {isLoadingProjects
              ? 'Loading projects…'
              : projects && projects.length === 0
                ? 'Create a project to start chatting.'
                : 'Pick a project to start chatting.'}
          </p>
        </section>
      )}
    </main>
  )
}

// ---------- conversation sidebar ----------

function ConversationSidebar({
  conversations,
  isLoading,
  isError,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  conversations: ConversationSummary[] | undefined
  isLoading: boolean
  isError: boolean
  activeId: string
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (c: ConversationSummary) => void
  onDelete: (c: ConversationSummary) => void
}) {
  return (
    <aside className="island-shell rounded-2xl p-3 flex flex-col gap-2 h-full overflow-hidden">
      <div className="flex items-center justify-between px-2 pt-1">
        <p className="island-kicker m-0">Conversations</p>
        <button
          type="button"
          onClick={onNew}
          className="text-xs rounded-full border border-[var(--line)] px-2.5 py-1 hover:bg-[var(--line)]/40"
          title="New conversation"
        >
          + New
        </button>
      </div>
      {isLoading && <p className="demo-muted text-xs px-2">Loading…</p>}
      {isError && (
        <p className="text-xs text-red-500 px-2">
          Failed to load conversations.
        </p>
      )}
      {!isLoading &&
        !isError &&
        conversations &&
        conversations.length === 0 && (
          <p className="demo-muted text-xs px-2">
            No conversations yet. Click <strong>+ New</strong> to start one.
          </p>
        )}
      <ul className="m-0 list-none p-0 grid gap-1 overflow-y-auto">
        {conversations?.map((c) => {
          const active = c.id === activeId
          return (
            <li key={c.id}>
              <div
                className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm cursor-pointer ${
                  active ? 'bg-[var(--line)]/60' : 'hover:bg-[var(--line)]/30'
                }`}
                onClick={() => onSelect(c.id)}
              >
                <span className="flex-1 truncate text-[var(--sea-ink)]">
                  {c.title ?? 'Untitled conversation'}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRename(c)
                  }}
                  className="opacity-0 group-hover:opacity-100 text-[10px] rounded border border-[var(--line)] px-1.5 py-0.5 hover:bg-[var(--line)]/40"
                  title="Rename"
                >
                  Rename
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(c)
                  }}
                  className="opacity-0 group-hover:opacity-100 text-[10px] rounded border border-[var(--line)] px-1.5 py-0.5 hover:bg-red-500/10 hover:text-red-500"
                  title="Delete"
                >
                  Delete
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

// ---------- chat panel ----------
//
// One instance of useChat lives here. Remounting (via `key={conversationId}`
// at the call site) resets the chat cleanly when switching threads.

function ChatPanel({
  userId,
  conversationId,
  modelId,
  hasLlamaCloud,
  providerKeyMissing,
  selectedProvider,
  chipUserId,
}: {
  userId: string
  conversationId: string
  modelId: string
  hasLlamaCloud: boolean
  providerKeyMissing: boolean
  selectedProvider: 'openai' | 'anthropic'
  /** Passed through to citation chips for proxied attachment fetches. */
  chipUserId: string
}) {
  // modelId lives in the parent. Refs let the transport read the latest
  // value at send-time without re-creating itself.
  const modelIdRef = useRef(modelId)
  useEffect(() => {
    modelIdRef.current = modelId
  }, [modelId])

  // 1. Load persisted history for this conversation. Server fn returns a
  //    JSON-encoded string (see listMessagesFn for why).
  const historyQuery = useQuery<UIMessage[]>({
    queryKey: ['messages', userId, conversationId],
    queryFn: async () => {
      const raw = await listMessagesFn({
        data: { userId, conversationId },
      })
      return JSON.parse(raw) as UIMessage[]
    },
  })

  // 2. Construct the transport once per (user, conversation) pair.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        body: () => ({
          userId,
          conversationId,
          model: modelIdRef.current,
        }),
      }),
    [userId, conversationId],
  )

  // 3. Show a loading placeholder until history has arrived; once it has,
  //    mount the inner component with that history as `initialMessages`.
  if (historyQuery.isLoading) {
    return (
      <section className="island-shell rounded-2xl p-5 min-h-[40vh]">
        <p className="demo-muted text-sm m-0">Loading conversation…</p>
      </section>
    )
  }
  if (historyQuery.isError) {
    return (
      <section className="island-shell rounded-2xl p-5 min-h-[40vh]">
        <p className="text-sm text-red-500 m-0">
          Failed to load conversation:{' '}
          {historyQuery.error instanceof Error
            ? historyQuery.error.message
            : 'unknown error'}
        </p>
      </section>
    )
  }

  return (
    <ChatPanelInner
      initialMessages={historyQuery.data ?? []}
      transport={transport}
      hasLlamaCloud={hasLlamaCloud}
      providerKeyMissing={providerKeyMissing}
      selectedProvider={selectedProvider}
      chipUserId={chipUserId}
    />
  )
}

function ChatPanelInner({
  initialMessages,
  transport,
  hasLlamaCloud,
  providerKeyMissing,
  selectedProvider,
  chipUserId,
}: {
  initialMessages: UIMessage[]
  transport: DefaultChatTransport<UIMessage>
  hasLlamaCloud: boolean
  providerKeyMissing: boolean
  selectedProvider: 'openai' | 'anthropic'
  chipUserId: string
}) {
  // useChat snapshots `messages` on first render only, so this component is
  // mounted with the loaded history in place. Subsequent assistant streams
  // are appended in-memory and persisted by the server's onFinish.
  const { messages, sendMessage, status, error, stop, regenerate, clearError } =
    useChat({ transport, messages: initialMessages })

  const isStreaming = status === 'streaming' || status === 'submitted'
  const canSend = hasLlamaCloud && !providerKeyMissing && !isStreaming

  const [input, setInput] = useState('')

  const onSubmit = (e: React.SubmitEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || !canSend) return
    setInput('')
    void sendMessage({ text })
  }

  // Wrap everything in a single flex column so the parent grid treats this
  // whole stack as one column item — otherwise the fragment's siblings
  // become independent grid children and the composer wraps under the
  // sidebar in row 2.
  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      <section className="island-shell rounded-2xl p-5 flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
        <div className="flex items-center justify-between gap-2">
          <p className="island-kicker m-0">
            {messages.length} message{messages.length === 1 ? '' : 's'}
          </p>
        </div>

        {messages.length === 0 ? (
          <p className="demo-muted text-sm m-0">
            Ask anything about the files in this project. The agent can run
            semantic retrieval, find/read files, and grep.
          </p>
        ) : (
          <ul className="m-0 list-none p-0 grid gap-3 overflow-y-auto flex-1">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} userId={chipUserId} />
            ))}
          </ul>
        )}

        {error && (
          <div className="mt-3 text-sm text-red-500 flex items-center gap-2 flex-wrap">
            <span>
              {error instanceof Error ? error.message : 'Something went wrong'}
            </span>
            <button
              type="button"
              onClick={() => {
                clearError()
                void regenerate()
              }}
              className="text-xs rounded-full border border-[var(--line)] px-3 py-1 hover:bg-[var(--line)]/40"
            >
              Retry
            </button>
          </div>
        )}
      </section>

      {/* Composer */}
      <form
        onSubmit={onSubmit}
        className="island-shell rounded-2xl p-4 flex items-end gap-3"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              // @ts-expect-error (ts 2345)
              onSubmit(e)
            }
          }}
          placeholder={
            !hasLlamaCloud
              ? 'Configure credentials to start chatting…'
              : providerKeyMissing
                ? `Add a ${selectedProvider} key to start chatting…`
                : 'Ask the agent about your files…'
          }
          rows={2}
          className="flex-1 rounded-lg border border-[var(--line)] bg-transparent px-3 py-2 text-sm resize-y min-h-[44px]"
          disabled={!canSend && !isStreaming}
        />
        {isStreaming ? (
          <button type="button" onClick={() => stop()} className="demo-button">
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="demo-button"
            disabled={!canSend || !input.trim()}
            title={
              !hasLlamaCloud
                ? 'Add LlamaCloud credentials first'
                : providerKeyMissing
                  ? `Add a ${selectedProvider} key first`
                  : undefined
            }
          >
            Send
          </button>
        )}
      </form>
    </div>
  )
}

// ---------- message rendering ----------

function MessageBubble({
  message,
  userId,
}: {
  message: UIMessage
  userId: string
}) {
  const isUser = message.role === 'user'
  // Harvest every citation emitted by retrieve tool calls in this message.
  // Computed once per message render so all parts (and the footer) share
  // the same id→index mapping.
  const citations = useMemo(
    () =>
      isUser
        ? new Map<string, IndexedCitation>()
        : collectCitationsFromMessage(message),
    [message, isUser],
  )
  return (
    <li
      className={`rounded-xl border border-[var(--line)] p-3 ${
        isUser ? 'bg-[var(--line)]/30' : ''
      }`}
    >
      <p className="island-kicker m-0 mb-2 text-[10px]">
        {isUser ? 'You' : 'Agent'}
      </p>
      <div className="grid gap-2">
        {message.parts.map((part, i) => (
          <MessagePart
            key={i}
            part={part}
            role={message.role}
            citations={citations}
            userId={userId}
          />
        ))}
      </div>
      {citations.size > 0 && (
        <CitationsFooter
          citations={Array.from(citations.values())}
          userId={userId}
        />
      )}
    </li>
  )
}

/**
 * Streamdown component override map. We hijack inline `<code>` to detect
 * citation tokens of the form `cite:<id>` and replace them with a chip.
 * Block code (inside ```fences```) is unaffected because Streamdown routes
 * those through a separate `code` component slot.
 */
function buildStreamdownComponents(
  citations: Map<string, IndexedCitation>,
  userId: string,
) {
  return {
    inlineCode: (props: { children?: React.ReactNode }) => {
      const text = extractText(props.children)
      if (text && isCiteMarker(text)) {
        const id = parseCiteMarker(text)!
        return <CiteChip citation={citations.get(id)} userId={userId} />
      }
      // Fall back to a normal <code> rendering. We keep this minimal
      // (no Streamdown chrome) because nested inline-code is rare and
      // hijacking the slot means we own the rendering.
      return (
        <code className="rounded bg-[var(--line)]/40 px-1 py-0.5 text-[0.9em] font-mono">
          {props.children}
        </code>
      )
    },
  }
}

/** Pull a flat string out of React children (handles strings + arrays). */
function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  return ''
}

function MessagePart({
  part,
  role,
  citations,
  userId,
}: {
  part: UIMessagePart<UIDataTypes, UITools>
  role: UIMessage['role']
  citations: Map<string, IndexedCitation>
  userId: string
}) {
  if (part.type === 'text') {
    // User text is rendered verbatim — they typed plain text and we don't
    // want `*foo*` becoming italic. Assistant text is markdown-rendered via
    // Streamdown, which handles partial/streaming markdown gracefully.
    if (role === 'user') {
      return (
        <p className="m-0 text-sm text-[var(--sea-ink)] whitespace-pre-wrap break-words">
          {part.text}
        </p>
      )
    }
    return (
      <div className="prose prose-sm max-w-none text-[var(--sea-ink)] prose-pre:bg-[var(--line)]/30 prose-pre:text-[var(--sea-ink)] prose-code:text-[var(--sea-ink)] prose-headings:text-[var(--sea-ink)] prose-strong:text-[var(--sea-ink)] prose-a:text-[var(--lagoon-deep)]">
        <Streamdown components={buildStreamdownComponents(citations, userId)}>
          {part.text}
        </Streamdown>
      </div>
    )
  }

  if (part.type === 'reasoning' && part.text.length > 0) {
    return (
      <details className="text-xs text-[var(--sea-ink-soft)]">
        <summary className="cursor-pointer">Reasoning</summary>
        <pre className="m-0 mt-1 whitespace-pre-wrap break-words font-mono">
          {part.text}
        </pre>
      </details>
    )
  }

  if (isToolUIPart(part)) {
    // Static tool name is encoded as `tool-${name}`; dynamic tools use 'dynamic-tool'.
    const toolName =
      part.type === 'dynamic-tool'
        ? ((part as { toolName?: string }).toolName ?? 'tool')
        : part.type.replace(/^tool-/, '')
    return (
      <div className="rounded-lg border border-[var(--line)] bg-[var(--line)]/20 p-2 text-xs">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-mono font-semibold text-[var(--sea-ink)]">
            {toolName}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-[var(--sea-ink-soft)]">
            {part.state}
          </span>
        </div>
        {'input' in part && part.input !== undefined ? (
          <pre className="m-0 mb-1 whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--sea-ink-soft)]">
            {JSON.stringify(part.input, null, 2)}
          </pre>
        ) : null}
        {'output' in part && part.output !== undefined ? (
          <details>
            <summary className="cursor-pointer text-[var(--sea-ink-soft)]">
              Output
            </summary>
            <pre className="m-0 mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">
              {typeof part.output === 'string'
                ? part.output
                : JSON.stringify(part.output, null, 2)}
            </pre>
          </details>
        ) : null}
        {'errorText' in part && part.errorText ? (
          <p className="m-0 mt-1 text-red-500">{part.errorText}</p>
        ) : null}
      </div>
    )
  }

  // step-start, source-*, file, data-* — render nothing for now.
  return null
}

/**
 * Compact list of every citation referenced in this assistant message,
 * shown beneath the message body. Each entry is itself a chip + label so
 * the user can click straight to the modal even if they don't notice the
 * inline marker.
 */
function CitationsFooter({
  citations,
  userId,
}: {
  citations: IndexedCitation[]
  userId: string
}) {
  return (
    <div className="mt-3 pt-3 border-t border-[var(--line)]">
      <p className="island-kicker m-0 mb-2 text-[10px]">Sources</p>
      <ul className="m-0 list-none p-0 grid gap-1.5">
        {citations.map((c) => (
          <li key={c.id} className="flex items-start gap-2 text-xs">
            <CiteChip citation={c} userId={userId} />
            <span className="text-[var(--sea-ink)] min-w-0 flex-1">
              <span className="font-medium truncate inline-block max-w-full align-bottom">
                {c.fileName || 'Unknown file'}
              </span>
              {c.pageStart != null && (
                <span className="text-[var(--sea-ink-soft)]">
                  {' · '}
                  {c.pageEnd && c.pageEnd !== c.pageStart
                    ? `p. ${c.pageStart}–${c.pageEnd}`
                    : `p. ${c.pageStart}`}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
