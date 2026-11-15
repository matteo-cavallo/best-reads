import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { NotFoundError } from "../db/repository.js";
import type { ServerDeps, BookCardStructured, BookListStructured, ShelfName } from "../types.js";
import { UI_RESOURCES } from "../types.js";
import { GetBookInput, SearchLibraryInput, SetShelfInput, ShowShelfInput, type GetBookArgs, type SearchLibraryArgs, type SetShelfArgs, type ShowShelfArgs } from "./schemas.js";
import { detailText, ok, safe, summaryLine } from "./result.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const listUi = { ui: { resourceUri: UI_RESOURCES.bookList } };
const cardUi = { ui: { resourceUri: UI_RESOURCES.bookCard } };

export async function bookCard(deps: ServerDeps, bookId: number, action: string | null) {
  const detail = await deps.repo.getBookDetail(bookId);
  if (!detail) throw new NotFoundError("Book", bookId);
  const structured: BookCardStructured = { kind: "book-card", detail, action };
  return ok(detailText(detail, action), structured);
}

function listResult(title: string, shelf: ShelfName | null, query: string | null, total: number, items: BookListStructured["items"], offset: number) {
  const structured: BookListStructured = { kind: "book-list", title, shelf, query, total, items };
  const head = `${title}: ${total} book${total === 1 ? "" : "s"}${items.length < total ? ` (showing ${offset + 1}-${offset + items.length})` : ""}`;
  return ok([head, ...items.map(summaryLine)].join("\n"), structured);
}

export function registerLibraryTools(server: McpServer, deps: ServerDeps): void {
  registerAppTool(
    server,
    "search_library",
    {
      title: "Search my library",
      description:
        "Search the user's own Best Reads library (books already added) by text, shelf, rating or finish date. Returns book ids to use with other tools. Shows an inline list in MCP Apps hosts.",
      inputSchema: SearchLibraryInput,
      annotations: READ_ONLY,
      _meta: listUi,
    },
    safe(async (a: SearchLibraryArgs) => {
      const page = await deps.repo.searchLibrary({ ...a, q: a.query });
      const title = a.query ? `Search: "${a.query}"` : a.shelf ? `Library: ${a.shelf}` : "Library";
      return listResult(title, a.shelf ?? null, a.query ?? null, page.total, page.items, a.offset);
    }) as never,
  );

  registerAppTool(
    server,
    "show_shelf",
    {
      title: "Show shelf",
      description: "Browse a shelf (to-read, reading, read) or the whole library as a list view. Omit shelf for everything.",
      inputSchema: ShowShelfInput,
      annotations: READ_ONLY,
      _meta: listUi,
    },
    safe(async (a: ShowShelfArgs) => {
      const page = await deps.repo.searchLibrary({ shelf: a.shelf, limit: a.limit, offset: a.offset, sort: "added_desc" });
      const title = a.shelf ? `Shelf: ${a.shelf}` : "Library";
      return listResult(title, a.shelf ?? null, null, page.total, page.items, a.offset);
    }) as never,
  );

  registerAppTool(
    server,
    "get_book",
    {
      title: "Get book details",
      description: "Full details of one library book: metadata, shelf, reading history, notes and highlights.",
      inputSchema: GetBookInput,
      annotations: READ_ONLY,
      _meta: cardUi,
    },
    safe(async (a: GetBookArgs) => bookCard(deps, a.bookId, null)) as never,
  );

  registerAppTool(
    server,
    "set_shelf",
    {
      title: "Move book to shelf",
      description: "Put a library book on a shelf (to-read, reading, read), or pass shelf=null to remove it from all shelves.",
      inputSchema: SetShelfInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: cardUi,
    },
    safe(async (a: SetShelfArgs) => {
      if (a.shelf === null) {
        if (!(await deps.repo.getBook(a.bookId))) throw new NotFoundError("Book", a.bookId);
        await deps.repo.clearShelf(a.bookId);
        return bookCard(deps, a.bookId, "Removed from shelves");
      }
      await deps.repo.setShelf(a.bookId, a.shelf);
      return bookCard(deps, a.bookId, `Moved to ${a.shelf}`);
    }) as never,
  );
}
