/**
 * SQLite schema + ordered migrations. Owner: architect (contract); A implements the runner in src/db/migrate.ts
 * (PRAGMA user_version based: apply MIGRATIONS[i] when user_version <= i, in a transaction, then set user_version = i+1).
 * Connection pragmas (A): journal_mode=WAL (skip for :memory:), foreign_keys=ON, busy_timeout=5000.
 * Arrays (authors, subjects) are stored as JSON text. Timestamps are ISO-8601 UTC text.
 *
 * The oauth_* tables are OWNED BY D (src/auth/store.ts) but declared here so a single migration creates everything.
 */
export const MIGRATIONS: readonly string[] = [
  /* v1 */ `
CREATE TABLE books (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ol_work_key        TEXT UNIQUE,
  ol_edition_key     TEXT,
  goodreads_id       TEXT UNIQUE,
  isbn10             TEXT,
  isbn13             TEXT,
  title              TEXT NOT NULL,
  subtitle           TEXT,
  authors            TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
  first_publish_year INTEGER,
  publisher          TEXT,
  page_count         INTEGER,
  language           TEXT,
  subjects           TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
  description        TEXT,
  cover_url          TEXT,
  source             TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('openlibrary','goodreads','manual')),
  match_key          TEXT NOT NULL,                -- normalized "title|first author" for dedupe
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_books_isbn13 ON books(isbn13);
CREATE INDEX idx_books_match_key ON books(match_key);

-- One shelf per book (the three MVP shelves). Re-reads live in \`reads\`.
CREATE TABLE shelves (
  book_id    INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  shelf      TEXT NOT NULL CHECK (shelf IN ('to-read','reading','read')),
  added_at   TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_shelves_shelf ON shelves(shelf);

CREATE TABLE reads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  started_at  TEXT,                                -- YYYY-MM-DD
  finished_at TEXT,                                -- YYYY-MM-DD
  rating      INTEGER CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  review      TEXT,
  created_at  TEXT NOT NULL,
  CHECK (started_at IS NULL OR finished_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX idx_reads_book ON reads(book_id);
CREATE INDEX idx_reads_finished ON reads(finished_at);

CREATE TABLE notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','highlight')),
  body       TEXT NOT NULL,
  chapter    TEXT,
  page       INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notes_book ON notes(book_id);

-- OAuth (single user). Owner: D. Secrets/tokens are stored as sha256 hex, never in clear.
CREATE TABLE oauth_clients (
  client_id   TEXT PRIMARY KEY,
  client_json TEXT NOT NULL,                       -- OAuthClientInformationFull as JSON
  created_at  TEXT NOT NULL
);
CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  resource       TEXT,
  scopes         TEXT NOT NULL DEFAULT '[]',
  expires_at     INTEGER NOT NULL                  -- epoch seconds; single use (deleted on exchange)
);
CREATE TABLE oauth_tokens (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id   TEXT NOT NULL,
  scopes      TEXT NOT NULL DEFAULT '[]',
  resource    TEXT,
  expires_at  INTEGER NOT NULL,                    -- epoch seconds
  pair_id     TEXT NOT NULL                        -- links access+refresh issued together (rotation/revoke)
);
CREATE INDEX idx_oauth_tokens_expires ON oauth_tokens(expires_at);
`,
];
