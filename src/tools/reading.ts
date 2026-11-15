import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { UI_RESOURCES, type ServerDeps } from "../types.js";
import { AddNoteInput, LogReadingInput, type AddNoteArgs, type LogReadingArgs } from "./schemas.js";
import { safe } from "./result.js";
import { bookCard } from "./library.js";

const meta = { ui: { resourceUri: UI_RESOURCES.bookCard } };
const writer = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export function registerReadingTools(server: McpServer, deps: ServerDeps): void {
  registerAppTool(
    server,
    "log_reading",
    {
      title: "Log reading",
      description:
        "Record reading progress for a library book: startedAt (moves to 'reading'), finishedAt (moves to 'read'), rating 1-5 and/or review. Use newRead=true for a re-read. Dates are YYYY-MM-DD.",
      inputSchema: LogReadingInput,
      annotations: writer,
      _meta: meta,
    },
    safe(async (a: LogReadingArgs) => {
      const r = await deps.repo.logReading(a);
      const what = [
        a.startedAt ? `started ${a.startedAt}` : "",
        a.finishedAt ? `finished ${a.finishedAt}` : "",
        a.rating ? `rated ${a.rating}/5` : a.rating === null ? "rating cleared" : "",
        a.review ? "review saved" : "",
      ].filter(Boolean);
      return bookCard(deps, a.bookId, `Logged (${what.join(", ") || "updated"}); ${r.createdRead ? "new read entry; " : ""}shelf: ${r.shelf}`);
    }) as never,
  );

  registerAppTool(
    server,
    "add_note",
    {
      title: "Add note or highlight",
      description: "Attach a free-text note (the user's thoughts) or a highlight (quoted passage) to a library book, optionally with chapter and page.",
      inputSchema: AddNoteInput,
      annotations: writer,
      _meta: meta,
    },
    safe(async (a: AddNoteArgs) => {
      await deps.repo.addNote({ bookId: a.bookId, kind: a.kind, body: a.body, chapter: a.chapter ?? null, page: a.page ?? null });
      return bookCard(deps, a.bookId, `Added ${a.kind}`);
    }) as never,
  );
}
