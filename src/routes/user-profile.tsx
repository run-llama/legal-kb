import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useAuth } from '@workos-inc/authkit-react'
import { createServerFn } from '@tanstack/react-start'
import { upsertApiKeys, getDecryptedApiKeys } from '@/lib/apiKeys'
import z from 'zod'

export const Route = createFileRoute('/user-profile')({
  ssr: false,
  component: UserProfile,
})

const apiKeySchema = z
  .object({
    userId: z.string(),
    openaiKey: z.string().optional(),
    anthropicKey: z.string().optional(),
    llamacloudKey: z.string().optional(),
    llamacloudProjectId: z.string().optional(),
  })
  .refine(
    (data) =>
      data.openaiKey ||
      data.anthropicKey ||
      data.llamacloudKey ||
      data.llamacloudProjectId,
    {
      message: 'At least one of the required settings must be provided',
    },
  )

export const storeCredentials = createServerFn({
  method: 'POST',
})
  .validator((data: unknown) => apiKeySchema.parse(data))
  .handler(async ({ data }) => {
    await upsertApiKeys(data.userId, {
      openaiKey: data.openaiKey,
      anthropicKey: data.anthropicKey,
      llamacloudKey: data.llamacloudKey,
      llamacloudProjectId: data.llamacloudProjectId,
    })
    return { success: true }
  })

export const getCredentials = createServerFn({
  method: 'GET',
})
  .validator((data: unknown) => z.object({ userId: z.string() }).parse(data))
  .handler(async ({ data }) => {
    const keys = await getDecryptedApiKeys(data.userId)
    if (!keys) return null
    return keys
  })

type LLMProvider = 'openai' | 'anthropic'

type StoredSettings = {
  llamaCloudApiKey: string
  llamaCloudProjectId: string
  llmProvider: LLMProvider
  openaiApiKey: string
  anthropicApiKey: string
}

const STORAGE_KEY = 'legal-kb.settings'

const EMPTY_SETTINGS: StoredSettings = {
  llamaCloudApiKey: '',
  llamaCloudProjectId: '',
  llmProvider: 'openai',
  openaiApiKey: '',
  anthropicApiKey: '',
}

// Only the llmProvider UI preference is persisted locally; secrets live on the server.
function loadLocalPreference(): LLMProvider {
  if (typeof window === 'undefined') return 'openai'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return 'openai'
    const parsed = JSON.parse(raw) as Partial<StoredSettings>
    return parsed.llmProvider === 'anthropic' ? 'anthropic' : 'openai'
  } catch {
    return 'openai'
  }
}

function saveLocalPreference(provider: LLMProvider) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ llmProvider: provider }),
    )
  } catch {
    // ignore
  }
}

function UserProfile() {
  const { user, isLoading, signIn, signOut } = useAuth()
  const [settings, setSettings] = useState<StoredSettings>(EMPTY_SETTINGS)
  const [showSecrets, setShowSecrets] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [isLoadingKeys, setIsLoadingKeys] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    setIsLoadingKeys(true)
    setError(null)
    getCredentials({ data: { userId: user.id } })
      .then((keys) => {
        if (cancelled) return
        const provider = loadLocalPreference()
        setSettings({
          llamaCloudApiKey: keys?.llamacloudKey ?? '',
          llamaCloudProjectId: keys?.llamacloudProjectId ?? '',
          llmProvider: provider,
          openaiApiKey: keys?.openaiKey ?? '',
          anthropicApiKey: keys?.anthropicKey ?? '',
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.error('Failed to load credentials', err)
        setError(
          'Could not load saved credentials. You can still enter them again.',
        )
        setSettings((s) => ({ ...s, llmProvider: loadLocalPreference() }))
      })
      .finally(() => {
        if (!cancelled) setIsLoadingKeys(false)
      })
    return () => {
      cancelled = true
    }
  }, [user?.id])

  if (isLoading) {
    return (
      <main className="demo-page demo-center">
        <section className="demo-panel w-full max-w-md">
          <p className="demo-muted text-center">Loading...</p>
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
            Sign in to manage your profile and API keys.
          </p>
          <button onClick={() => signIn()} className="demo-button w-full">
            Sign In with AuthKit
          </button>
        </section>
      </main>
    )
  }

  const update = <T extends keyof StoredSettings>(
    key: T,
    value: StoredSettings[T],
  ) => setSettings((s) => ({ ...s, [key]: value }))

  const onSave = async (e: React.SubmitEvent) => {
    e.preventDefault()
    if (!user.id) return

    // For the provider not currently selected, drop its key from the payload
    // so we don't accidentally persist a stale value the user can't see.
    const openaiKey =
      settings.llmProvider === 'openai' ? settings.openaiApiKey.trim() : ''
    const anthropicKey =
      settings.llmProvider === 'anthropic'
        ? settings.anthropicApiKey.trim()
        : ''
    const llamacloudKey = settings.llamaCloudApiKey.trim()
    const llamacloudProjectId = settings.llamaCloudProjectId.trim()

    if (!openaiKey && !anthropicKey && !llamacloudKey && !llamacloudProjectId) {
      setError(
        'Provide at least one key or the LlamaParse Platform project ID.',
      )
      return
    }

    setIsSaving(true)
    setError(null)
    try {
      await storeCredentials({
        data: {
          userId: user.id,
          openaiKey: openaiKey || undefined,
          anthropicKey: anthropicKey || undefined,
          llamacloudKey: llamacloudKey || undefined,
          llamacloudProjectId: llamacloudProjectId || undefined,
        },
      })
      saveLocalPreference(settings.llmProvider)
      setSavedAt(Date.now())
    } catch (err: unknown) {
      console.error('Failed to save credentials', err)
      setError(
        err instanceof Error
          ? err.message
          : 'Could not save credentials. Please try again.',
      )
    } finally {
      setIsSaving(false)
    }
  }

  const onClearKeys = () => {
    if (
      !confirm(
        'Clear the key fields on this page? (You still need to press Save to remove them from the server.)',
      )
    )
      return
    setSettings((s) => ({
      ...EMPTY_SETTINGS,
      llmProvider: s.llmProvider,
    }))
    setSavedAt(null)
  }

  const inputType = showSecrets ? 'text' : 'password'

  return (
    <main className="page-wrap px-4 py-12">
      <section className="island-shell rounded-2xl p-6 sm:p-8 mb-6">
        <p className="island-kicker mb-2">Profile</p>
        <h1 className="display-title mb-6 text-3xl font-bold text-[var(--sea-ink)]">
          Your legal-kb account
        </h1>

        <div className="flex flex-col sm:flex-row sm:items-center gap-6">
          {user.profilePictureUrl && (
            <img
              src={user.profilePictureUrl}
              alt={`Avatar of ${user.firstName} ${user.lastName}`}
              className="h-20 w-20 rounded-full border border-[var(--line)] shadow-lg"
            />
          )}
          <div className="grid gap-2 flex-1 grid-cols-1 sm:grid-cols-2">
            <div className="demo-list-item">
              <label className="demo-muted block text-xs font-medium mb-1">
                Name
              </label>
              <p className="m-0 text-sm">
                {[user.firstName, user.lastName].filter(Boolean).join(' ') ||
                  'N/A'}
              </p>
            </div>
            <div className="demo-list-item">
              <label className="demo-muted block text-xs font-medium mb-1">
                Email
              </label>
              <p className="m-0 break-all text-sm">{user.email || 'N/A'}</p>
            </div>
            <div className="demo-list-item sm:col-span-2">
              <label className="demo-muted block text-xs font-medium mb-1">
                User ID
              </label>
              <p className="demo-muted m-0 break-all font-mono text-xs">
                {user.id}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-6">
          <button onClick={() => signOut()} className="demo-button">
            Sign Out
          </button>
        </div>
      </section>

      <form onSubmit={onSave} className="island-shell rounded-2xl p-6 sm:p-8">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <p className="island-kicker mb-1">API Keys</p>
            <h2 className="text-2xl font-bold text-[var(--sea-ink)] m-0">
              Connect your providers
            </h2>
            <p className="demo-muted m-0 mt-1 text-sm max-w-2xl">
              Encrypted and stored against your account. Only your selected LLM
              provider's key is persisted.
            </p>
            {isLoadingKeys && (
              <p className="demo-muted m-0 mt-1 text-xs">Loading saved keys…</p>
            )}
            {error && <p className="m-0 mt-1 text-xs text-red-500">{error}</p>}
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--sea-ink-soft)]">
            <input
              type="checkbox"
              checked={showSecrets}
              onChange={(e) => setShowSecrets(e.target.checked)}
            />
            Show values
          </label>
        </div>

        <fieldset className="border border-[var(--line)] rounded-xl p-4 sm:p-5 mb-5">
          <legend className="px-2 text-sm font-semibold text-[var(--sea-ink)]">
            LlamaParse Platform
          </legend>
          <div className="grid gap-4">
            <div>
              <label className="demo-muted block text-xs font-medium mb-1">
                LlamaParse Platform API key
              </label>
              <input
                type={inputType}
                value={settings.llamaCloudApiKey}
                onChange={(e) => update('llamaCloudApiKey', e.target.value)}
                placeholder="llx-..."
                className="w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2 text-sm font-mono"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div>
              <label className="demo-muted block text-xs font-medium mb-1">
                LlamaParse Platform project ID
              </label>
              <input
                type="text"
                value={settings.llamaCloudProjectId}
                onChange={(e) => update('llamaCloudProjectId', e.target.value)}
                placeholder="e.g. 11111111-2222-3333-4444-555555555555"
                className="w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2 text-sm font-mono"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="border border-[var(--line)] rounded-xl p-4 sm:p-5 mb-5">
          <legend className="px-2 text-sm font-semibold text-[var(--sea-ink)]">
            LLM provider
          </legend>

          <div className="flex flex-wrap gap-3 mb-4">
            {(['openai', 'anthropic'] as const).map((p) => (
              <label
                key={p}
                className={`cursor-pointer rounded-full border px-4 py-2 text-sm font-semibold transition ${
                  settings.llmProvider === p
                    ? 'border-[rgba(50,143,151,0.4)] bg-[rgba(79,184,178,0.18)] text-[var(--lagoon-deep)]'
                    : 'border-[var(--line)] text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]'
                }`}
              >
                <input
                  type="radio"
                  name="llmProvider"
                  value={p}
                  checked={settings.llmProvider === p}
                  onChange={() => update('llmProvider', p)}
                  className="sr-only"
                />
                {p === 'openai' ? 'OpenAI' : 'Anthropic'}
              </label>
            ))}
          </div>

          <div className="grid gap-4">
            <div>
              <label className="demo-muted block text-xs font-medium mb-1">
                OpenAI API key
              </label>
              <input
                type={inputType}
                value={settings.openaiApiKey}
                onChange={(e) => update('openaiApiKey', e.target.value)}
                placeholder="sk-..."
                className="w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2 text-sm font-mono"
                autoComplete="off"
                spellCheck={false}
                disabled={settings.llmProvider !== 'openai'}
              />
            </div>
            <div>
              <label className="demo-muted block text-xs font-medium mb-1">
                Anthropic API key
              </label>
              <input
                type={inputType}
                value={settings.anthropicApiKey}
                onChange={(e) => update('anthropicApiKey', e.target.value)}
                placeholder="sk-ant-..."
                className="w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2 text-sm font-mono"
                autoComplete="off"
                spellCheck={false}
                disabled={settings.llmProvider !== 'anthropic'}
              />
            </div>
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="demo-button"
            disabled={isSaving || isLoadingKeys}
          >
            {isSaving ? 'Saving…' : 'Save settings'}
          </button>
          <button
            type="button"
            onClick={onClearKeys}
            disabled={isSaving}
            className="rounded-full border border-[var(--line)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)] disabled:opacity-50"
          >
            Clear fields
          </button>
          {savedAt && !error && (
            <span className="text-sm text-[var(--sea-ink-soft)]">
              Saved · {new Date(savedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      </form>
    </main>
  )
}
