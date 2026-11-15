import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { loadConfig } from "../src/config.js";
import { MIGRATIONS } from "../src/db/schema.js";
import { AddBookInput, LogReadingInput } from "../src/tools/schemas.js";
import { MCP_APP_MIME, UI_RESOURCES } from "../src/types.js";

describe("contracts", () => {
  it("MIGRATIONS apply on node:sqlite", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (const m of MIGRATIONS) db.exec(m);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["books", "shelves", "reads", "notes", "oauth_clients", "oauth_codes", "oauth_tokens"]));
  });

  it("config defaults and production guards", () => {
    expect(loadConfig({}).port).toBe(3000);
    expect(() => loadConfig({ NODE_ENV: "production", PUBLIC_URL: "https://x.test" })).toThrow();
    expect(loadConfig({ NODE_ENV: "production", PUBLIC_URL: "https://x.test", OWNER_PASSWORD: "pw" }).auth.ownerPassword).toBe("pw");
  });

  it("input schemas validate", () => {
    expect(AddBookInput.safeParse({}).success).toBe(false);
    expect(AddBookInput.parse({ title: "Dune" }).shelf).toBe("to-read");
    expect(LogReadingInput.safeParse({ bookId: 1, startedAt: "2026-02-01", finishedAt: "2026-01-01" }).success).toBe(false);
    expect(LogReadingInput.safeParse({ bookId: 1, rating: 4 }).success).toBe(true);
  });

  it("registerAppTool/registerAppResource work with SDK 1.x + zod schemas (spike)", async () => {
    expect(RESOURCE_MIME_TYPE).toBe(MCP_APP_MIME);
    const server = new McpServer({ name: "t", version: "0" });
    registerAppTool(
      server,
      "add_book",
      { description: "x", inputSchema: AddBookInput, _meta: { ui: { resourceUri: UI_RESOURCES.bookCard } } },
      async () => ({ content: [{ type: "text", text: "ok" }], structuredContent: { kind: "book-card" } }),
    );
    registerAppResource(server, "Book card", UI_RESOURCES.bookCard, { _meta: { ui: { prefersBorder: true } } }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: "<html></html>" }],
    }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const tools = await client.listTools();
    expect(tools.tools[0]?._meta).toMatchObject({ ui: { resourceUri: UI_RESOURCES.bookCard }, "ui/resourceUri": UI_RESOURCES.bookCard });
    const res = await client.callTool({ name: "add_book", arguments: { title: "Dune" } });
    expect(res.structuredContent).toEqual({ kind: "book-card" });
    const bad = await client.callTool({ name: "add_book", arguments: {} });
    expect(bad.isError).toBe(true);
    const r = await client.readResource({ uri: UI_RESOURCES.bookCard });
    expect(r.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
  });
});
