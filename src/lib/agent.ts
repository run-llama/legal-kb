import { LlamaCloud } from '@llamaindex/llama-cloud'
import { tool, ToolLoopAgent } from 'ai'
import { z } from 'zod'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import type { Citation } from './citations'
import { makeCitationId } from './citations'

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
      'Returns { formatted, citations }. The `formatted` field is a human-' +
      'readable list of retrieved chunks (use this as your primary signal). ' +
      'The `citations` field gives each chunk a short id (e.g. "c7f2qa") ' +
      'and the metadata you need to cite it. Reference an id inline using ' +
      'backtick-wrapped tokens like `cite:c7f2qa` to surface a clickable ' +
      'citation chip in the UI.',
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

      // Build both a human/model-readable formatted string AND a structured
      // citations array that the UI uses to render visual citation chips.
      const formattedParts: string[] = []
      const citations: Citation[] = []
      for (let i = 0; i < response.results.length; i++) {
        const result = response.results[i]
        console.log('[RESULT]', JSON.stringify(result))
        const sf = result.static_fields ?? {}
        const meta = (result.metadata ?? {}) as Record<string, unknown>
        const fileName =
          typeof meta.file_name === 'string'
            ? meta.file_name
            : typeof meta.filename === 'string'
              ? meta.filename
              : typeof meta.source === 'string'
                ? meta.source
                : 'unknown file'
        const fileId =
          typeof sf.parsed_directory_file_id === 'string'
            ? sf.parsed_directory_file_id
            : typeof meta.file_id === 'string'
              ? meta.file_id
              : ''
        const screenshot = (sf.attachments ?? []).find(
          (a) => a.type === 'screenshot',
        )

        const id = makeCitationId()
        const preview = result.content.slice(0, 240)

        citations.push({
          id,
          fileName,
          fileId,
          pageStart: sf.page_range_start ?? null,
          pageEnd: sf.page_range_end ?? null,
          attachment: screenshot
            ? {
                name: screenshot.attachment_name,
                sourceId: screenshot.source_id,
              }
            : null,
          preview,
          score: result.rerank_score ?? result.score ?? null,
        })

        // Format for the model. Include the citation id so the model can
        // reference it inline.
        let r =
          `### Result #${i + 1} — \`cite:${id}\` ` +
          `(score: ${(result.rerank_score ?? result.score ?? 0).toFixed(3)}, ` +
          `file: ${fileName}` +
          (sf.page_range_start != null
            ? `, p.${sf.page_range_start}` +
              (sf.page_range_end && sf.page_range_end !== sf.page_range_start
                ? `–${sf.page_range_end}`
                : '')
            : '') +
          `)\n\n${result.content.slice(0, 600)}`
        if (Object.keys(meta).length > 0) {
          r +=
            `\n\nMetadata:\n\`\`\`json\n` +
            JSON.stringify(meta, null, 2) +
            `\n\`\`\``
        }
        formattedParts.push(r)
      }

      return {
        formatted: formattedParts.join('\n\n---\n\n'),
        citations,
      }
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
    instructions: `You are a legal research assistant with access to a document index. \
    Your role is to help users understand, navigate, and extract information from the legal documents in their index.

    ## Core behavior
    - Ground every answer in the documents. Before responding, always use the retrieval or search tools to find relevant content.
    - If the documents do not contain enough information to answer a question, say so explicitly — do not fill gaps with general legal knowledge.
    - Never give legal advice, opinions, or recommendations. You surface and explain what the documents say; you do not interpret them beyond that.
    - Always cite the source document and, where possible, the specific section or page you are drawing from.

    ## Tool usage
    - Use \`retrieve\` for broad semantic questions ("what does this contract say about termination?").
    - Use \`findFiles\` when the user references a specific document by name.
    - Use \`readFile\` to read a full document or a specific section when precision is needed.
    - Use \`grepFile\` to locate specific clauses, terms, or patterns within a known document.
    - Prefer chaining tools: retrieve to find candidates, then readFile or grepFile to confirm exact wording.

    ## Citations (very important)
    The \`retrieve\` tool returns a list of results, each with a short id
    (e.g. "c7f2qa"). When you state a fact that comes from a specific
    result, append a citation marker immediately after the sentence using
    inline code with the prefix "cite:", like this:

        The contract terminates after 12 months \`cite:c7f2qa\`.

    Rules:
    - Only cite ids that appeared in a \`retrieve\` tool result during
      THIS turn. Never invent ids; never reuse ids across turns.
    - Cite at the END of the sentence (or clause) the fact came from, not
      at the start.
    - If multiple results support the same fact, cite all of them in a
      row: \`cite:c7f2qa\` \`cite:cf8ab1\`.
    - Do NOT cite for paraphrased general knowledge or for opinions —
      only for facts you took from a specific retrieved chunk.
    - Do NOT add a separate "Sources" section at the end; the UI already
      shows a list of all cited sources below the answer.

    ## Boundaries
    - Do not answer questions that are not grounded in the indexed documents.
    - Do not speculate about jurisdiction, enforceability, or legal outcomes.
    - If asked for legal advice, remind the user that you are a research tool and recommend they consult a qualified lawyer.`,
  })
}
