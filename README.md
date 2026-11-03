# legal-kb

A knowledge base for legal documents, powered by [LlamaIndex Index v2](https://cloud.llamaindex.ai) (the LlamaParse Platform).

Sign in, create a project, upload files, and chat with an agent that can run hybrid semantic search, find/read files, and grep across your documents. Each project is mirrored as a managed LlamaCloud index — uploads are parsed and indexed automatically, and the chat agent queries that index live.

## What's in the box

- **Auth**: WorkOS (AuthKit) — sign-in flow only; user ids drive ownership
- **Storage**: PostgreSQL via Prisma. User API keys are encrypted at rest (AES-256-GCM)
- **Indexing**: LlamaCloud Index v2 — one index per project, files uploaded + synced via the Index v2 API
- **Chat**: Vercel AI SDK 6 (`useChat`) + TanStack Start server route, streaming `UIMessage`s. Markdown rendered with [Streamdown](https://github.com/vercel/streamdown)
- **Persistence**: chat messages stored as full UIMessage JSON, grouped into conversations (multiple threads per project)
- **Models**: pick OpenAI or Anthropic per turn; bring your own keys via the profile page

## Stack

TanStack Start · React 19 · Tailwind v4 · Prisma 7 · Vite · Bun · AI SDK 6 · `@llamaindex/llama-cloud` · WorkOS AuthKit

## Prerequisites

- [Bun](https://bun.sh) (1.3+)
- A PostgreSQL database (local or hosted — Neon, Supabase, Render Postgres all work)
- A [WorkOS](https://workos.com) account with an AuthKit application
- A [LlamaCloud](https://cloud.llamaindex.ai) account (users add their keys via the profile page at runtime, so this isn't strictly needed at boot — but you'll want one to actually use the app)
- An OpenAI and/or Anthropic API key (also added via the profile page)

## Setup

```bash
bun install
cp .env.example .env.local   # then fill it in (see below)
bun run db:push              # apply Prisma schema to your DB
bun run dev                  # http://localhost:5173
```

## Environment variables

All vars live in `.env.local`. Required:

| Variable                   | Purpose                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`             | Postgres connection string (e.g. `postgres://place:holder@host:5432/legal_kb`)                                                                                |
| `ENCRYPTION_KEY`           | **32-byte hex** (64 hex chars) — encrypts user API keys at rest. Generate with `openssl rand -hex 32`. **Rotating this invalidates all stored user keys.** |
| `VITE_WORKOS_CLIENT_ID`    | From your WorkOS AuthKit application                                                                                                                       |
| `VITE_WORKOS_API_HOSTNAME` | Your WorkOS Custom Authentication Domain (or default in dev)                                                                                               |

Optional:

| Variable                 | Purpose                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `NITRO_BUN_IDLE_TIMEOUT` | Bun keep-alive for long-running streams. Set to `255` (maximum) if you see streams getting cut short. |

> User-facing API keys (LlamaCloud, OpenAI, Anthropic) are **not** in env. Each user enters them on `/user-profile`, where they're encrypted with `ENCRYPTION_KEY` and persisted per-user.

## Database

Schema lives in `prisma/schema.prisma`. Useful scripts:

```bash
bun run db:push       # push schema (no migration files) — good for dev
bun run db:migrate    # create a named migration
bun run db:studio     # open Prisma Studio
bun run db:generate   # regenerate Prisma client after editing the schema
```

Core tables:

- `User` — mirrors WorkOS users (lazily upserted)
- `ApiKeys` — encrypted LlamaCloud / OpenAI / Anthropic credentials per user
- `Project` — one row per project; holds the LlamaCloud `indexId`
- `ProjectFile` — files uploaded to a project's index, with sync status
- `Conversation` — chat threads scoped to `(userId, projectId)`
- `Message` — full UIMessage JSON, ordered within a conversation

## Using the app

1. **Sign in** via WorkOS.
2. **Profile** (`/user-profile`): paste your LlamaCloud API key + project id, plus your OpenAI and/or Anthropic key. Saved keys are encrypted server-side.
3. **Projects** (`/projects`): create a project. This creates a new LlamaCloud Index v2 mirror. Upload files (drag/drop or picker). Files sync to the index in the background — status polls until ready.
4. **Chat** (`/chat`): pick a project, start (or pick) a conversation, pick a model, and ask away. The agent has these tools available:
   - **hybrid search** over the project's index
   - **find files** by name/glob
   - **read file** contents
   - **grep** across the project

## Production build

```bash
bun run build
node dist/server/index.mjs
```

The output is a self-contained Node server (via Nitro). Any Node-compatible host works — Render, Fly.io, your own VPS, etc. For host-specific presets (Vercel, Netlify, Cloudflare, AWS Lambda), see [nitro.build/deploy](https://v3.nitro.build/deploy).

Make sure `DATABASE_URL`, `ENCRYPTION_KEY`, and the `VITE_WORKOS_*` vars are set in your production environment. `VITE_*` vars are baked in at build time, the rest are read at runtime.

## Project layout

```
src/
  routes/
    index.tsx           landing page
    chat.tsx            chat UI with conversation sidebar
    projects.tsx        project CRUD + file upload/sync UI
    user-profile.tsx    encrypted API key management
    api/chat.ts         streaming chat endpoint (TanStack Start server route)
  lib/
    agent.ts            AI SDK agent definition + tools
    files.ts            LlamaCloud Index v2 file ops
    projects.ts         project CRUD server fns
    messages.ts         conversation + message persistence
    apiKeys.ts          encrypted credential storage
    crypto.ts           AES-256-GCM helpers
  components/           Header, Footer, etc.
prisma/schema.prisma    DB schema
```

## Scripts

```bash
bun run dev               # vite dev server on :5173
bun run build             # production build
bun run preview           # preview the production build
bun run test              # vitest
bun run lint              # eslint
bun run format            # prettier + eslint --fix
bun run check             # prettier --check
bun run generate-routes   # regenerate routeTree.gen.ts
```

## Troubleshooting

- **"configure your LlamaCloud credentials"** — go to `/user-profile` and add them.
- **Chat stream cut off mid-response** — set `NITRO_BUN_IDLE_TIMEOUT=255` in `.env.local`.
- **`ENCRYPTION_KEY` errors at boot** — must be exactly 64 hex chars (32 bytes). Regenerate with `openssl rand -hex 32`.
- **Files stuck "syncing"** — the projects page polls the index status; if a file errors, LlamaCloud's status will surface the reason. Detach + re-upload usually fixes transient parse failures.

## License

TBD.
