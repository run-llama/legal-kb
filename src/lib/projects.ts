import LlamaCloud from '@llamaindex/llama-cloud'
import { prisma } from '../db'
import { decrypt } from './crypto'

type CreateProjectInput = {
  name: string
  description?: string
  userId: string
}

type DeleteProjectInput = {
  name: string
  userId: string
  indexId: string
  description?: string
}

async function sourceDirExists(client: LlamaCloud, name: string) {
  const response = await client.beta.directories.list({ name, page_size: 1 })
  return response.items.length === 1
}

export async function createProject(input: CreateProjectInput) {
  const keys = await prisma.apiKey.findUnique({
    where: { userId: input.userId },
  })
  if (!keys) {
    throw new Error('no API keys configured for the user')
  }
  if (!keys.llamacloudKey || !keys.llamacloudProjectId) {
    throw new Error(
      'user did not configure the necessary credentials for the LlamaParse Platform',
    )
  }
  const client = new LlamaCloud({ apiKey: decrypt(keys.llamacloudKey) })
  if (await sourceDirExists(client, input.name)) {
    throw new Error('index already exists in LlamaCloud')
  }
  const response = await client.beta.directories.create({
    name: input.name,
    description: input.description,
    project_id: keys.llamacloudProjectId,
  })
  const indexResp = await client.beta.indexes.create({
    name: input.name,
    description: input.description,
    source_directory_id: response.id,
    project_id: keys.llamacloudProjectId,
  })
  const indexId = indexResp.id
  try {
    const project = await prisma.project.create({
      data: {
        name: input.name,
        description: input.description,
        userId: input.userId,
        indexId,
      },
    })
    return project
  } catch (e) {
    await client.beta.indexes.delete(indexId)
    throw new Error(`Project creation failed: ${e}`)
  }
}

export async function getProjects(userId: string) {
  const projects = await prisma.project.findMany({
    where: { userId },
  })
  return projects
}

export async function getProject(projectId: string) {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
  })
  return project
}

export async function deleteProject(input: DeleteProjectInput) {
  const keys = await prisma.apiKey.findUnique({
    where: { userId: input.userId },
  })
  if (!keys) throw new Error('no API keys configured for the user')
  if (!keys.llamacloudKey || !keys.llamacloudProjectId) {
    throw new Error('LlamaCloud credentials are not configured')
  }

  const client = new LlamaCloud({ apiKey: decrypt(keys.llamacloudKey) })

  // 1. Delete from LlamaCloud first
  const resp = await client.beta.indexes.get(input.indexId)
  const sourceDir = resp.source_directory_id
  await client.beta.indexes.delete(input.indexId)

  // 2. Then delete from DB — rollback if it fails
  try {
    await prisma.project.delete({
      where: { userId_name: { userId: input.userId, name: input.name } },
    })
  } catch (err) {
    // Rollback: recreate the index in LlamaCloud
    await client.beta.indexes.create({
      name: input.name,
      description: input.description,
      project_id: keys.llamacloudProjectId,
      source_directory_id: sourceDir,
    })
    throw new Error(`DB deletion failed, LlamaCloud changes reverted: ${err}`)
  }

  // 3. Delete source directory once both index and db are out
  await client.beta.directories.delete(sourceDir)
}
