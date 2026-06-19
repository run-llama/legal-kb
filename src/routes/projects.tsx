import { useEffect, useRef, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useAuth } from '@workos-inc/authkit-react'
import { createServerFn } from '@tanstack/react-start'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import z from 'zod'
import { createProject, deleteProject, getProjects } from '@/lib/projects'
import {
  detachFileFromProject,
  getIndexStatus,
  getProjectFiles,
  syncProjectIndex,
  uploadFile,
} from '@/lib/files'
import { getCredentials } from './user-profile'

export const Route = createFileRoute('/projects')({
  ssr: false,
  component: Projects,
})

// ---------- server fns ----------

const createProjectSchema = z.object({
  userId: z.string().min(1),
  name: z.string().min(1, 'Name is required').max(120, 'Name is too long'),
  description: z.string().max(500).optional(),
})

const deleteProjectSchema = z.object({
  userId: z.string().min(1),
  name: z.string().min(1),
  indexId: z.string().min(1),
})

const listProjectsSchema = z.object({ userId: z.string().min(1) })

export const createProjectFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => createProjectSchema.parse(data))
  .handler(async ({ data }) => {
    const project = await createProject({
      name: data.name,
      description: data.description,
      userId: data.userId,
    })
    return project
  })

export const deleteProjectFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => deleteProjectSchema.parse(data))
  .handler(async ({ data }) => {
    await deleteProject({
      userId: data.userId,
      name: data.name,
      indexId: data.indexId,
    })
    return { success: true }
  })

export const listProjectsFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => listProjectsSchema.parse(data))
  .handler(async ({ data }) => {
    return getProjects(data.userId)
  })

// ---------- file server fns ----------

// Upload uses FormData so we stream the file as multipart instead of
// inflating it 33% as base64.
export const uploadFileFn = createServerFn({ method: 'POST' })
  .validator((formData: unknown) => {
    if (!(formData instanceof FormData)) {
      throw new Error('expected multipart FormData')
    }
    const userId = formData.get('userId')
    const projectId = formData.get('projectId')
    const file = formData.get('file')
    if (typeof userId !== 'string' || !userId) {
      throw new Error('userId is required')
    }
    if (typeof projectId !== 'string' || !projectId) {
      throw new Error('projectId is required')
    }
    if (!(file instanceof File)) {
      throw new Error('file is required')
    }
    return { userId, projectId, file }
  })
  .handler(async ({ data }) => {
    const buf = Buffer.from(await data.file.arrayBuffer())
    const result = await uploadFile({
      userId: data.userId,
      projectId: data.projectId,
      name: data.file.name,
      mimeType: data.file.type || 'application/octet-stream',
      data: buf,
    })
    // Drop the Buffer from the response — not serializable / not needed.
    return { file: result.file, syncTriggered: result.syncTriggered }
  })

const listFilesSchema = z.object({
  userId: z.string().min(1),
  projectId: z.string().min(1),
})
export const listProjectFilesFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => listFilesSchema.parse(data))
  .handler(({ data }) => getProjectFiles(data.userId, data.projectId))

const detachFileSchema = z.object({
  userId: z.string().min(1),
  projectId: z.string().min(1),
  fileId: z.string().min(1),
})
export const detachFileFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => detachFileSchema.parse(data))
  .handler(({ data }) =>
    detachFileFromProject({
      userId: data.userId,
      projectId: data.projectId,
      fileId: data.fileId,
    }),
  )

const syncProjectSchema = z.object({
  userId: z.string().min(1),
  projectId: z.string().min(1),
})
export const syncProjectFn = createServerFn({ method: 'POST' })
  .validator((data: unknown) => syncProjectSchema.parse(data))
  .handler(({ data }) => syncProjectIndex(data.userId, data.projectId))

export const indexStatusFn = createServerFn({ method: 'GET' })
  .validator((data: unknown) => syncProjectSchema.parse(data))
  .handler(({ data }) => getIndexStatus(data.userId, data.projectId))

// ---------- types ----------

type ProjectRow = Awaited<ReturnType<typeof listProjectsFn>>[number]
type FileRow = Awaited<ReturnType<typeof listProjectFilesFn>>[number]

// ---------- component ----------

function Projects() {
  const { user, isLoading, signIn } = useAuth()

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
            Sign in to view and manage your projects.
          </p>
          <button onClick={() => signIn()} className="demo-button w-full">
            Sign In with AuthKit
          </button>
        </section>
      </main>
    )
  }

  return <ProjectsAuthed userId={user.id} />
}

function ProjectsAuthed({ userId }: { userId: string }) {
  const queryClient = useQueryClient()
  const projectsKey = ['projects', userId] as const

  const { data: credentials, isLoading: isLoadingCredentials } = useQuery({
    queryKey: ['credentials', userId],
    queryFn: () => getCredentials({ data: { userId } }),
  })

  const hasLlamaCloudCreds = Boolean(
    credentials?.llamacloudKey && credentials.llamacloudProjectId,
  )

  const {
    data: projects,
    isLoading,
    error,
  } = useQuery({
    queryKey: projectsKey,
    queryFn: () => listProjectsFn({ data: { userId } }),
  })

  const createMut = useMutation({
    mutationFn: (vars: { name: string; description?: string }) =>
      createProjectFn({
        data: {
          userId,
          name: vars.name,
          description: vars.description,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsKey })
    },
  })

  const deleteMut = useMutation({
    mutationFn: (vars: { name: string; indexId: string }) =>
      deleteProjectFn({
        data: {
          userId,
          name: vars.name,
          indexId: vars.indexId,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsKey })
    },
  })

  return (
    <main className="page-wrap px-4 py-12 space-y-6">
      <section className="island-shell rounded-2xl p-6 sm:p-8">
        <p className="island-kicker mb-2">Projects</p>
        <h1 className="display-title mb-3 text-3xl font-bold text-[var(--sea-ink)]">
          Your projects
        </h1>
        <p className="m-0 max-w-2xl text-sm text-[var(--sea-ink-soft)]">
          Each project is mirrored 1:1 by an Index v2 in your LlamaCloud
          account. Creating one provisions both the source directory and the
          index; deleting one tears them down.
        </p>
      </section>

      {!isLoadingCredentials && !hasLlamaCloudCreds && (
        <section className="island-shell rounded-2xl p-5 sm:p-6 border border-[rgba(255,170,0,0.35)] bg-[rgba(255,170,0,0.08)]">
          <p className="island-kicker mb-1">Heads up</p>
          <h2 className="text-lg font-semibold text-[var(--sea-ink)] m-0 mb-1">
            Configure your LlamaCloud credentials first
          </h2>
          <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
            You need a LlamaCloud API key and project ID before you can create
            projects.{' '}
            <Link
              to="/user-profile"
              className="font-semibold text-[var(--lagoon-deep)] underline underline-offset-2"
            >
              Add them on your profile
            </Link>
            .
          </p>
        </section>
      )}

      <CreateProjectForm
        onCreate={(vars) => createMut.mutateAsync(vars)}
        isSubmitting={createMut.isPending}
        error={createMut.error}
        disabled={!hasLlamaCloudCreds}
        disabledReason={
          isLoadingCredentials
            ? 'Checking credentials…'
            : 'Add your LlamaCloud key and project ID on the profile page to enable this.'
        }
      />

      <section className="island-shell rounded-2xl p-6 sm:p-8">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <h2 className="text-xl font-bold text-[var(--sea-ink)] m-0">
            All projects
          </h2>
          {isLoading && (
            <span className="text-sm text-[var(--sea-ink-soft)]">Loading…</span>
          )}
        </div>

        {error && (
          <p className="m-0 text-sm text-red-500">
            Failed to load projects:{' '}
            {error instanceof Error ? error.message : 'Unknown error'}
          </p>
        )}

        {!isLoading && !error && projects && projects.length === 0 && (
          <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
            No projects yet. Create your first one above.
          </p>
        )}

        {projects && projects.length > 0 && (
          <ul className="m-0 list-none p-0 grid gap-3">
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                userId={userId}
                project={p}
                onDelete={() =>
                  deleteMut.mutateAsync({ name: p.name, indexId: p.indexId })
                }
                isDeleting={
                  deleteMut.isPending && deleteMut.variables.name === p.name
                }
              />
            ))}
          </ul>
        )}

        {deleteMut.error && (
          <p className="mt-3 text-sm text-red-500">
            Delete failed:{' '}
            {deleteMut.error instanceof Error
              ? deleteMut.error.message
              : 'Unknown error'}
          </p>
        )}
      </section>
    </main>
  )
}

function CreateProjectForm({
  onCreate,
  isSubmitting,
  error,
  disabled,
  disabledReason,
}: {
  onCreate: (vars: { name: string; description?: string }) => Promise<unknown>
  isSubmitting: boolean
  error: unknown
  disabled?: boolean
  disabledReason?: string
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      await onCreate({
        name: trimmed,
        description: description.trim() || undefined,
      })
      setName('')
      setDescription('')
    } catch {
      // surfaced via `error` prop
    }
  }

  return (
    <form onSubmit={onSubmit} className="island-shell rounded-2xl p-6 sm:p-8">
      <p className="island-kicker mb-1">New project</p>
      <h2 className="text-2xl font-bold text-[var(--sea-ink)] m-0 mb-1">
        Create a project
      </h2>
      <p className="demo-muted m-0 mb-4 text-sm max-w-2xl">
        A matching source directory and Index v2 will be provisioned in your
        LlamaCloud project.
      </p>

      <fieldset
        disabled={disabled}
        className="contents disabled:cursor-not-allowed"
      >
        <div
          className={`grid gap-4 sm:grid-cols-[1fr_2fr] ${
            disabled ? 'opacity-60' : ''
          }`}
        >
          <div>
            <label className="demo-muted block text-xs font-medium mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. acme-merger-2024"
              className="w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2 text-sm"
              required
              maxLength={120}
              disabled={isSubmitting}
            />
          </div>
          <div>
            <label className="demo-muted block text-xs font-medium mb-1">
              Description{' '}
              <span className="text-[var(--sea-ink-soft)]">(optional)</span>
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description of the matter"
              className="w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2 text-sm"
              maxLength={500}
              disabled={isSubmitting}
            />
          </div>
        </div>
      </fieldset>

      <div className="mt-4 flex items-center gap-3 flex-wrap">
        <button
          type="submit"
          className="demo-button"
          disabled={isSubmitting || !name.trim() || disabled}
          title={disabled ? disabledReason : undefined}
        >
          {isSubmitting ? 'Creating…' : 'Create project'}
        </button>
        {disabled && disabledReason && (
          <span className="text-xs text-[var(--sea-ink-soft)]">
            {disabledReason}
          </span>
        )}
        {error ? (
          <span className="text-sm text-red-500">
            {error instanceof Error
              ? error.message
              : 'Could not create project'}
          </span>
        ) : null}
      </div>
    </form>
  )
}

function DownloadProjectButton({
  userId,
  projectId,
}: {
  userId: string
  projectId: string
}) {
  // A plain anchor with `download` is the right primitive here: the
  // browser handles streaming, progress UI, and "Save As" natively, and
  // we avoid pulling the whole archive into a Blob in memory. The href
  // hits our /api/project-zip route which streams chunks straight from
  // LlamaCloud's S3 through fflate's zip encoder.
  //
  // NOTE: the browser ignores the `download` attribute's filename when
  // the server sends a `Content-Disposition: attachment; filename=...`
  // header, so the actual saved filename comes from the server.
  const href =
    `/api/project-zip` +
    `?userId=${encodeURIComponent(userId)}` +
    `&projectId=${encodeURIComponent(projectId)}`
  return (
    <a
      href={href}
      download
      className="rounded-full border border-[var(--line)] px-4 py-2 text-sm font-semibold hover:bg-[var(--line)]/40"
      title="Download all files in this project as a .zip"
    >
      Download
    </a>
  )
}

function ProjectCard({
  userId,
  project,
  onDelete,
  isDeleting,
}: {
  userId: string
  project: ProjectRow
  onDelete: () => Promise<unknown>
  isDeleting: boolean
}) {
  const [filesOpen, setFilesOpen] = useState(false)

  const handleDelete = async () => {
    if (
      !confirm(
        `Delete "${project.name}"? This will also remove its Index v2 from LlamaCloud. This cannot be undone.`,
      )
    ) {
      return
    }
    try {
      await onDelete()
    } catch {
      // surfaced by parent
    }
  }

  return (
    <li className="border border-[var(--line)] rounded-xl p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-base font-semibold text-[var(--sea-ink)] break-words">
            {project.name}
          </h3>
          {project.description && (
            <p className="m-0 mt-1 text-sm text-[var(--sea-ink-soft)] break-words">
              {project.description}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--sea-ink-soft)] font-mono">
            <span>index: {project.indexId}</span>
            <span>
              created: {new Date(project.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setFilesOpen((v) => !v)}
            className="rounded-full border border-[var(--line)] px-4 py-2 text-sm font-semibold hover:bg-[var(--line)]/40"
          >
            {filesOpen ? 'Hide files' : 'Files'}
          </button>
          <DownloadProjectButton userId={userId} projectId={project.id} />
          <button
            type="button"
            onClick={handleDelete}
            disabled={isDeleting}
            className="rounded-full border border-[var(--line)] px-4 py-2 text-sm font-semibold text-red-500 hover:bg-red-500/10 disabled:opacity-50"
          >
            {isDeleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>

      {filesOpen && <ProjectFiles userId={userId} projectId={project.id} />}
    </li>
  )
}

function ProjectFiles({
  userId,
  projectId,
}: {
  userId: string
  projectId: string
}) {
  const queryClient = useQueryClient()
  const filesKey = ['project-files', projectId] as const
  const statusKey = ['index-status', projectId] as const
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Terminal states: polling can safely stop here. Anything else —
  // including 'syncing', 'pending', 'running', 'exporting', and any
  // future LlamaCloud state we don't know about — keeps polling.
  const TERMINAL_STATUSES = new Set(['ready', 'failed', 'error'])

  // After we trigger an action that should kick off a sync (upload,
  // detach, sync), we force-poll for a short window even if the server
  // still reports 'ready'. LlamaCloud takes a beat to register the new
  // job, and without this bridge the very first refetch can see 'ready'
  // and shut polling off forever. `forceUntil` is a timestamp in ms.
  const [forceUntil, setForceUntil] = useState(0)
  const beginForcePolling = () => {
    setForceUntil(Date.now() + 6000)
  }
  // While inside the force window, tick state so refetchInterval
  // re-evaluates and we get a clean stop at the boundary.
  useEffect(() => {
    if (forceUntil === 0) return
    const remaining = forceUntil - Date.now()
    if (remaining <= 0) return
    const t = setTimeout(() => setForceUntil(0), remaining)
    return () => clearTimeout(t)
  }, [forceUntil])

  const {
    data: files,
    isLoading,
    error,
  } = useQuery({
    queryKey: filesKey,
    queryFn: () => listProjectFilesFn({ data: { userId, projectId } }),
  })

  const { data: status } = useQuery({
    queryKey: statusKey,
    queryFn: () => indexStatusFn({ data: { userId, projectId } }),
    // Poll unless we've reached a terminal state. Also force-poll for a
    // short window after a user action that should trigger a sync, to
    // bridge the time between "client clicked sync" and "LlamaCloud has
    // actually flipped the status to syncing".
    refetchInterval: (q) => {
      const s = (q.state.data as { status?: string } | undefined)?.status
      if (Date.now() < forceUntil) return 2000
      if (!s || s === 'unknown') return false
      return TERMINAL_STATUSES.has(s) ? false : 2000
    },
  })

  const uploadMut = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData()
      fd.set('userId', userId)
      fd.set('projectId', projectId)
      fd.set('file', file)
      return uploadFileFn({ data: fd })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: filesKey })
      queryClient.invalidateQueries({ queryKey: statusKey })
      beginForcePolling()
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
  })

  const detachMut = useMutation({
    mutationFn: (fileId: string) =>
      detachFileFn({ data: { userId, projectId, fileId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: filesKey })
      queryClient.invalidateQueries({ queryKey: statusKey })
      beginForcePolling()
    },
  })

  const syncMut = useMutation({
    mutationFn: () => syncProjectFn({ data: { userId, projectId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: statusKey })
      beginForcePolling()
    },
  })

  const onFilesChosen = async (list: FileList | null) => {
    if (!list || list.length === 0) return
    // Upload sequentially so users get clear feedback and we don't hammer
    // LlamaCloud with parallel requests. p-limit style parallelism can come
    // later if needed.
    for (const f of Array.from(list)) {
      try {
        await uploadMut.mutateAsync(f)
      } catch {
        // mutation.error surfaces in the UI
        break
      }
    }
  }

  return (
    <div className="mt-4 border-t border-[var(--line)] pt-4">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-[var(--sea-ink)]">
            Files
          </span>
          <IndexStatusBadge status={status?.status} />
        </div>
        <button
          type="button"
          onClick={() => syncMut.mutate()}
          disabled={syncMut.isPending}
          className="text-xs rounded-full border border-[var(--line)] px-3 py-1 hover:bg-[var(--line)]/40 disabled:opacity-50"
          title="Trigger an index sync without uploading a new file"
        >
          {syncMut.isPending ? 'Syncing…' : 'Re-sync index'}
        </button>
      </div>

      <div className="flex items-center gap-3 flex-wrap mb-3">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={(e) => onFilesChosen(e.target.files)}
          disabled={uploadMut.isPending}
          className="text-sm"
        />
        {uploadMut.isPending && (
          <span className="text-xs text-[var(--sea-ink-soft)]">Uploading…</span>
        )}
      </div>

      {uploadMut.error ? (
        <p className="m-0 mb-3 text-sm text-red-500">
          Upload failed:{' '}
          {uploadMut.error instanceof Error
            ? uploadMut.error.message
            : 'Unknown error'}
        </p>
      ) : null}

      {isLoading && (
        <p className="m-0 text-sm text-[var(--sea-ink-soft)]">Loading files…</p>
      )}

      {error && (
        <p className="m-0 text-sm text-red-500">
          Failed to load files:{' '}
          {error instanceof Error ? error.message : 'Unknown error'}
        </p>
      )}

      {files && files.length === 0 && (
        <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
          No files yet. Upload some above.
        </p>
      )}

      {files && files.length > 0 && (
        <ul className="m-0 list-none p-0 grid gap-2">
          {files.map((f) => (
            <FileRow
              key={f.id}
              file={f}
              onDetach={() => detachMut.mutateAsync(f.id)}
              isDetaching={detachMut.isPending && detachMut.variables === f.id}
            />
          ))}
        </ul>
      )}

      {detachMut.error ? (
        <p className="mt-2 text-sm text-red-500">
          Remove failed:{' '}
          {detachMut.error instanceof Error
            ? detachMut.error.message
            : 'Unknown error'}
        </p>
      ) : null}
    </div>
  )
}

function FileRow({
  file,
  onDetach,
  isDetaching,
}: {
  file: FileRow
  onDetach: () => Promise<unknown>
  isDetaching: boolean
}) {
  const handle = async () => {
    if (
      !confirm(
        `Remove "${file.name}" from this project? It will also be removed from the LlamaCloud index.`,
      )
    ) {
      return
    }
    try {
      await onDetach()
    } catch {
      // surfaced by parent
    }
  }
  return (
    <li className="flex items-center justify-between gap-3 border border-[var(--line)] rounded-lg px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <p className="m-0 text-sm font-medium text-[var(--sea-ink)] truncate">
            {file.name}
          </p>
          <span
            className="shrink-0 text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded-full bg-[var(--lagoon-deep)]/10 text-[var(--lagoon-deep)]"
            title={`Version ${file.version} of this filename in this project`}
          >
            v{file.version}
          </span>
        </div>
        <p className="m-0 text-xs text-[var(--sea-ink-soft)] font-mono">
          {formatBytes(file.size)} · {file.mimeType} ·{' '}
          {new Date(file.createdAt).toLocaleDateString()}
        </p>
      </div>
      <button
        type="button"
        onClick={handle}
        disabled={isDetaching}
        className="text-xs rounded-full border border-[var(--line)] px-3 py-1 text-red-500 hover:bg-red-500/10 disabled:opacity-50"
      >
        {isDetaching ? 'Removing…' : 'Remove'}
      </button>
    </li>
  )
}

function IndexStatusBadge({ status }: { status?: string }) {
  if (!status) return null
  const tone =
    status === 'ready'
      ? 'bg-green-500/15 text-green-700'
      : status === 'failed'
        ? 'bg-red-500/15 text-red-600'
        : 'bg-amber-500/15 text-amber-700'
  return (
    <span
      className={`text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded-full ${tone}`}
    >
      {status}
    </span>
  )
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
