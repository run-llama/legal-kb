// services/apiKeys.ts
import { prisma } from '../db'
import { encrypt, decrypt } from '@/lib/crypto'

type ApiKeyInput = {
  openaiKey?: string
  anthropicKey?: string
  llamacloudKey?: string
  llamacloudProjectId?: string
}

function validateAtLeastOne(input: ApiKeyInput) {
  if (
    !input.openaiKey &&
    !input.anthropicKey &&
    !input.llamacloudKey &&
    !input.llamacloudProjectId
  ) {
    throw new Error(
      'At least one API key (OpenAI, Anthropic, or LlamaCloud) must be provided',
    )
  }
}

export async function upsertApiKeys(userId: string, input: ApiKeyInput) {
  validateAtLeastOne(input)

  // Make sure the parent User row exists before touching ApiKey,
  // since api_keys.user_id -> users.id is a FK.
  return prisma.$transaction(async (tx) => {
    await tx.user.upsert({
      where: { id: userId },
      create: { id: userId },
      update: {},
    })

    return tx.apiKey.upsert({
      where: { userId },
      create: {
        userId,
        openaiKey: input.openaiKey ? encrypt(input.openaiKey) : null,
        anthropicKey: input.anthropicKey ? encrypt(input.anthropicKey) : null,
        llamacloudKey: input.llamacloudKey
          ? encrypt(input.llamacloudKey)
          : null,
        llamacloudProjectId: input.llamacloudProjectId
          ? input.llamacloudProjectId
          : null,
      },
      update: {
        openaiKey: input.openaiKey ? encrypt(input.openaiKey) : null,
        anthropicKey: input.anthropicKey ? encrypt(input.anthropicKey) : null,
        llamacloudKey: input.llamacloudKey
          ? encrypt(input.llamacloudKey)
          : null,
        llamacloudProjectId: input.llamacloudProjectId
          ? input.llamacloudProjectId
          : null,
      },
    })
  })
}

export async function getDecryptedApiKeys(userId: string) {
  const row = await prisma.apiKey.findUnique({ where: { userId } })
  if (!row) return null

  return {
    openaiKey: row.openaiKey ? decrypt(row.openaiKey) : null,
    anthropicKey: row.anthropicKey ? decrypt(row.anthropicKey) : null,
    llamacloudKey: row.llamacloudKey ? decrypt(row.llamacloudKey) : null,
    llamacloudProjectId: row.llamacloudProjectId
      ? row.llamacloudProjectId
      : null,
  }
}
