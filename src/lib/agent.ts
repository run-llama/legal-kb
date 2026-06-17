import { LlamaCloud } from '@llamaindex/llama-cloud'
import { tool, ToolLoopAgent } from 'ai'
import type { ProviderOptions } from '@ai-sdk/provider-utils'
import { z } from 'zod'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import type { Citation, CitationPage } from './citations'
import { makeCitationId, parsePageNumber } from './citations'
import type { RetrievalRetrieveParams } from '@llamaindex/llama-cloud/resources/beta/retrieval.mjs'

/** Schema to validate the response from the export configs endpoint */
export const ExportSchema = z.object({
  id: z.string(),

  created_at: z.iso.datetime(),

  updated_at: z.iso.datetime(),

  project_id: z.uuid(),

  output_directory_id: z.string(),

  export_type: z.string(),

  destination: z.string(),

  include_metadata: z.boolean(),

  include_embeddings: z.boolean(),

  deletion_mode: z.string(),

  destination_config: z.unknown().nullable(),

  last_exported_at: z.iso.datetime(),
})

export type Export = z.infer<typeof ExportSchema>

/**
 * Turn LlamaCloud's flat `attachments` array into a per-page list. We
 * pair `screenshots/page_N.jpg` with `items/page_N.json` by parsing the
 * page number out of the filename. Items without a parseable page
 * number are skipped (they're typically global-doc attachments that we
 * don't render in the citation modal). Sorted ascending by page.
 */
function buildCitationPages(
  attachments: ReadonlyArray<{
    type: string
    attachment_name: string
    source_id: string
  }>,
): CitationPage[] {
  const byPage = new Map<number, CitationPage>()
  const ensure = (page: number): CitationPage => {
    let p = byPage.get(page)
    if (!p) {
      p = { page, screenshot: null, items: null }
      byPage.set(page, p)
    }
    return p
  }
  for (const a of attachments) {
    const page = parsePageNumber(a.attachment_name)
    if (page == null) continue
    const ref = { name: a.attachment_name, sourceId: a.source_id }
    if (a.type === 'screenshot') {
      ensure(page).screenshot = ref
    } else if (
      a.type === 'items' ||
      (a.type !== 'screenshot' && a.attachment_name.endsWith('.json'))
    ) {
      // Accept either an explicit 'items' type or, as a fallback, any
      // non-screenshot attachment whose filename ends in .json.
      ensure(page).items = ref
    }
  }
  return [...byPage.values()].sort((a, b) => a.page - b.page)
}

/** Get the output directory ID given an Index */
export async function getOutputDirectoryId(
  indexId: string,
  apiKey: string,
  maxRetries = 3,
) {
  const baseURL =
    process.env.LLAMA_CLOUD_BASE_URL ?? 'https://api.cloud.llamaindex.ai'

  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(
        `${baseURL}/api/v1/directories/export-configs/${indexId}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        },
      )

      // Don't retry on 4xx — these are client errors that won't resolve on their own
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status != 429
      ) {
        throw new Error(
          `Client error ${response.status}: Could not find any export config`,
        )
      }

      if (!response.ok) {
        throw new Error(
          `Server error ${response.status}: Could not find any export config`,
        )
      }

      const data = await response.json()
      const validated = await ExportSchema.parseAsync(data)
      return validated.output_directory_id
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      // Don't retry 4xx errors, except for rate limits
      if (lastError.message.startsWith('Client error')) throw lastError

      if (attempt < maxRetries) {
        const delay = 2 ** (attempt - 1) * 500 // 500ms, 1000ms, 2000ms
        console.warn(
          `Attempt ${attempt} failed, retrying in ${delay}ms...`,
          lastError.message,
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  throw new Error(`Failed after ${maxRetries} attempts: ${lastError?.message}`)
}

function createLlamaParseTools(
  llamaCloudApiKey: string,
  llamaCloudProjectId: string,
  indexId: string,
) {
  const getClient = () => {
    return new LlamaCloud({
      apiKey: llamaCloudApiKey,
      baseURL:
        process.env.LLAMA_CLOUD_BASE_URL ?? 'https://api.cloud.llamaindex.ai',
    })
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
      file_name: z
        .string()
        .nullable()
        .describe(
          'File name metadata filter. If not specified, all files are considered. Use only when the file name is exactly known.',
        ),
      file_version: z
        .number()
        .nullable()
        .describe(
          'File version metadata filter. If not specified, all file versions are considered. Only applies when file_name is specified.',
        ),
    }),
    execute: async ({
      query,
      top_k,
      score_threshold,
      rerank_top_n,
      file_name,
      file_version,
    }) => {
      const client = getClient()
      const custom_filters: Record<
        string,
        RetrievalRetrieveParams.FilterTypeUnionStrIntBoolFloat
      > = {}
      if (file_name) {
        custom_filters['file_name'] = { operator: 'eq', value: file_name }
        if (file_version) {
          custom_filters['version'] = { operator: 'eq', value: file_version }
        }
      }
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
        custom_filters:
          Object.keys(custom_filters).length > 0 ? custom_filters : undefined,
      })

      // Build both a human/model-readable formatted string AND a structured
      // citations array that the UI uses to render visual citation chips.
      const formattedParts: string[] = []
      const citations: Citation[] = []
      for (let i = 0; i < response.results.length; i++) {
        const result = response.results[i]
        let excludeCitation = false
        const rerankScore = result.rerank_score ?? null
        if (rerankScore && rerankScore < 0.35) {
          excludeCitation = true
        }
        if (!rerankScore) {
          const hybridScore = result.score ?? null
          if (hybridScore) {
            // normalized = RRF / (2 / (k + 1)), and k is 60
            const normalizedScore = hybridScore / (2 / 61)
            if (normalizedScore < 0.35) {
              excludeCitation = true
            }
          }
        }
        const sf = result.static_fields ?? {}
        const meta = (result.metadata ?? {}) as Record<string, unknown>
        const fileName =
          typeof meta.file_name === 'string' ? meta.file_name : 'unknown file'
        const fileVersion = typeof meta.version === 'number' ? meta.version : 1
        const fileId =
          typeof sf.parsed_directory_file_id === 'string'
            ? sf.parsed_directory_file_id
            : typeof meta.file_id === 'string'
              ? meta.file_id
              : ''
        const attachments = sf.attachments ?? []
        // A chunk that spans pages 4–6 has multiple screenshot + items
        // attachments — one pair per page. Pair them up by page number.
        const pages: CitationPage[] = buildCitationPages(attachments)

        const id = makeCitationId()
        const preview = result.content.slice(0, 500)

        if (!excludeCitation) {
          citations.push({
            id,
            fileName,
            fileId,
            version: fileVersion,
            pageStart: sf.page_range_start ?? null,
            pageEnd: sf.page_range_end ?? null,
            pages,
            preview,
            score: result.rerank_score ?? result.score ?? null,
          })
        }

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
      const getFileVersion = async (fileId: string) => {
        const outputId = await getOutputDirectoryId(indexId, llamaCloudApiKey)
        const fl = await client.beta.directories.files.get(fileId, {
          directory_id: outputId,
          expand: ['metadata'],
        })
        return fl.metadata?.version ?? 1
      }
      const files: Array<{
        fileName: string
        fileId: string
        version: number
      }> = []
      for await (const item of client.beta.retrieval.find({
        index_id: indexId,
        project_id: getProjectId(),
        file_name: file_name,
        file_name_contains: file_name_contains,
      })) {
        files.push({
          fileName: item.file_name,
          fileId: item.file_id,
          version: (await getFileVersion(item.file_id)) as number,
        })
      }
      const ls = files
        .map((f) => `- ${f.fileName} (ID: ${f.fileId}, Version: ${f.version})`)
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

/**
 * Build per-provider options that turn on reasoning streaming. Without
 * these, GPT-5 / Claude 4 will not emit reasoning parts even though both
 * are reasoning-capable. The AI SDK's UI message stream forwards
 * reasoning by default (sendReasoning defaults to true), so all we need
 * to do is ask the provider to produce it.
 */
function reasoningProviderOptions(model: string): ProviderOptions {
  if (model.startsWith('anthropic/')) {
    // Claude 4 family: extended thinking. Adaptive lets the model decide
    // how much to think; 'summarized' display gives us a streamable
    // reasoning text without exposing raw thinking tokens.
    return {
      anthropic: {
        thinking: { type: 'adaptive', display: 'summarized' },
      },
    }
  }
  if (model.startsWith('openai/')) {
    // GPT-5 family is a reasoning model. 'medium' effort is a sensible
    // default; 'auto' summary asks OpenAI to stream a human-readable
    // summary of the chain-of-thought.
    return {
      openai: {
        reasoningEffort: 'medium',
        reasoningSummary: 'auto',
      },
    }
  }
  return {}
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
    providerOptions: reasoningProviderOptions(model),
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
        - **ALWAYS begin every conversation and every new query by calling \`findFiles\` with no arguments to list all available documents in the index. Do this before any other tool call, without exception — even if the user's question seems straightforward.**
        - Use \`retrieve\` for broad semantic questions ("what does this contract say about termination?").
        - Use \`findFiles\` when the user references a specific document by name.
        - Use \`readFile\` to read a full document or a specific section when precision is needed.
        - Use \`grepFile\` to locate specific clauses, terms, or patterns within a known document.
        - Prefer chaining tools: retrieve to find candidates, then readFile or grepFile to confirm exact wording.
        - **Tool call order for every query:**
          1. \`findFiles\` (no args) — establish the full document inventory
          2. \`retrieve\` or \`findFiles\` (with name) — narrow to relevant candidates
          3. \`readFile\` or \`grepFile\` — confirm exact wording before citing

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
