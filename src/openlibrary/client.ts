/**
 * Book metadata contract (interface only). Implementation: src/openlibrary/openLibraryClient.ts (owner B).
 * ALL external HTTP lives behind this interface; tests inject fakes or a mocked `fetch`.
 * The implementation takes `{ baseUrl, coversUrl, userAgent, timeoutMs, fetch? }` (see Config.openLibrary).
 */
import type { BookCandidate } from "../types.js";

export interface BookSearchQuery {
  /** Free text (title and/or author). */
  query?: string;
  title?: string;
  author?: string;
  /** ISBN-10 or ISBN-13, hyphens allowed. When present, takes precedence. */
  isbn?: string;
}

export interface BookMetadataClient {
  /** Search candidates. Never returns more than `limit` (default 8, max 20). Empty array when nothing found. */
  search(query: BookSearchQuery, limit?: number): Promise<BookCandidate[]>;
  /** Resolve a single edition/work by ISBN; null when unknown. */
  lookupByIsbn(isbn: string): Promise<BookCandidate | null>;
  /** Resolve by work key ("/works/OL45883W", or bare "OL45883W"); null when unknown. */
  lookupByWorkKey(key: string): Promise<BookCandidate | null>;
}

/** Thrown by implementations on network/HTTP failure/timeouts so tools can answer with a clear isError message. */
export class MetadataUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MetadataUnavailableError";
  }
}
