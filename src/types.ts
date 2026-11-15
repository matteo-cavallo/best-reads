/**
 * Shared domain + wire types. THE CONTRACT: all modules (A, B, C, D) import from here.
 * Owner: architect. Implementers must not edit this file; request changes via the orchestrator.
 *
 * Conventions
 *  - ids are integers (SQLite rowid), exposed as `number`.
 *  - `YYYY-MM-DD` = DateOnly (reading dates), `ISO datetime` = IsoDateTime (created/updated, UTC, `toISOString()`).
 *  - ratings are integers 1..5; `null` = unrated (Goodreads 0 => null).
 *  - a book sits on exactly ONE shelf (or none) at a time; re-reads are rows in `reads`.
 */

// ---------------------------------------------------------------- primitives
export type DateOnly = string; // "2026-11-14"
export type IsoDateTime = string; // "2026-11-14T10:00:00.000Z"

export const SHELVES = ["to-read", "reading", "read"] as const;
export type ShelfName = (typeof SHELVES)[number];

export const NOTE_KINDS = ["note", "highlight"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const BOOK_SOURCES = ["openlibrary", "goodreads", "manual"] as const;
export type BookSource = (typeof BOOK_SOURCES)[number];

// ---------------------------------------------------------------- core entities (1:1 with DB rows)
export interface Book {
  id: number;
  /** Open Library work key, e.g. "/works/OL45883W". Unique when present. */
  olWorkKey: string | null;
  /** Open Library edition key, e.g. "/books/OL7353617M". */
  olEditionKey: string | null;
  /** Goodreads "Book Id" (only for CSV imports). Unique when present. */
  goodreadsId: string | null;
  isbn10: string | null;
  isbn13: string | null;
  title: string;
  subtitle: string | null;
  authors: string[];
  firstPublishYear: number | null;
  publisher: string | null;
  pageCount: number | null;
  language: string | null; // ISO 639-1/-2 as given by source
  subjects: string[];
  description: string | null;
  coverUrl: string | null;
  source: BookSource;
  createdAt: IsoDateTime;
}

/** Fields accepted when creating/upserting a book (ids/timestamps are assigned by the repository). */
export type NewBook = Omit<Book, "id" | "createdAt">;

export interface ShelfEntry {
  bookId: number;
  shelf: ShelfName;
  addedAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ReadEntry {
  id: number;
  bookId: number;
  startedAt: DateOnly | null;
  finishedAt: DateOnly | null;
  rating: number | null; // 1..5
  review: string | null;
  createdAt: IsoDateTime;
}

export interface Note {
  id: number;
  bookId: number;
  kind: NoteKind;
  body: string;
  chapter: string | null;
  page: number | null;
  createdAt: IsoDateTime;
}

// ---------------------------------------------------------------- views built from entities
/** Compact projection used by lists, search results and the book-list UI. */
export interface BookSummary {
  id: number;
  title: string;
  authors: string[];
  firstPublishYear: number | null;
  coverUrl: string | null;
  isbn13: string | null;
  shelf: ShelfName | null;
  /** Rating of the most recent finished read that has a rating; else null. */
  rating: number | null;
  /** finishedAt of the most recent finished read; else null. */
  lastFinishedAt: DateOnly | null;
  noteCount: number;
}

export interface BookDetail {
  book: Book;
  shelf: ShelfName | null;
  /** Newest first (by finishedAt, then startedAt, then id). */
  reads: ReadEntry[];
  /** Newest first. */
  notes: Note[];
}

/** Candidate returned by Open Library (not yet in the library). */
export interface BookCandidate {
  olWorkKey: string;
  olEditionKey: string | null;
  title: string;
  subtitle: string | null;
  authors: string[];
  firstPublishYear: number | null;
  isbn10: string | null;
  isbn13: string | null;
  publisher: string | null;
  pageCount: number | null;
  language: string | null;
  subjects: string[];
  description: string | null;
  coverUrl: string | null;
  /** True if a book with the same olWorkKey/isbn13 is already in the library (set by the tool layer, not the client). */
  inLibrary?: boolean;
  /** Library book id when inLibrary. */
  libraryBookId?: number;
}

// ---------------------------------------------------------------- repository inputs/outputs
export interface LibraryQuery {
  /** Free text; case-insensitive substring over title, subtitle, authors, subjects AND note bodies. */
  q?: string;
  shelf?: ShelfName;
  /** Only books with latest-rating >= minRating. */
  minRating?: number;
  /** Only books with latest-rating <= maxRating (unrated excluded when set). */
  maxRating?: number;
  /** Books finished within [finishedFrom, finishedTo] (inclusive). */
  finishedFrom?: DateOnly;
  finishedTo?: DateOnly;
  /** Default "added_desc". */
  sort?: "added_desc" | "added_asc" | "title" | "rating_desc" | "finished_desc";
  limit?: number; // default 20, max 100
  offset?: number; // default 0
}

export interface LibraryPage {
  total: number;
  items: BookSummary[];
}

export interface UpsertBookResult {
  book: Book;
  /** false when an existing row was matched (by olWorkKey, isbn13, goodreadsId, or normalized title+first author) and merged. */
  created: boolean;
}

export interface LogReadingInput {
  bookId: number;
  /** Sets/overrides start date. */
  startedAt?: DateOnly;
  /** Sets/overrides finish date. */
  finishedAt?: DateOnly;
  rating?: number | null;
  review?: string | null;
  /**
   * Semantics (implemented by repository, atomically):
   *  - Target read = the book's open read (finishedAt IS NULL) if any, else a new read row.
   *  - startedAt given              => target.startedAt = it; shelf -> "reading" unless finishedAt also given.
   *  - finishedAt given             => target.finishedAt = it; shelf -> "read".
   *  - only rating/review given     => applied to the most recent read (create one with no dates if none) and shelf -> "read".
   *  - `newRead: true` forces a new read row (re-read) instead of reusing the open/latest one.
   */
  newRead?: boolean;
}

export interface LogReadingResult {
  read: ReadEntry;
  shelf: ShelfName;
  createdRead: boolean;
}

export interface NewNote {
  bookId: number;
  kind: NoteKind;
  body: string;
  chapter?: string | null;
  page?: number | null;
}

/** One row for bulk import (produced by the Goodreads importer, consumed by Repository.importEntries). */
export interface ImportEntry {
  book: NewBook;
  shelf: ShelfName | null;
  /** Zero or more reads; the importer emits one per Goodreads "Read Count" when dates are unknown. */
  reads: Array<{
    startedAt: DateOnly | null;
    finishedAt: DateOnly | null;
    rating: number | null;
    review: string | null;
  }>;
  /** Private notes / review text become notes of kind "note". */
  notes: Array<{ kind: NoteKind; body: string }>;
  /** Original Goodreads "Date Added" (date only) used for shelf.addedAt. */
  addedAt: DateOnly | null;
}

export interface ImportReport {
  total: number;
  created: number;
  merged: number; // matched an existing book
  skipped: number;
  errors: Array<{ row: number; title?: string; message: string }>;
  warnings: Array<{ row: number; title?: string; message: string }>;
}

// ---------------------------------------------------------------- recommendation context
export interface RecommendationContext {
  generatedAt: IsoDateTime;
  counts: Record<ShelfName, number> & { total: number; rated: number };
  /** Mean of latest ratings, 2 decimals; null when nothing rated. */
  averageRating: number | null;
  /** rating >= 4, sorted rating desc then finishedAt desc. */
  loved: BookSummary[];
  /** rating <= 2, same sort. These are "books the user did not like". */
  disliked: BookSummary[];
  /** Last N finished books (finishedAt desc), any rating. */
  recentReads: BookSummary[];
  currentlyReading: BookSummary[];
  /** Sample of the to-read shelf (oldest first) so Claude can avoid re-suggesting. */
  toRead: BookSummary[];
  topAuthors: Array<{ author: string; books: number; avgRating: number | null }>;
  topSubjects: Array<{ subject: string; books: number; avgRating: number | null }>;
  /** Recent highlights/notes on loved books, newest first (max 10), body truncated to 300 chars. */
  recentNotes: Array<{ bookId: number; title: string; kind: NoteKind; body: string }>;
}

export interface RecommendationOptions {
  /** per-list cap, default 15, max 50 */
  limit?: number;
  /** recent reads window, default 10 */
  recentCount?: number;
}

// ---------------------------------------------------------------- tool structuredContent shapes
// Every tool returns { content: [{type:"text", text}], structuredContent: <one of these> }.
// `kind` is a discriminator the UI resources switch on.

export interface BookListStructured {
  kind: "book-list";
  /** Heading for the view, e.g. "Reading" or `Search: "dune"`. */
  title: string;
  shelf: ShelfName | null;
  query: string | null;
  total: number;
  items: BookSummary[];
}

export interface BookCardStructured {
  kind: "book-card";
  detail: BookDetail;
  /** Set by add_book/set_shelf/log_reading/add_note to describe what just happened, e.g. "Added to to-read". */
  action: string | null;
}

export interface OpenLibraryResultsStructured {
  kind: "openlibrary-results";
  query: string;
  items: BookCandidate[];
}

export interface RecommendationContextStructured {
  kind: "recommendation-context";
  context: RecommendationContext;
}

export interface ImportReportStructured {
  kind: "import-report";
  report: ImportReport;
}

export type ToolStructured =
  | BookListStructured
  | BookCardStructured
  | OpenLibraryResultsStructured
  | RecommendationContextStructured
  | ImportReportStructured;

// ---------------------------------------------------------------- MCP Apps constants
export const UI_RESOURCES = {
  bookList: "ui://best-reads/book-list.html",
  bookCard: "ui://best-reads/book-card.html",
} as const;
export const MCP_APP_MIME = "text/html;profile=mcp-app" as const;
/** Hosts that serve cover images; declared in resource `_meta.ui.csp.resourceDomains`. */
export const COVER_CSP_DOMAINS = ["https://covers.openlibrary.org", "https://*.archive.org"] as const;

// ---------------------------------------------------------------- dependency container
import type { Repository } from "./db/repository.js";
import type { BookMetadataClient } from "./openlibrary/client.js";

/** Everything createMcpServer needs; tests inject fakes. */
export interface ServerDeps {
  repo: Repository;
  metadata: BookMetadataClient;
  /** Clock override for tests. */
  now?: () => Date;
}
