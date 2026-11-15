import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { BookCandidate, NewBook, OpenLibraryResultsStructured, ServerDeps } from "../types.js";
import { UI_RESOURCES } from "../types.js";
import { AddBookInput, SearchOpenLibraryInput, type AddBookArgs, type SearchOpenLibraryArgs } from "./schemas.js";
import { candidateLine, failText, ok, safe } from "./result.js";
import { bookCard } from "./library.js";

export function candidateToNewBook(c: BookCandidate): NewBook {
  return {
    olWorkKey: c.olWorkKey,
    olEditionKey: c.olEditionKey,
    goodreadsId: null,
    isbn10: c.isbn10,
    isbn13: c.isbn13,
    title: c.title,
    subtitle: c.subtitle,
    authors: c.authors,
    firstPublishYear: c.firstPublishYear,
    publisher: c.publisher,
    pageCount: c.pageCount,
    language: c.language,
    subjects: c.subjects,
    description: c.description,
    coverUrl: c.coverUrl,
    source: "openlibrary",
  };
}

export function registerOpenLibraryTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "search_open_library",
    {
      title: "Search Open Library",
      description:
        "Search Open Library for books NOT necessarily in the library yet (title, author, ISBN or free text). Each candidate shows its work key and whether it is already in the library; pass the work key to add_book.",
      inputSchema: SearchOpenLibraryInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (a: SearchOpenLibraryArgs) => {
      const items = await deps.metadata.search({ query: a.query, title: a.title, author: a.author, isbn: a.isbn }, a.limit);
      for (const c of items) {
        const existing = await deps.repo.findBookByExternalIds({ olWorkKey: c.olWorkKey, isbn13: c.isbn13 });
        if (existing) {
          c.inLibrary = true;
          c.libraryBookId = existing.id;
        }
      }
      const query = [a.query, a.title, a.author, a.isbn].filter(Boolean).join(" ");
      const structured: OpenLibraryResultsStructured = { kind: "openlibrary-results", query, items };
      const text = items.length
        ? [`${items.length} Open Library result${items.length === 1 ? "" : "s"} for "${query}":`, ...items.map(candidateLine)].join("\n")
        : `No Open Library results for "${query}".`;
      return ok(text, structured);
    }) as never,
  );

  registerAppTool(
    server,
    "add_book",
    {
      title: "Add book",
      description:
        "Add a book to the library from Open Library and put it on a shelf (default to-read). Prefer olWorkKey from search_open_library; otherwise give isbn, or title (+author) to take the best match. Already-owned books are not duplicated.",
      inputSchema: AddBookInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: UI_RESOURCES.bookCard } },
    },
    safe(async (a: AddBookArgs) => {
      let candidate: BookCandidate | null = null;
      if (a.olWorkKey) {
        const key = a.olWorkKey.startsWith("/works/") ? a.olWorkKey : `/works/${a.olWorkKey}`;
        candidate = await deps.metadata.lookupByWorkKey(key);
      } else if (a.isbn) {
        candidate = await deps.metadata.lookupByIsbn(a.isbn);
      } else {
        candidate = (await deps.metadata.search({ title: a.title, author: a.author }, 5))[0] ?? null;
      }
      if (!candidate) return failText("No match found on Open Library; try search_open_library with different terms.");

      const existing = await deps.repo.findBookByExternalIds({ olWorkKey: candidate.olWorkKey, isbn13: candidate.isbn13 });
      const { book, created } = await deps.repo.upsertBook(candidateToNewBook(candidate));
      const currentShelf = existing || !created ? await deps.repo.getShelf(book.id) : null;
      if (created || !currentShelf) {
        await deps.repo.setShelf(book.id, a.shelf);
        return bookCard(deps, book.id, `Added to ${a.shelf}`);
      }
      return bookCard(deps, book.id, `Already in library (shelf: ${currentShelf.shelf})`);
    }) as never,
  );
}
