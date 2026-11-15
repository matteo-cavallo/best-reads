/** Cross-module: real sqlite repo + fake metadata + HTTP + MCP SDK Streamable HTTP client (static bearer). */
import { readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/connection.js";
import { createSqliteRepository } from "../src/db/sqlite.js";
import { createFakeMetadataClient } from "../src/openlibrary/fakeClient.js";
import { createAppHandle, type AppHandle } from "../src/http.js";
import type { BookCandidate } from "../src/types.js";

const STATIC = "static-token-for-tests-0123456789";
const dune: BookCandidate = {
  olWorkKey: "/works/OL893415W", olEditionKey: "OL1M", title: "Dune", subtitle: null, authors: ["Frank Herbert"],
  firstPublishYear: 1965, isbn10: null, isbn13: "9780441172719", publisher: "Ace", pageCount: 604, language: "eng",
  subjects: ["Science fiction"], description: "Desert planet.", coverUrl: "https://covers.openlibrary.org/b/id/1-M.jpg",
};

let server: Server;
let handle: AppHandle;
let client: Client;

const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> };
const text = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: "test", STATIC_BEARER_TOKEN: STATIC });
  const db = openDatabase(":memory:");
  const deps = { repo: createSqliteRepository(db), metadata: createFakeMetadataClient([dune]) };
  handle = createAppHandle({ config, db, deps });
  await new Promise<void>((r) => { server = handle.app.listen(0, "127.0.0.1", () => r()); });
  const port = (server.address() as AddressInfo).port;
  client = new Client({ name: "it", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${STATIC}` } },
    }),
  );
});
afterAll(async () => {
  await client.close();
  handle.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("full stack over HTTP", () => {
  it("lists tools with UI metadata and UI resources", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const n of ["search_library", "add_book", "log_reading", "add_note", "get_recommendation_context"]) expect(names).toContain(n);
    const withUi = tools.tools.filter((t) => (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri);
    expect(withUi.length).toBeGreaterThanOrEqual(2);
    const res = await client.listResources();
    expect(res.resources.some((r) => r.uri.startsWith("ui://"))).toBe(true);
    const uri = res.resources.find((r) => r.uri.startsWith("ui://"))!.uri;
    const read = await client.readResource({ uri });
    expect(read.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
  });

  it("add_book -> log_reading -> add_note -> get_recommendation_context", async () => {
    const added = await call("add_book", { title: "Dune", shelf: "reading" });
    expect(added.isError).toBeFalsy();
    expect(added.structuredContent?.kind).toBe("book-card");
    const id = (added.structuredContent as { detail: { book: { id: number } } }).detail.book.id;

    expect((await call("log_reading", { bookId: id, finishedAt: "2024-05-01", rating: 5 })).isError).toBeFalsy();
    expect((await call("add_note", { bookId: id, kind: "highlight", body: "Fear is the mind-killer." })).isError).toBeFalsy();

    const ctx = await call("get_recommendation_context", {});
    expect(text(ctx)).toContain("Dune");
    expect(JSON.stringify(ctx.structuredContent)).toContain("Dune");

    const found = await call("search_library", { query: "mind-killer" });
    expect(text(found)).toContain("Dune");

    expect((await call("get_book", { bookId: 9999 })).isError).toBe(true);
  });

  it("imports the Goodreads fixture", async () => {
    const dir = "test/fixtures/goodreads";
    const csv = readdirSync(dir).find((f) => f.endsWith(".csv"));
    if (!csv) return;
    const r = await call("import_goodreads_csv", { csv: readFileSync(`${dir}/${csv}`, "utf8") });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.kind).toBe("import-report");
  });
});
