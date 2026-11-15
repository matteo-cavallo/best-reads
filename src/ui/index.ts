import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { COVER_CSP_DOMAINS, UI_RESOURCES } from "../types.js";
import { html as bookCardHtml } from "./bookCard.js";
import { html as bookListHtml } from "./bookList.js";

const pages = [
  { name: "Book list", uri: UI_RESOURCES.bookList, description: "Shelf / search results list with inline book details", html: bookListHtml },
  { name: "Book card", uri: UI_RESOURCES.bookCard, description: "Single book card with reads and notes", html: bookCardHtml },
];

export function registerUiResources(server: McpServer): void {
  for (const p of pages) {
    const meta = { ui: { prefersBorder: true, csp: { resourceDomains: [...COVER_CSP_DOMAINS] } } };
    registerAppResource(server, p.name, p.uri, { description: p.description, mimeType: RESOURCE_MIME_TYPE, _meta: meta }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: p.html, _meta: meta }],
    }));
  }
}
