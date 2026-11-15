import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerDeps } from "../types.js";
import { registerImportTool } from "./import.js";
import { registerLibraryTools } from "./library.js";
import { registerOpenLibraryTools } from "./openlibrary.js";
import { registerReadingTools } from "./reading.js";
import { registerRecommendationTool } from "./recommendation.js";

export function registerTools(server: McpServer, deps: ServerDeps): void {
  registerLibraryTools(server, deps);
  registerOpenLibraryTools(server, deps);
  registerReadingTools(server, deps);
  registerRecommendationTool(server, deps);
  registerImportTool(server, deps);
}
