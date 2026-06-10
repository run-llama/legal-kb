import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/about')({
  component: About,
})

function About() {
  return (
    <main className="page-wrap px-4 py-12 space-y-6">
      <section className="island-shell rounded-2xl p-6 sm:p-8">
        <p className="island-kicker mb-2">About legal-kb</p>
        <h1 className="display-title mb-3 text-4xl font-bold text-[var(--sea-ink)] sm:text-5xl">
          A knowledge base for legal teams, designed for agents.
        </h1>
        <p className="m-0 max-w-3xl text-base leading-8 text-[var(--sea-ink-soft)]">
          legal-kb is a thin, opinionated workspace on top of LlamaIndex's{' '}
          <strong>Index v2</strong>, the knowledge base purpose-built for the
          agentic retrieval era. It's also available directly on the{' '}
          <a
            href="https://cloud.llamaindex.ai"
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-[var(--lagoon-deep)] underline underline-offset-2"
          >
            LlamaParse Platform
          </a>
          . The goal: make it trivial for legal teams to organize a corpus and
          point an agent at it.
        </p>
      </section>

      <section className="island-shell rounded-2xl p-6 sm:p-8">
        <p className="island-kicker mb-2">Core concepts</p>
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <h2 className="mb-2 text-lg font-semibold text-[var(--sea-ink)]">
              Projects ↔ Indexes
            </h2>
            <p className="m-0 text-sm leading-7 text-[var(--sea-ink-soft)]">
              Each project you create in legal-kb is mirrored 1:1 by an Index
              v2 in your LlamaCloud account. Delete a project here, the index
              goes away there. Add files here, they're parsed and ingested
              there.
            </p>
          </div>
          <div>
            <h2 className="mb-2 text-lg font-semibold text-[var(--sea-ink)]">
              Files
            </h2>
            <p className="m-0 text-sm leading-7 text-[var(--sea-ink-soft)]">
              Upload contracts, briefs, court filings, memos, exhibits, case
              law. LlamaParse handles the document understanding so the index
              ends up with high-fidelity, structured chunks.
            </p>
          </div>
          <div>
            <h2 className="mb-2 text-lg font-semibold text-[var(--sea-ink)]">
              The Agent
            </h2>
            <p className="m-0 text-sm leading-7 text-[var(--sea-ink-soft)]">
              Once your project has files, you can chat with an agent that has
              real tools: <code>read</code> a specific document,{' '}
              <code>grep</code> for exact strings, <code>find</code> files by
              name or metadata, and run <strong>index-wide hybrid search</strong>{' '}
              (semantic + keyword) across everything in the project.
            </p>
          </div>
          <div>
            <h2 className="mb-2 text-lg font-semibold text-[var(--sea-ink)]">
              Bring your own keys
            </h2>
            <p className="m-0 text-sm leading-7 text-[var(--sea-ink-soft)]">
              legal-kb runs against your own LlamaCloud project and your own
              OpenAI or Anthropic key. Authentication is handled via WorkOS
              AuthKit — your credentials only ever leave the browser to reach
              the providers you choose.
            </p>
          </div>
        </div>
      </section>

      <section className="island-shell rounded-2xl p-6 sm:p-8">
        <p className="island-kicker mb-2">What you'll need</p>
        <ul className="m-0 list-disc space-y-2 pl-5 text-sm text-[var(--sea-ink-soft)]">
          <li>
            A LlamaCloud account at{' '}
            <a
              href="https://cloud.llamaindex.ai"
              target="_blank"
              rel="noreferrer"
              className="font-semibold underline"
            >
              cloud.llamaindex.ai
            </a>
            , with an API key and a project ID.
          </li>
          <li>An OpenAI or Anthropic API key for the chat agent.</li>
          <li>Your legal documents — that part is up to you.</li>
        </ul>
      </section>
    </main>
  )
}
