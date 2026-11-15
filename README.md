# Best Reads

A personal reading tracker that Claude uses through a **remote MCP server** (TypeScript, official
`@modelcontextprotocol/sdk`, Streamable HTTP). Claude does the reasoning; the tools return clean data.
There is no standalone web frontend: the only UI is a pair of small **MCP Apps** views (`ui://` HTML
resources) rendered inline by the host (book list / shelf view and book detail card).

See `docs/PLAN.md` for the architecture and the full tool contract.

## Features

- Search Open Library and add books (title, author, ISBN, cover).
- Shelves: `to-read`, `reading`, `read`. Reading log with dates and 1-5 rating. Notes and highlights per book.
- Goodreads CSV import (tool, or CLI for big files).
- `get_recommendation_context`: tastes, recent reads, loved and disliked books (no recommendation logic server-side).

Tools: `search_library`, `search_open_library`, `add_book`, `set_shelf`, `log_reading`, `add_note`,
`get_recommendation_context`, `get_book`, `show_shelf`, `import_goodreads_csv`.

## Requirements

Node 22.13+ (uses the built-in `node:sqlite`), npm.

## Setup

```bash
npm install
cp .env.example .env      # then edit; see the table below
npm run build
npm start                 # reads the environment (export the variables, or use `node --env-file=.env dist/index.js`)
```

Development: `npm run dev` (tsx watch). Checks: `npm run typecheck && npm test && npm run build`.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | Public base URL, no trailing slash. OAuth issuer and resource URL. **Must be https in production** and must match the URL you give Claude. |
| `PORT` | `3000` | |
| `DB_PATH` | `./data/best-reads.db` | SQLite file (needs a persistent disk). `:memory:` for tests. |
| `OWNER_PASSWORD` | unset | Password you type on the OAuth consent page. Required in production unless you only use the static token. |
| `STATIC_BEARER_TOKEN` | unset | Optional token (min 24 chars) accepted in addition to OAuth tokens. For dev, curl, tests. |
| `OPENLIBRARY_BASE_URL`, `OPENLIBRARY_COVERS_URL` | Open Library | |
| `OPENLIBRARY_CONTACT` | unset | Put an email or URL here: it goes into the User-Agent Open Library asks for. |
| `OPENLIBRARY_TIMEOUT_MS` | `8000` | |
| `ACCESS_TOKEN_TTL_S` / `REFRESH_TOKEN_TTL_S` | `3600` / `2592000` | |
| `NODE_ENV` | `development` | `production` enforces https `PUBLIC_URL` and trusts one proxy hop (`X-Forwarded-*`). |

Generate secrets with `openssl rand -base64 32`.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `POST /mcp` | Bearer | Streamable HTTP MCP endpoint (stateless: a fresh server per request). `GET`/`DELETE` return 405. |
| `GET /healthz` | none | `{"ok":true}` |
| `GET /.well-known/oauth-authorization-server` | none | OAuth server metadata |
| `GET /.well-known/oauth-protected-resource/mcp` | none | Protected resource metadata |
| `POST /register` | none | Dynamic client registration |
| `GET /authorize`, `POST /authorize/consent` | owner password | Authorization (PKCE S256) |
| `POST /token`, `POST /revoke` | client | Code exchange, refresh (rotating), revocation |

An unauthenticated `/mcp` call returns `401` with `WWW-Authenticate: Bearer resource_metadata="..."`, which is how Claude
discovers the OAuth flow.

## Adding it as a custom connector in Claude

1. Deploy the server on a public **https** URL (see below) with `PUBLIC_URL=https://your-host` and `OWNER_PASSWORD` set.
2. In Claude (web or desktop): **Settings > Connectors > Add custom connector**. Name: `Best Reads`. URL: `https://your-host/mcp`.
   Leave the OAuth client fields empty (dynamic client registration is supported).
3. Click **Connect**. A Best Reads page opens: type your owner password and press Approve.
4. Enable the connector in a conversation and ask, for example, "Add Dune to my to-read shelf" or "Show my reading shelf".

Single-user: whoever knows the owner password owns the library. Tokens are opaque, stored hashed, refresh tokens rotate,
and wrong-password attempts are limited to 5 per minute per IP.

### Quick local check with curl

```bash
export STATIC_BEARER_TOKEN=$(openssl rand -base64 32)
STATIC_BEARER_TOKEN=$STATIC_BEARER_TOKEN npm run dev &
curl -s localhost:3000/healthz
curl -s localhost:3000/mcp -H "Authorization: Bearer $STATIC_BEARER_TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

To try the connector against a local server, expose it with a tunnel (for example `cloudflared tunnel --url http://localhost:3000`),
and set `PUBLIC_URL` to the tunnel's https URL before starting.

## Importing a Goodreads export

In Goodreads: My Books > Import and export > Export library. Then either ask Claude to call `import_goodreads_csv`
with the CSV text (fine for small exports) or use the CLI on the server host:

```bash
npm run import:goodreads -- goodreads_library_export.csv [--db ./data/best-reads.db] [--dry-run]
```

Re-importing the same file is idempotent.

## Deployment notes

The server needs Node 22.13+ and a **persistent disk** for the SQLite file, so any long-running Node host works:
a VPS, Fly.io (volume), Railway/Render (disk), Docker. Put it behind TLS (reverse proxy or platform edge) and set
`NODE_ENV=production`, `PUBLIC_URL`, `OWNER_PASSWORD`, `DB_PATH` on the volume. Run a single instance (SQLite, in-memory
pending-authorization state and rate-limit counters are per process).

Docker sketch:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production DB_PATH=/data/best-reads.db PORT=3000
VOLUME /data
CMD ["node", "dist/index.js"]
```

**Cloudflare Workers and Vercel are not supported in this MVP.** The storage layer uses `node:sqlite` and the HTTP layer
uses Express, neither of which runs on those runtimes. Porting would mean swapping `Repository` for D1 (Cloudflare) or a
hosted Postgres/libSQL (Vercel), and `src/http.ts` for a fetch-style handler (the MCP endpoint is already stateless, which
helps). Cloudflare can still front a Node host as a proxy/tunnel (`cloudflared`), which also gives you https.

## Security notes

- Production requires an https `PUBLIC_URL` and an owner password and/or static token.
- Consent and token responses are `Cache-Control: no-store`; the consent page cannot be framed.
- `/mcp` allows CORS preflight for browser clients but never uses cookies; authorization is by bearer token only.
- No secrets are logged. Expired codes and tokens are purged at startup and hourly.
