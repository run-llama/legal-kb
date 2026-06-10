import { LlamaCloud } from '@llamaindex/llama-cloud'
import { tool, ToolLoopAgent } from 'ai'
import { z } from 'zod'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'

function createLlamaParseTools(
  llamaCloudApiKey: string,
  llamaCloudProjectId: string,
  indexId: string,
) {
  const getClient = () => {
    return new LlamaCloud({ apiKey: llamaCloudApiKey })
  }

  const getProjectId = () => {
    return llamaCloudProjectId
  }

  const retrieve = tool({
    description:
      'Run a semantic retrieval query against an index. ' +
      'Returns a formatted string of results with scores, content previews, and metadata.',
    inputSchema: z.object({
      query: z.string().describe('The search query string.'),
      top_k: z
        .number()
        .nullable()
        .describe('Maximum number of results to return.'),
      score_threshold: z
        .number()
        .nullable()
        .describe('Minimum relevance score for results to be included.'),
      rerank_top_n: z
        .number()
        .nullable()
        .describe(
          'If set, enables reranking and returns the top N reranked results.',
        ),
    }),
    execute: async ({ query, top_k, score_threshold, rerank_top_n }) => {
      const client = getClient()
      const response = await client.beta.retrieval.retrieve({
        index_id: indexId,
        project_id: getProjectId(),
        query,
        top_k: top_k,
        score_threshold: score_threshold,
        rerank:
          rerank_top_n != null
            ? { enabled: true, top_n: rerank_top_n }
            : undefined,
      })
      const retrieved: string[] = []
      for (let i = 0; i < response.results.length; i++) {
        const result = response.results[i]
        let r = `Retrieval result #${i + 1} (Score: ${result.score ?? 'NA'})\n${result.content.slice(
          0,
          200,
        )}\n`
        if (result.metadata) {
          r += `Metadata:\n\n\`\`\`json\n${JSON.stringify(result.metadata, null, 2)}\n`
        }
        r += '\n\n---\n\n'
        retrieved.push(r)
      }
      return retrieved.join('\n\n')
    },
  })

  const findFiles = tool({
    description:
      'Search for files within an index by name. ' +
      'Returns a formatted string listing matching file names and their IDs, ' +
      'paginating through all results automatically.',
    inputSchema: z.object({
      file_name: z.string().nullable().describe('Exact file name to match.'),
      file_name_contains: z
        .string()
        .nullable()
        .describe('Substring to match against file names.'),
    }),
    execute: async ({ file_name, file_name_contains }) => {
      const client = getClient()
      const files: Array<{ fileName: string; fileId: string }> = []
      for await (const item of client.beta.retrieval.find({
        index_id: indexId,
        project_id: getProjectId(),
        file_name: file_name,
        file_name_contains: file_name_contains,
      })) {
        files.push({ fileName: item.file_name, fileId: item.file_id })
      }
      const ls = files
        .map((f) => `- ${f.fileName} (ID: ${f.fileId})`)
        .join('\n')
      return `Files matching the query:\n${ls}`
    },
  })

  const readFile = tool({
    description:
      'Read the contents of a file from an index. ' +
      'Returns the raw file content as a string.',
    inputSchema: z.object({
      file_id: z.string().describe('The ID of the file to read.'),
      offset: z
        .number()
        .nullable()
        .describe('Character offset to start reading from. Defaults to 0.'),
      max_length: z
        .number()
        .nullable()
        .describe('Maximum number of characters to return.'),
    }),
    execute: async ({ file_id, offset, max_length }) => {
      const client = getClient()
      const response = await client.beta.retrieval.read({
        index_id: indexId,
        file_id,
        offset: offset ?? 0,
        max_length: max_length,
        project_id: getProjectId(),
      })
      return response.content
    },
  })

  const grepFile = tool({
    description:
      'Search for a pattern within a specific file using grep. ' +
      'Returns a formatted string of matches with their character positions, ' +
      'paginating through all results automatically.',
    inputSchema: z.object({
      file_id: z.string().describe('The ID of the file to search.'),
      pattern: z.string().describe('The pattern to search for.'),
      context_chars: z
        .number()
        .nullable()
        .describe(
          'Number of surrounding characters to include with each match.',
        ),
      limit: z
        .number()
        .nullable()
        .describe('Maximum number of matches to return per page.'),
    }),
    execute: async ({ file_id, pattern, context_chars, limit }) => {
      const client = getClient()
      const matches: Array<{
        content: string
        startChar: number
        endChar: number
      }> = []
      for await (const item of client.beta.retrieval.grep({
        index_id: indexId,
        file_id,
        pattern,
        context_chars: context_chars,
        page_size: limit ?? undefined,
        project_id: getProjectId(),
      })) {
        matches.push({
          content: item.content,
          startChar: item.start_char,
          endChar: item.end_char,
        })
      }
      const ls = matches
        .map((m) => `- ${m.content} (start: ${m.startChar}, end: ${m.endChar})`)
        .join('\n')
      return `Grep matches:\n${ls}`
    },
  })

  return {
    retrieve,
    findFiles,
    readFile,
    grepFile,
  }
}

// Example usage with Vercel AI SDK (install `ai` + `zod` to run):

function modelToProvider(
  model: string,
  anthropicKey?: string,
  openaiKey?: string,
) {
  if (model.startsWith('anthropic/')) {
    const provider = createAnthropic({ apiKey: anthropicKey })
    return provider(model.replace('anthropic/', ''))
  } else if (model.startsWith('openai/')) {
    const provider = createOpenAI({ apiKey: openaiKey })
    return provider(model.replace('openai/', ''))
  }
  throw new Error(`Unsupported model: ${model}`)
}

export function buildAgent(
  model: string,
  llamaCloudApiKey: string,
  llamaCloudProjectId: string,
  indexId: string,
  openaiKey?: string,
  anthropicKey?: string,
) {
  const resolvedProvider = modelToProvider(model, anthropicKey, openaiKey)
  return new ToolLoopAgent({
    model: resolvedProvider,
    tools: createLlamaParseTools(
      llamaCloudApiKey,
      llamaCloudProjectId,
      indexId,
    ),
    instructions:
      'You are a helpful assistant with access to a document index.',
  })
}
