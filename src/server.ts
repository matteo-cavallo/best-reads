import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerDeps } from "./types.js";
import { registerTools } from "./tools/index.js";
import { registerUiResources } from "./ui/index.js";

export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: "best-reads", version: "0.1.0" },
    {
      instructions:
        "Best Reads is the user's personal reading tracker. Use search_open_library/add_book to add books, set_shelf and log_reading to track progress and ratings, add_note for notes and highlights, and get_recommendation_context to learn their taste before recommending books (you do the reasoning). Book ids (#id) come from tool results.",
    },
  );
  registerTools(server, deps);
  registerUiResources(server);
  return server;
}
