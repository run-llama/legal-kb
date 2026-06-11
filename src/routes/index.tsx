import { createFileRoute, Link } from '@tanstack/react-router'
import { useAuth } from '@workos-inc/authkit-react'

export const Route = createFileRoute('/')({
  ssr: false,
  component: App,
})

function App() {
  const { user, isLoading, signIn } = useAuth()

  return (
    <main className="page-wrap px-4 pb-8 pt-14">
      <section className="island-shell rise-in relative overflow-hidden rounded-[2rem] px-6 py-10 sm:px-10 sm:py-14">
        <div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(79,184,178,0.32),transparent_66%)]" />
        <div className="pointer-events-none absolute -bottom-20 -right-20 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(47,106,74,0.18),transparent_66%)]" />
        <p className="island-kicker mb-3">legal-kb · powered by LlamaIndex</p>
        <h1 className="display-title mb-5 max-w-3xl text-4xl leading-[1.02] font-bold tracking-tight text-[var(--sea-ink)] sm:text-6xl">
          A knowledge base for legal documents, built for the agentic era.
        </h1>
        <p className="mb-8 max-w-2xl text-base text-[var(--sea-ink-soft)] sm:text-lg">
          legal-kb is a workspace for organizing legal documents into projects,
          backed one-to-one by indexes on LlamaIndex's <strong>Index v2</strong>{' '}
          — the knowledge base purpose-built for agentic retrieval, available on
          the{' '}
          <a
            href="https://cloud.llamaindex.ai"
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-[var(--lagoon-deep)] underline decoration-[rgba(79,184,178,0.6)] underline-offset-2"
          >
            LlamaParse Platform
          </a>
          . Upload contracts, briefs, filings and case law, then chat with an
          agent that can <code>read</code>, <code>grep</code>, <code>find</code>{' '}
          and run index-wide hybrid search across everything you've ingested.
        </p>

        <div className="flex flex-wrap gap-3">
          {isLoading ? (
            <span className="rounded-full border border-[rgba(23,58,64,0.2)] bg-white/50 px-5 py-2.5 text-sm font-semibold text-[var(--sea-ink-soft)]">
              Loading…
            </span>
          ) : user ? (
            <>
              <Link
                to="/projects"
                className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] no-underline transition hover:-translate-y-0.5 hover:bg-[rgba(79,184,178,0.24)]"
              >
                Go to Projects
              </Link>
              <Link
                to="/chat"
                className="rounded-full border border-[rgba(23,58,64,0.2)] bg-white/50 px-5 py-2.5 text-sm font-semibold text-[var(--sea-ink)] no-underline transition hover:-translate-y-0.5 hover:border-[rgba(23,58,64,0.35)]"
              >
                Open Chat
              </Link>
              <Link
                to="/user-profile"
                className="rounded-full border border-[rgba(23,58,64,0.2)] bg-white/50 px-5 py-2.5 text-sm font-semibold text-[var(--sea-ink)] no-underline transition hover:-translate-y-0.5 hover:border-[rgba(23,58,64,0.35)]"
              >
                Profile & API Keys
              </Link>
            </>
          ) : (
            <>
              <button
                onClick={() => signIn()}
                className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:-translate-y-0.5 hover:bg-[rgba(79,184,178,0.24)]"
              >
                Sign in to get started
              </button>
              <Link
                to="/about"
                className="rounded-full border border-[rgba(23,58,64,0.2)] bg-white/50 px-5 py-2.5 text-sm font-semibold text-[var(--sea-ink)] no-underline transition hover:-translate-y-0.5 hover:border-[rgba(23,58,64,0.35)]"
              >
                Learn more
              </Link>
            </>
          )}
        </div>
      </section>

      <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [
            'Projects = Indexes',
            'Every project you create is mirrored 1:1 as an Index v2 in your LlamaCloud account.',
          ],
          [
            'Upload Anything Legal',
            'Drop in PDFs, contracts, briefs and exhibits — parsed by LlamaParse, indexed for retrieval.',
          ],
          [
            'Agentic Retrieval',
            'The agent can read, grep, find specific files, and run hybrid search across the whole index.',
          ],
          [
            'Bring Your Own Keys',
            'Wire up your LlamaCloud project plus OpenAI or Anthropic from the profile page.',
          ],
        ].map(([title, desc], index) => (
          <article
            key={title}
            className="island-shell feature-card rise-in rounded-2xl p-5"
            style={{ animationDelay: `${index * 90 + 80}ms` }}
          >
            <h2 className="mb-2 text-base font-semibold text-[var(--sea-ink)]">
              {title}
            </h2>
            <p className="m-0 text-sm text-[var(--sea-ink-soft)]">{desc}</p>
          </article>
        ))}
      </section>

      <section className="island-shell mt-8 rounded-2xl p-6">
        <p className="island-kicker mb-2">How it works</p>
        <ol className="m-0 list-decimal space-y-2 pl-5 text-sm text-[var(--sea-ink-soft)]">
          <li>
            Sign in and add your LlamaCloud + LLM provider keys on the{' '}
            <Link to="/user-profile" className="font-semibold underline">
              profile page
            </Link>
            .
          </li>
          <li>
            Create a <strong>project</strong> — a matching Index v2 is
            provisioned in your LlamaCloud account.
          </li>
          <li>
            Upload legal documents to the project. They're parsed and indexed
            for agentic retrieval.
          </li>
          <li>
            Open <strong>chat</strong> and let the agent navigate your corpus
            with read/grep/find and hybrid search tools.
          </li>
        </ol>
      </section>
    </main>
  )
}
