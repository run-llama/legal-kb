// lib/files.ts
//
// File handling: uploads bytes to LlamaCloud, records the file in the DB,
// links it to a project's source directory, and kicks off index sync.
//
// Schema reminders:
//   - File belongs to a User (userId), NOT directly to a Project.
//   - File <-> Project is many-to-many via ProjectFile.
//   - ProjectFile.fileId has onDelete: Restrict, so a File row cannot be
//     deleted while it is still linked to any Project. We unlink first.
//
// LlamaCloud reminders (see llama-cloud-ts/examples/index_v2/create_sync_and_retrieve.ts):
//   - Upload via client.beta.directories.files.upload(dirId, { upload_file, project_id })
//   - Sync via   client.beta.indexes.sync(indexId)
//   - Poll      client.beta.indexes.get(indexId).metadata.status until 'ready'|'failed'
//   - We mirror LlamaCloud's file_id as File.id in our DB so the two systems stay aligned.

import LlamaCloud from '@llamaindex/llama-cloud'
import { prisma } from '../db'
import { decrypt } from './crypto'

// ---------- types ----------

export type UploadFileInput = {
  userId: string
  projectId: string
  /** Original filename (extension matters; LlamaCloud uses it for parsing). */
  name: string
  /** File bytes. */
  data: Buffer
  /** MIME type for our DB record (LlamaCloud sniffs its own). */
  mimeType: string
}

export type DetachFileInput = {
  userId: string
  projectId: string
  fileId: string
}

export type DeleteFileInput = {
  userId: string
  fileId: string
}

// ---------- ownership guards (DB-only, use inside transactions) ----------

async function assertProjectOwned(
  tx: typeof prisma,
  userId: string,
  projectId: string,
) {
  const project = await tx.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true, indexId: true },
  })
  if (!project) throw new Error('project not found for this user')
  return project
}

async function assertFileOwned(
  tx: typeof prisma,
  userId: string,
  fileId: string,
) {
  const file = await tx.file.findFirst({
    where: { id: fileId, userId },
    select: { id: true },
  })
  if (!file) throw new Error('file not found for this user')
}

// ---------- LlamaCloud helpers ----------

type UserKeys = {
  llamacloudKey: string
  llamacloudProjectId: string
}

async function getUserLlamaCloudKeys(userId: string): Promise<UserKeys> {
  const keys = await prisma.apiKey.findUnique({ where: { userId } })
  if (!keys) throw new Error('no API keys configured for the user')
  if (!keys.llamacloudKey || !keys.llamacloudProjectId) {
    throw new Error(
      'user did not configure the necessary credentials for the LlamaParse Platform',
    )
  }
  return {
    llamacloudKey: decrypt(keys.llamacloudKey),
    llamacloudProjectId: keys.llamacloudProjectId,
  }
}

/** Resolve the source directory ID backing a project's index. */
async function getSourceDirectoryId(
  client: LlamaCloud,
  indexId: string,
): Promise<string> {
  const idx = await client.beta.indexes.get(indexId)
  const dirId = idx.source_directory_id
  if (!dirId) {
    throw new Error(
      `index ${indexId} has no source_directory_id; cannot manage files`,
    )
  }
  return dirId
}

// ---------- writes ----------

/**
 * Upload a file:
 *   1. Push bytes to the project's LlamaCloud source directory.
 *   2. Persist File + ProjectFile rows in the DB, mirroring LlamaCloud's ID.
 *   3. Trigger an index sync (does NOT wait for completion).
 *
 * Returns the new File row plus a flag indicating sync was kicked off.
 * Callers should poll `getIndexStatus(projectId)` to track sync progress.
 *
 * If the DB step fails after the LlamaCloud upload succeeded, we best-effort
 * delete the LlamaCloud file to avoid orphans.
 */
export async function uploadFile(input: UploadFileInput) {
  const { llamacloudKey, llamacloudProjectId } = await getUserLlamaCloudKeys(
    input.userId,
  )

  // Look up the project & index. Done outside the write transaction so we
  // don't hold a DB transaction open across slow LlamaCloud calls.
  const project = await prisma.project.findFirst({
    where: { id: input.projectId, userId: input.userId },
    select: { id: true, indexId: true },
  })
  if (!project) throw new Error('project not found for this user')

  const client = new LlamaCloud({
    apiKey: llamacloudKey,
    baseURL:
      process.env.LLAMA_CLOUD_BASE_URL ?? 'https://api.cloud.llamaindex.ai',
  })
  const sourceDirId = await getSourceDirectoryId(client, project.indexId)

  // 1. Upload bytes to LlamaCloud.
  const uploaded = await client.beta.directories.files.upload(sourceDirId, {
    // The SDK accepts a web File; Buffer must be wrapped.
    upload_file: new File([new Uint8Array(input.data)], input.name),
    project_id: llamacloudProjectId,
    metadata: JSON.stringify({ file_name: input.name }),
  })
  const cloudFileId = uploaded.id

  // 2. Mirror in DB. If this fails we roll back LlamaCloud best-effort.
  let file: Awaited<ReturnType<typeof prisma.file.create>>
  try {
    file = await prisma.$transaction(async (tx) => {
      const created = await tx.file.create({
        data: {
          id: cloudFileId,
          name: input.name,
          size: input.data.length,
          mimeType: input.mimeType,
          userId: input.userId,
        },
      })
      await tx.projectFile.create({
        data: { projectId: project.id, fileId: created.id },
      })
      return created
    })
  } catch (dbErr) {
    // Best-effort cleanup; surface the original error either way.
    try {
      await client.beta.directories.files.delete(cloudFileId, {
        directory_id: sourceDirId,
      })
    } catch {
      // ignore — we'll surface the DB error below
    }
    throw new Error(
      `uploaded to LlamaCloud (file ${cloudFileId}) but DB save failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
    )
  }

  // 3. Kick off index sync without waiting (don't block the HTTP response).
  //    We swallow sync errors so the user still gets a successful upload —
  //    they can re-trigger sync explicitly if needed.
  void client.beta.indexes
    .sync(project.indexId)
    .catch((err) =>
      console.error(
        `[files.uploadFile] index sync trigger failed for index=${project.indexId}:`,
        err,
      ),
    )

  return { file, syncTriggered: true }
}

/**
 * Detach a file from a single project (removes from that project's LlamaCloud
 * source directory + removes the ProjectFile link). The File row stays put if
 * it's still linked elsewhere; otherwise it's removed.
 */
export async function detachFileFromProject(input: DetachFileInput) {
  const { llamacloudKey } = await getUserLlamaCloudKeys(input.userId)

  // Verify ownership + collect what we need before talking to LlamaCloud.
  const project = await prisma.project.findFirst({
    where: { id: input.projectId, userId: input.userId },
    select: { id: true, indexId: true },
  })
  if (!project) throw new Error('project not found for this user')
  await assertFileOwned(prisma, input.userId, input.fileId)

  const link = await prisma.projectFile.findUnique({
    where: {
      projectId_fileId: {
        projectId: input.projectId,
        fileId: input.fileId,
      },
    },
  })
  if (!link) throw new Error('file is not attached to this project')

  const client = new LlamaCloud({
    apiKey: llamacloudKey,
    baseURL:
      process.env.LLAMA_CLOUD_BASE_URL ?? 'https://api.cloud.llamaindex.ai',
  })
  const sourceDirId = await getSourceDirectoryId(client, project.indexId)

  // Remove from LlamaCloud first — if this fails we keep the DB link so the
  // user can retry without losing the reference.
  await client.beta.directories.files.delete(input.fileId, {
    directory_id: sourceDirId,
  })

  // Then drop the link. If this leaves the File orphaned (no other
  // ProjectFile rows), also drop the File row itself.
  const removedFile = await prisma.$transaction(async (tx) => {
    await tx.projectFile.delete({
      where: {
        projectId_fileId: {
          projectId: input.projectId,
          fileId: input.fileId,
        },
      },
    })
    const remaining = await tx.projectFile.count({
      where: { fileId: input.fileId },
    })
    if (remaining === 0) {
      await tx.file.delete({ where: { id: input.fileId } })
      return true
    }
    return false
  })

  // Trigger a sync so the index reflects the removed file. Fire-and-forget.
  void client.beta.indexes
    .sync(project.indexId)
    .catch((err) =>
      console.error(
        `[files.detachFileFromProject] index sync trigger failed for index=${project.indexId}:`,
        err,
      ),
    )

  return { fileDeleted: removedFile, syncTriggered: true }
}

/**
 * Hard-delete a file across every project it's linked to. Cleans up
 * LlamaCloud across each affected source directory, then drops the DB rows,
 * then triggers a sync per affected index.
 */
export async function deleteFile(input: DeleteFileInput) {
  const { llamacloudKey } = await getUserLlamaCloudKeys(input.userId)
  await assertFileOwned(prisma, input.userId, input.fileId)

  // Pull every project this file is linked to (and their indexIds).
  const links = await prisma.projectFile.findMany({
    where: { fileId: input.fileId },
    include: { project: { select: { id: true, indexId: true } } },
  })

  const client = new LlamaCloud({
    apiKey: llamacloudKey,
    baseURL:
      process.env.LLAMA_CLOUD_BASE_URL ?? 'https://api.cloud.llamaindex.ai',
  })

  // Remove from each source directory. We collect failures rather than
  // aborting on the first one — partial cleanup is better than none.
  const failures: Array<{ projectId: string; error: string }> = []
  for (const link of links) {
    try {
      const sourceDirId = await getSourceDirectoryId(
        client,
        link.project.indexId,
      )
      await client.beta.directories.files.delete(input.fileId, {
        directory_id: sourceDirId,
      })
    } catch (err) {
      failures.push({
        projectId: link.project.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `failed to remove file from LlamaCloud for ${failures.length}/${links.length} project(s); not deleting DB row. First failure: ${failures[0].error}`,
    )
  }

  // All LlamaCloud removals succeeded — drop DB rows.
  await prisma.$transaction(async (tx) => {
    await tx.projectFile.deleteMany({ where: { fileId: input.fileId } })
    await tx.file.delete({ where: { id: input.fileId } })
  })

  // Trigger sync on each affected index, fire-and-forget.
  for (const link of links) {
    void client.beta.indexes
      .sync(link.project.indexId)
      .catch((err) =>
        console.error(
          `[files.deleteFile] index sync trigger failed for index=${link.project.indexId}:`,
          err,
        ),
      )
  }

  return { detachedFromProjectIds: links.map((l) => l.project.id) }
}

// ---------- reads ----------

/** All files attached to a given project (newest first). */
export async function getProjectFiles(userId: string, projectId: string) {
  await assertProjectOwned(prisma, userId, projectId)

  const rows = await prisma.projectFile.findMany({
    where: { projectId },
    include: { file: true },
    orderBy: { file: { createdAt: 'desc' } },
  })
  return rows.map((r) => r.file)
}

/** Every file the user owns, with the projects each is attached to. */
export async function getUserFiles(userId: string) {
  return prisma.file.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: {
      projects: { select: { projectId: true } },
    },
  })
}

/** Single-file lookup, scoped to the owner. */
export async function getFile(userId: string, fileId: string) {
  return prisma.file.findFirst({
    where: { id: fileId, userId },
    include: { projects: { select: { projectId: true } } },
  })
}

// ---------- sync status ----------

/**
 * Explicitly trigger an index sync for a project (the SDK call only — does
 * not wait). Useful if the UI wants a "Re-sync" button.
 */
export async function syncProjectIndex(userId: string, projectId: string) {
  const { llamacloudKey } = await getUserLlamaCloudKeys(userId)
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { indexId: true },
  })
  if (!project) throw new Error('project not found for this user')
  const client = new LlamaCloud({
    apiKey: llamacloudKey,
    baseURL:
      process.env.LLAMA_CLOUD_BASE_URL ?? 'https://api.cloud.llamaindex.ai',
  })
  await client.beta.indexes.sync(project.indexId)
  return { syncTriggered: true }
}

/**
 * Poll-friendly: return the current LlamaCloud sync status of a project's
 * index. Possible values include 'ready', 'syncing', 'failed', 'unknown', ...
 */
export async function getIndexStatus(userId: string, projectId: string) {
  const { llamacloudKey } = await getUserLlamaCloudKeys(userId)
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { indexId: true },
  })
  if (!project) throw new Error('project not found for this user')

  const client = new LlamaCloud({ apiKey: llamacloudKey })
  const idx = await client.beta.indexes.get(project.indexId)

  let status = 'unknown'
  const meta = idx.metadata as unknown
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>
    if (typeof m.status === 'string') status = m.status
  }
  return { status, indexId: project.indexId }
}
