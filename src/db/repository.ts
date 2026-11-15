/**
 * Storage contract (interface only). Implementation: src/db/sqlite.ts (owner A).
 * All methods are async so a D1/Postgres implementation can replace SQLite later.
 * Implementations must be safe for the single-user case; no multi-tenant scoping in the MVP.
 */
import type {
  Book,
  BookDetail,
  ImportEntry,
  ImportReport,
  LibraryPage,
  LibraryQuery,
  LogReadingInput,
  LogReadingResult,
  NewBook,
  NewNote,
  Note,
  RecommendationContext,
  RecommendationOptions,
  ShelfEntry,
  ShelfName,
  UpsertBookResult,
} from "../types.js";

export interface Repository {
  /**
   * Insert a book or merge into an existing one. Match order: olWorkKey, isbn13, goodreadsId,
   * then normalized (lowercase, accent/punctuation-stripped) title + first author.
   * On merge: keep existing non-null fields, fill gaps from input, union subjects.
   * Does NOT touch shelves.
   */
  upsertBook(input: NewBook): Promise<UpsertBookResult>;

  getBook(id: number): Promise<Book | null>;
  /** Full card data: book + shelf + reads + notes. */
  getBookDetail(id: number): Promise<BookDetail | null>;
  /** Look up by external identifiers (used by add_book to detect duplicates before inserting). */
  findBookByExternalIds(ids: { olWorkKey?: string | null; isbn13?: string | null; goodreadsId?: string | null }): Promise<Book | null>;

  searchLibrary(query: LibraryQuery): Promise<LibraryPage>;

  /** Put a book on a shelf (replacing its current shelf). Throws NotFoundError if the book does not exist. */
  setShelf(bookId: number, shelf: ShelfName): Promise<ShelfEntry>;
  /** Remove the book from every shelf (book row and notes are kept). */
  clearShelf(bookId: number): Promise<void>;
  getShelf(bookId: number): Promise<ShelfEntry | null>;

  /** See LogReadingInput docs for exact semantics. Validates rating 1..5 and finishedAt >= startedAt. */
  logReading(input: LogReadingInput): Promise<LogReadingResult>;

  addNote(input: NewNote): Promise<Note>;

  getRecommendationContext(options?: RecommendationOptions): Promise<RecommendationContext>;

  /** Transactional bulk import (all-or-nothing per call; row-level failures are reported, not thrown). */
  importEntries(entries: ImportEntry[]): Promise<ImportReport>;

  close(): Promise<void>;
}

/** Thrown for unknown ids. Tool layer maps it to an `isError` tool result. */
export class NotFoundError extends Error {
  constructor(what: string, id: number | string) {
    super(`${what} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

/** Thrown for invalid arguments the zod layer cannot catch (e.g. finishedAt before startedAt). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
