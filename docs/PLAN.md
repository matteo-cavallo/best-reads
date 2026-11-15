# Best Reads — MVP plan

Reading tracker used by Claude through a **remote MCP server** (TypeScript, official SDK, Streamable HTTP).
Claude reasons; tools return clean, structured data. No standalone web frontend: the only UI is
**MCP Apps** views (`ui://` HTML resources) rendered inline by the host.

Status: contracts are written and compile (`npm run typecheck`, `npm test` pass). Implementers fill in the modules below.

## 0. Verified facts (do not re-guess)

| Item | Decision / fact (checked in `node_modules`) |
|---|---|
| `@modelcontextprotocol/sdk` | **1.32.2**. Has `server/auth/*` (`mcpAuthRouter`, `OAuthServerProvider`, `requireBearerAuth`), `McpServer.registerTool/registerResource`, `StreamableHTTPServerTransport` (Node/Express), `InMemoryTransport` for tests. |
| `@modelcontextprotocol/ext-apps` | Latest is 2.x but **2.x peers on the new `@modelcontextprotocol/server` v2 package** (no `sdk` 1.x, no express auth router). We pin **1.7.5** (peer `sdk ^1.29`). API we use: `registerAppTool`, `registerAppResource`, `RESOURCE_MIME_TYPE` (`"text/html;profile=mcp-app"`), all from `@modelcontextprotocol/ext-apps/server`. `registerAppTool` copies `_meta.ui.resourceUri` to legacy `_meta["ui/resourceUri"]` automatically. A spike in `test/contracts.test.ts` proves tool+resource registration, zod v4 input schemas, and list/call/read through `InMemoryTransport`. |
| zod | 4.x (SDK 1.32 accepts zod objects as `inputSchema` directly). |
| Storage | **`node:sqlite`** (`DatabaseSync`, built into Node ≥22.13, experimental warning only). Works under vitest. Verified: migrations apply, FK pragma works. No native deps. Behind `Repository`. |
| TypeScript | 7.x (`tsc` native). `module/moduleResolution: NodeNext`, so **relative imports need the `.js` suffix**. |
| CSV | `csv-parse` (`csv-parse/sync`). |
| HTTP | `express` 5. |

## 1. Architecture

```
Claude (web/desktop/mobile)  ──HTTPS──▶  /mcp  (Streamable HTTP, stateless: new McpServer+transport per POST)
                                          │  Bearer auth (OAuth 2.1 token  OR  static dev token)
                                          ▼
                              createMcpServer(deps)            deps = { repo: Repository, metadata: BookMetadataClient }
                               ├─ tools (10)  ── structuredContent + text summary
                               └─ ui:// resources (2 HTML apps)
                                          │
                      ┌───────────────────┴──────────────────┐
              Repository (node:sqlite)              BookMetadataClient (Open Library, fetch)
```

Design rules
1. **Tools return data, Claude reasons.** `get_recommendation_context` returns raw facts (loved/disliked/recent/top authors/subjects), never a recommendation.
2. Every tool result = `content: [{type:"text", text: <compact human/LLM readable summary incl. ids>}]` **plus** `structuredContent` (shapes in `src/types.ts`, `*Structured`). The text must be sufficient for hosts without MCP Apps support.
3. Errors: tools never throw to the transport; they return `{ isError: true, content:[{type:"text", text:"..."}] }` (`NotFoundError`, `ValidationError`, `MetadataUnavailableError` mapped to clear messages; zod input errors are produced by the SDK).
4. All external HTTP only inside `BookMetadataClient` (injectable `fetch`). Tests never touch the network.
5. Stateless HTTP: one fresh `McpServer` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per `POST /mcp`; `GET/DELETE /mcp` → 405. Simplest, works behind any proxy/serverless; UI→server `tools/call` are independent requests anyway.
6. Single user. No user_id columns. Multi-user later = add `user_id` to tables + take it from `AuthInfo.extra`.

## 2. Directory layout and file ownership

Parallel work: each owner touches **only** their files. Contract files (architect, already written, **read-only for implementers**) are marked 🔒.

```
package.json, tsconfig*.json, vitest.config.ts, .gitignore, .env.example      🔒
docs/PLAN.md                                                                  🔒
src/types.ts                       shared domain/wire types, UI_RESOURCES      🔒
src/config.ts                      loadConfig(env)                             🔒
src/db/schema.ts                   MIGRATIONS[] (all tables incl. oauth_*)     🔒
src/db/repository.ts               Repository interface, NotFoundError, ValidationError 🔒
src/openlibrary/client.ts          BookMetadataClient, MetadataUnavailableError 🔒
src/tools/schemas.ts               zod input schemas for every tool            🔒
test/contracts.test.ts             contract + SDK spike                        🔒

A  src/db/connection.ts            openDatabase(path): DatabaseSync (pragmas + migrate)
   src/db/migrate.ts               PRAGMA user_version runner over MIGRATIONS
   src/db/sqlite.ts                createSqliteRepository(db): Repository
   src/db/normalize.ts             matchKey(title, authors), isbn helpers (shared with B? B must NOT import; B duplicates minimal isbn cleaning)
   src/db/*.test.ts                A's tests (in-memory db)

B  src/openlibrary/openLibraryClient.ts   createOpenLibraryClient({baseUrl,coversUrl,userAgent,timeoutMs,fetch?}): BookMetadataClient
   src/openlibrary/mapping.ts      Open Library JSON -> BookCandidate
   src/openlibrary/fakeClient.ts   createFakeMetadataClient(candidates: BookCandidate[]): BookMetadataClient   (EXPORTED for C/D tests)
   src/openlibrary/*.test.ts, test/fixtures/openlibrary/*.json
   src/importers/goodreads.ts      parseGoodreadsCsv(csvText): { entries: ImportEntry[]; report: Pick<ImportReport,"total"|"errors"|"warnings"> }
   src/importers/goodreads.test.ts, test/fixtures/goodreads/*.csv
   src/cli/import-goodreads.ts     `npm run import:goodreads -- export.csv [--db path] [--dry-run]` (uses openDatabase+createSqliteRepository from A)

C  src/server.ts                   createMcpServer(deps: ServerDeps): McpServer
   src/tools/index.ts              registerTools(server, deps)
   src/tools/*.ts                  one file per tool group (library.ts, openlibrary.ts, reading.ts, notes.ts, recommendation.ts, import.ts, views.ts), result.ts (helpers: ok(), fail(), summaries)
   src/ui/index.ts                 registerUiResources(server)
   src/ui/bridge.ts                inline JS string: minimal MCP-Apps postMessage client
   src/ui/theme.ts                 inline CSS string (variables, light/dark)
   src/ui/bookList.ts, src/ui/bookCard.ts   export const html: string
   src/tools/*.test.ts, src/ui/*.test.ts, test/server.e2e.test.ts (InMemoryTransport + fakes)

D  src/auth/provider.ts            SingleUserOAuthProvider implements OAuthServerProvider (+ verifyAccessToken incl. static token)
   src/auth/store.ts               SQLite-backed OAuth store using the oauth_* tables
   src/auth/consent.ts             renderConsentPage(), consent POST handler
   src/http.ts                     createApp({config, deps?|createServer}): express.Express
   src/index.ts                    entry: loadConfig → openDatabase → repo, client → createApp → listen
   src/auth/*.test.ts, test/http.e2e.test.ts
   README.md                       setup, env, connecting from Claude, curl examples
```
Integration points that cross owners (exact signatures):
- A→C/D/B-CLI: `openDatabase(path: string): DatabaseSync` and `createSqliteRepository(db: DatabaseSync): Repository`.
- B→C/D: `createOpenLibraryClient(opts): BookMetadataClient`, `createFakeMetadataClient(c: BookCandidate[]): BookMetadataClient`.
- C→D: `createMcpServer(deps: ServerDeps): McpServer`.
- D owns the HTTP `import` of C and A+B; D's e2e test may use `createFakeMetadataClient` and in-memory sqlite.
- Only A writes SQL for books/shelves/reads/notes; only D touches `oauth_*`.

## 3. Database schema

Authoritative SQL: **`src/db/schema.ts` (`MIGRATIONS[0]`)**. Summary:

- `books(id, ol_work_key UNIQUE, ol_edition_key, goodreads_id UNIQUE, isbn10, isbn13, title, subtitle, authors JSON, first_publish_year, publisher, page_count, language, subjects JSON, description, cover_url, source, match_key, created_at)`
- `shelves(book_id PK→books, shelf ∈ {to-read,reading,read}, added_at, updated_at)` — one shelf per book.
- `reads(id, book_id→books, started_at, finished_at, rating 1..5 NULL, review, created_at)` — many per book (re-reads); `CHECK finished>=started`.
- `notes(id, book_id→books, kind ∈ {note,highlight}, body, chapter, page, created_at)`.
- `oauth_clients / oauth_codes / oauth_tokens` — owned by D, hashed secrets.

Behavioural rules (A implements, tests assert):
- Dedupe in `upsertBook`: olWorkKey → isbn13 → goodreadsId → `match_key` (lowercase, NFKD accent-stripped, non-alphanumerics removed, `title|firstAuthor`). Merge fills gaps only.
- "Latest rating" of a book = rating of the read with the greatest `finished_at` (ties → highest id) among reads with non-null rating.
- `searchLibrary` `q`: split on whitespace, every token must match (case-insensitive `LIKE`) one of title/subtitle/authors/subjects/note bodies. `finishedFrom/To` use the latest finished read. `BookSummary.noteCount` is included. Ordering per `sort`; stable tie-break by `books.id DESC`. `limit` default 20, cap 100.
- `logReading`: exact semantics in the doc comment of `LogReadingInput` in `types.ts`.
- `getRecommendationContext`: `loved` rating≥4, `disliked` rating≤2 (rating 3 = neutral, in neither list), `recentReads` by `finished_at desc`, `toRead` oldest-first by shelf `added_at`, `topAuthors/topSubjects` ranked by (books desc, avgRating desc) top 10, `recentNotes` only for loved books, body truncated to 300 chars.
- `importEntries`: wraps everything in one transaction; per-entry try/catch via SAVEPOINT so one bad row lands in `report.errors`. Uses `upsertBook`'s dedupe logic; adds shelf (keeps `addedAt` from entry); adds reads/notes only if an identical read (same dates+rating) / note (same body) is not already present, so re-importing the same CSV is **idempotent**.

## 4. Tools (contract: `src/tools/schemas.ts` + `src/types.ts`)

| Tool | Input (zod) | structuredContent | UI | Notes |
|---|---|---|---|---|
| `search_library` | `SearchLibraryInput` | `BookListStructured` | book-list | Search own library. |
| `search_open_library` | `SearchOpenLibraryInput` | `OpenLibraryResultsStructured` | – | Candidates; sets `inLibrary/libraryBookId` via `repo.findBookByExternalIds`. |
| `add_book` | `AddBookInput` | `BookCardStructured` (`action:"Added to <shelf>"` or `"Already in library"`) | book-card | Resolve: `olWorkKey` → `lookupByWorkKey`; `isbn` → `lookupByIsbn`; else `search({title,author},5)` and take first (if none: isError "No match; try search_open_library"). Dedupe via `upsertBook`; then `setShelf` only if the book had no shelf or was just created. Cover from candidate. |
| `set_shelf` | `SetShelfInput` | `BookCardStructured` | book-card | `shelf:null` → `clearShelf`. |
| `log_reading` | `LogReadingInput` | `BookCardStructured` | book-card | → `repo.logReading`. |
| `add_note` | `AddNoteInput` | `BookCardStructured` | book-card | note or highlight. |
| `get_recommendation_context` | `GetRecommendationContextInput` | `RecommendationContextStructured` | – | Text form is compact Markdown-ish list (title — authors — rating) so it is usable without structuredContent. Tool description tells Claude to reason on it itself. |
| `get_book` | `GetBookInput` | `BookCardStructured` (`action:null`) | book-card | Also the UI's "open details" call. |
| `show_shelf` | `ShowShelfInput` | `BookListStructured` | book-list | Browse a shelf/whole library as a list view. |
| `import_goodreads_csv` | `ImportGoodreadsCsvInput` | `ImportReportStructured` | – | `parseGoodreadsCsv` → `repo.importEntries` (skipped when `dryRun`). Big files should use the CLI instead (documented in the tool description). |

Tool annotations: read-only tools (`search_library`, `search_open_library`, `get_recommendation_context`, `get_book`, `show_shelf`) `readOnlyHint:true`; writers `readOnlyHint:false, destructiveHint:false`; `idempotentHint:true` for `set_shelf`; `openWorldHint:true` for the two Open Library–touching tools.
Titles are human-readable (`title` field on each tool).

Text summary format (C): first line = outcome; then one line per book: `#<id> <title> — <authors> (<year>) [<shelf>] ★<rating>`; ids always present so Claude can chain calls.

## 5. Importer: Goodreads CSV (B)

`parseGoodreadsCsv(text)` uses `csv-parse/sync` (`columns:true, bom:true, relax_column_count:true, skip_empty_lines:true`).
Columns used: `Book Id, Title, Author, Additional Authors, ISBN, ISBN13, My Rating, Publisher, Number of Pages, Year Published, Original Publication Year, Date Read, Date Added, Exclusive Shelf, Bookshelves, My Review, Private Notes, Read Count`.
Rules
- ISBN cells look like `="0143105426"` → strip `=`/quotes/hyphens; empty → null. Validate length 10/13.
- Title may contain a series suffix `Title (Series, #1)` → keep full title in `title`, no extraction in MVP.
- Authors = `Author` + `Additional Authors` split on `,`, trimmed, deduped.
- `My Rating` 0 → null. `Exclusive Shelf` ∈ {`to-read`,`currently-reading`→`reading`,`read`}; unknown → null shelf + warning.
- Dates `YYYY/MM/DD` (also tolerate `MM/DD/YYYY`, ISO) → `YYYY-MM-DD`. Invalid → null + warning.
- Reads: shelf `read` → one read (`finishedAt = Date Read`, rating, review); `Read Count` > 1 adds extra undated reads (no rating). Shelf `reading` → open read with `startedAt = Date Added`? **No**: leave null dates (don't invent data). `to-read` → no reads.
- `My Review` → `review` on the read (not duplicated as a note); `Private Notes` → note kind `note`.
- `source: "goodreads"`, `goodreadsId = Book Id`, `olWorkKey=null`, `coverUrl=null` (no cover enrichment in MVP; if `isbn13` exists, B sets `coverUrl = https://covers.openlibrary.org/b/isbn/<isbn13>-M.jpg`).
- Header validation: if `Title` or `Exclusive Shelf` is missing, return a single error "Not a Goodreads export" and no entries.
- Fixtures: a 6–8 row CSV with quoted commas/newlines, BOM, `="..."` ISBNs, rating 0, to-read/reading/read rows, a duplicate row, a bad date.

## 6. Open Library client (B)

Endpoints (JSON):
- `GET {base}/search.json?q=...|title=...&author=...|isbn=...&limit=N&fields=key,title,subtitle,author_name,first_publish_year,isbn,publisher,number_of_pages_median,language,subject,cover_i,cover_edition_key,edition_key`
- Work description: `GET {base}/works/OL..W.json` (only in `lookupByWorkKey`; `description` may be string or `{value}`).
- ISBN: `GET {base}/isbn/{isbn}.json` → edition (follow `works[0].key` for work key/description) — or use search `isbn=`; B's choice, covered by fixtures.
- Cover: `{coversUrl}/b/id/{cover_i}-M.jpg` (else `/b/isbn/{isbn13}-M.jpg`, else null).
Requirements: `User-Agent` header from config, `AbortSignal.timeout(timeoutMs)`, 1 retry on 5xx/429 with 300 ms backoff, any failure → `MetadataUnavailableError`, 404 on lookups → `null`, max 20 results, ISBN normalised, missing fields → null/[] (never undefined). Subjects capped at 10. All parsing is unit-tested from recorded-shape fixtures with an injected `fetch`.
Google Books fallback: out of MVP (interface already allows a second implementation).

## 7. Auth design (D)

Goal: Claude's remote connectors require OAuth 2.1 with PKCE and Dynamic Client Registration; single-user, so "login" = owner password.

- Use the SDK pattern: `mcpAuthRouter({ provider, issuerUrl: new URL(publicUrl), resourceServerUrl: new URL(publicUrl + "/mcp"), scopesSupported:["library"], resourceName:"Best Reads" })` mounted at app root. It serves `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`, `/authorize`, `/token`, `/register` (DCR), `/revoke`. (D must verify the exact well-known path emitted by the installed SDK version and that `requireBearerAuth({ verifier, resourceMetadataUrl })` points at it.)
- `SingleUserOAuthProvider implements OAuthServerProvider`:
  - `clientsStore`: `getClient`/`registerClient` backed by `oauth_clients` (generate `client_id` = random 24 bytes hex; public clients allowed: `token_endpoint_auth_method:"none"`).
  - `authorize(client, params, res)`: renders the consent page (HTML form: owner password, client name, redirect host, hidden fields = signed/stored pending request id). Pending request kept in memory map with 10 min TTL (key = random id) holding `{clientId, params}`.
  - `POST /authorize/consent` (D's express route, rate-limited: 5 attempts/min/IP, constant-time compare `timingSafeEqual` on sha256 of the password): on success create auth code (random 32 bytes, stored hashed in `oauth_codes`, TTL 10 min, single use) and `302` to `redirectUri?code=…&state=…`. On failure re-render with an error (no redirect). If `ownerPassword` is not configured, consent always fails (503 page) — auth by static token only.
  - `challengeForAuthorizationCode`, `exchangeAuthorizationCode` (SDK validates PKCE S256 locally; we delete the code on use, check `redirect_uri` + `resource`), `exchangeRefreshToken` (rotation: old refresh deleted, new pair issued), `revokeToken`.
  - Tokens: opaque, 32 random bytes base64url, stored as sha256. Access TTL = `accessTokenTtlS`, refresh TTL = `refreshTokenTtlS`. `resource` stored and compared (RFC 8707) when given.
  - `verifyAccessToken(token)`: (1) if `config.auth.staticBearerToken` is set and `timingSafeEqual` matches → `{ token, clientId:"static", scopes:["library"], expiresAt: now+3600 }` — **dev/tests/curl fallback**; (2) else lookup hash in `oauth_tokens` (kind access, not expired). Failure throws `InvalidTokenError`.
- `/mcp` route: `requireBearerAuth({ verifier: provider, resourceMetadataUrl })`; unauthenticated → `401` + `WWW-Authenticate: Bearer resource_metadata="…"` so Claude starts the OAuth flow.
- Housekeeping: delete expired codes/tokens on startup and hourly (`setInterval(...).unref()`).
- Security: HTTPS enforced by deployment (config requires https in production); `Cache-Control: no-store` on consent/token; no secrets in logs; CORS: `Access-Control-Allow-Origin: *` is NOT enabled globally; allow CORS only for `/.well-known/*` and `/register`,`/token` as the SDK router does; `/mcp` also needs `Mcp-Session-Id`,`Mcp-Protocol-Version` exposed/allowed headers if browser-based clients are used (cors middleware on `/mcp` with `Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id`).
- `GET /healthz` → `{ok:true}` unauthenticated.

## 8. MCP Apps UI (C)

Two small, self-contained, single-file HTML resources (inline CSS+JS strings, **no external scripts, no frameworks, no network except cover images**). Registered with `registerAppResource(server, name, uri, config, readCb)`; read callback returns `{ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui: { prefersBorder: true, csp: { resourceDomains: [...COVER_CSP_DOMAINS] } } } }] }` (CSP: covers.openlibrary.org redirects to `*.archive.org`; no `connectDomains`).

| URI | Used by tools | Shows |
|---|---|---|
| `ui://best-reads/book-list.html` | `search_library`, `show_shelf` | Heading + count; responsive list of rows: cover thumbnail (fallback: coloured initial tile), title, authors · year, shelf pill, stars, finished date, note count. Row click → `callServerTool("get_book")` and the card renders **in place** with a "Back" button. Shelf filter chips (To read / Reading / Read / All) call `show_shelf` and re-render. Empty state text. |
| `ui://best-reads/book-card.html` | `get_book`, `add_book`, `set_shelf`, `log_reading`, `add_note` | Cover + title, authors, year/pages/publisher, shelf pill, `action` banner (e.g. "Added to to-read"), star rating (latest), reads timeline (dates, rating, review), notes/highlights (highlights styled as quotes), description (collapsed after 4 lines). Read-only except a shelf `<select>` that calls `set_shelf`. |

Bridge (`src/ui/bridge.ts`, a string embedded in both pages; implements the documented MCP Apps protocol, protocol version `"2026-01-26"` from `ext-apps` `LATEST_PROTOCOL_VERSION`):
1. JSON-RPC 2.0 over `window.parent.postMessage(msg, "*")`; listen to `message` events whose `source === window.parent`.
2. On load: request `ui/initialize` `{ appInfo:{name:"best-reads-list",version:"0.1.0"}, appCapabilities:{}, protocolVersion }` → result has `hostContext` (`theme: "light"|"dark"`, `styles.variables` CSS vars, `displayMode`). Then notify `ui/notifications/initialized`.
3. Incoming notifications: `ui/notifications/tool-result` (params = CallToolResult; use `params.structuredContent`, discriminated by `kind`), `ui/notifications/tool-input` (ignored), `ui/notifications/host-context-changed` (merge, re-apply theme), `ui/notifications/tool-cancelled`; request `ui/resource-teardown` → reply `{}`.
4. Outgoing: `tools/call` `{name, arguments}` (request/response with ids and a 15 s timeout); `ui/notifications/size-changed {height}` via `ResizeObserver` on `document.body`; `ui/open-link {url}` for external links (none planned).
5. Theming: CSS custom properties with sane light defaults, a `@media (prefers-color-scheme: dark)` block, and `[data-theme="dark"|"light"]` overrides set from `hostContext.theme`; host-provided `--color-*`/`--font-*` variables are applied on `documentElement.style` when present and used as `var(--color-text-primary, <fallback>)`.
6. Safety: all dynamic text inserted with `textContent`/`createElement` (never `innerHTML` with data); cover `src` accepted only if it starts with `https://`.
7. Fallback when no host (opened standalone/test): bridge exposes `window.__bestReadsRender(structuredContent)` so unit tests (jsdom-free: string assertions + a tiny vm smoke test) and manual preview can drive it.
Size budget: each page < 20 KB.

## 9. Test strategy

Vitest, no network, no real clock where it matters (pass `now`), in-memory SQLite (`":memory:"`).
- **A** repository: dedupe/merge, shelf transitions, `logReading` matrix (start, finish, rate-only, re-read, invalid dates/ratings), latest-rating logic, `searchLibrary` filters/sort/paging/notes search, recommendation context (loved/disliked/neutral buckets, truncation), `importEntries` idempotency + SAVEPOINT error isolation, FK cascade, migrations idempotent (`user_version`).
- **B** client: fixtures + injected `fetch` (search/isbn/work, missing fields, 404→null, 500→retry→`MetadataUnavailableError`, timeout, UA header, cover URL building). Importer: fixture CSVs (BOM, quoted newlines, `="isbn"`, rating 0, odd dates, header validation, Read Count, duplicate rows).
- **C** tools via `InMemoryTransport` + `Client` with real in-memory repo and `createFakeMetadataClient`: every tool happy path + error path (`isError`), `structuredContent.kind`, `tools/list` has `_meta.ui.resourceUri` for the 7 UI tools (and legacy key), `resources/list|read` returns mime `text/html;profile=mcp-app`, html contains both theme mechanisms and no `http://`/external `<script src>`, bridge smoke test with `node:vm` (stub `window.parent.postMessage`, feed `ui/notifications/tool-result`, assert DOM-free render function output).
- **D** HTTP e2e (real `listen(0)` + `fetch`): `/healthz`; `/mcp` 401 + `WWW-Authenticate` with resource_metadata; well-known documents; DCR → authorize (PKCE S256) → consent with wrong/right password → token → `/mcp` `initialize` + `tools/list` + a tool call; refresh rotation; revoked/expired token rejected; static bearer works; GET `/mcp` → 405; expired code reuse rejected.
- **Cross-module** (D, final): one test wiring real sqlite repo + fake metadata + HTTP + MCP SDK `StreamableHTTPClientTransport` with static bearer: `add_book` → `log_reading` → `add_note` → `get_recommendation_context` and Goodreads fixture import.
- CI commands: `npm run typecheck && npm test && npm run build`.

## 10. Definition of done (MVP)

1. `npm run typecheck`, `npm test`, `npm run build` green.
2. `npm start` serves `/mcp` with OAuth + static token; README explains deploy (any Node 22 host with persistent disk; Cloudflare/Vercel are post-MVP because of `node:sqlite`) and how to add the connector in Claude (URL `https://<host>/mcp`).
3. All 10 tools work against fakes; UI resources render in an MCP Apps host (manually verified only if a host is available; otherwise bridge smoke tests).
4. Goodreads fixture import is lossless for title/authors/ISBN/shelf/rating/dates/review/notes.

## 11. Deliberately out of MVP
Google Books fallback, covers enrichment for Goodreads imports beyond ISBN URL, custom shelves/tags, per-chapter structure beyond the free `chapter` string, multi-user, rate limiting beyond the consent form, stateful MCP sessions/SSE streams, any standalone web UI, writing to Goodreads.
