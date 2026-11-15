/**
 * Full-stack E2E: real HTTP server on an ephemeral port, real sqlite repo, mocked Open Library client,
 * OAuth 2.1 + PKCE login, then the MCP SDK Streamable HTTP client drives the whole MVP flow.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
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

const OWNER = "correct horse battery";
const REDIRECT = "http://127.0.0.1:9999/callback";
const MIME = "text/html;profile=mcp-app";

const hobbit: BookCandidate = {
  olWorkKey: "/works/OL262758W", olEditionKey: "OL1M", title: "The Hobbit", subtitle: null, authors: ["J.R.R. Tolkien"],
  firstPublishYear: 1937, isbn10: null, isbn13: "9780547928227", publisher: "Houghton", pageCount: 300, language: "eng",
  subjects: ["Fantasy"], description: "There and back again.", coverUrl: "https://covers.openlibrary.org/b/id/2-M.jpg",
};

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, any> };

let server: Server;
let handle: AppHandle;
let client: Client;
let base: string;

const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as ToolResult;
const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

async function oauthAccessToken(): Promise<string> {
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "e2e", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    }),
  });
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: "S256", state: "s", scope: "library", resource: `${base}/mcp`,
  }).toString();
  const html = await (await fetch(url, { redirect: "manual" })).text();
  const pending = /name="pending" value="([^"]+)"/.exec(html)?.[1];
  expect(pending).toBeTruthy();
  const consent = await fetch(`${base}/authorize/consent`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending: pending!, password: OWNER }).toString(),
  });
  expect(consent.status).toBe(302);
  const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;
  const tok = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id, code, code_verifier: verifier,
      redirect_uri: REDIRECT, resource: `${base}/mcp`,
    }).toString(),
  });
  expect(tok.status).toBe(200);
  return ((await tok.json()) as { access_token: string }).access_token;
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: "test", OWNER_PASSWORD: OWNER });
  const db = openDatabase(":memory:");
  const deps = { repo: createSqliteRepository(db), metadata: createFakeMetadataClient([hobbit]) };
  handle = createAppHandle({ config, db, deps });
  await new Promise<void>((r) => { server = handle.app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.publicUrl = base;
  const token = await oauthAccessToken();
  client = new Client({ name: "e2e", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  );
});
afterAll(async () => {
  await client?.close();
  handle?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("end to end over HTTP with OAuth", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("lists tools, each UI tool carries _meta.ui.resourceUri that resolves to an MCP Apps resource", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["search_library", "add_book", "log_reading", "add_note", "get_recommendation_context", "import_goodreads_csv"]) {
      expect(names).toContain(n);
    }
    const { resources } = await client.listResources();
    const uiUris = resources.filter((r) => r.uri.startsWith("ui://")).map((r) => r.uri);
    expect(uiUris.length).toBeGreaterThanOrEqual(2);
    for (const r of resources.filter((r) => r.uri.startsWith("ui://"))) expect(r.mimeType).toBe(MIME);

    const uiTools = tools.filter((t) => (t._meta as any)?.ui?.resourceUri);
    expect(uiTools.length).toBeGreaterThanOrEqual(5);
    for (const t of uiTools) expect(uiUris).toContain((t._meta as any).ui.resourceUri);

    for (const uri of uiUris) {
      const read = await client.readResource({ uri });
      expect(read.contents[0]?.mimeType).toBe(MIME);
      const html = String((read.contents[0] as { text?: string }).text);
      expect(html.toLowerCase()).toContain("<html");
      expect(html).not.toMatch(/<script[^>]+src=/i);
    }
  });

  it("flow: import CSV -> search_library -> add_book -> log_reading -> add_note -> get_recommendation_context", async () => {
    const csv = readFileSync(new URL("./fixtures/goodreads/export.csv", import.meta.url), "utf8");
    const dry = await call("import_goodreads_csv", { csv, dryRun: true });
    expect(dry.isError).toBeFalsy();
    const imp = await call("import_goodreads_csv", { csv });
    expect(imp.isError).toBeFalsy();
    expect(text(imp)).toMatch(/import/i);

    const dune = await call("search_library", { query: "Dune" });
    expect(dune.isError).toBeFalsy();
    expect(text(dune)).toContain("Dune");
    const eco = await call("search_library", { query: "Name of the Rose" });
    expect(text(eco)).toContain("Rose");
    const none = await call("search_library", { query: "zzzxqj" });
    expect(text(none)).not.toContain("Dune");

    const added = await call("add_book", { title: "The Hobbit", shelf: "reading" });
    expect(added.isError).toBeFalsy();
    const id = added.structuredContent!.detail.book.id as number;
    expect(added.structuredContent!.detail.book.title).toBe("The Hobbit");
    expect(text(await call("search_library", { query: "Hobbit" }))).toContain("The Hobbit");

    const logged = await call("log_reading", { bookId: id, startedAt: "2024-01-01", finishedAt: "2024-01-20", rating: 5, review: "Loved it" });
    expect(logged.isError).toBeFalsy();
    const detail = (await call("get_book", { bookId: id })).structuredContent!.detail;
    expect(detail.shelf).toBe("read");
    expect(detail.reads[0].rating).toBe(5);

    const note = await call("add_note", { bookId: id, kind: "highlight", body: "Not all those who wander are lost" });
    expect(note.isError).toBeFalsy();
    expect(text(await call("search_library", { query: "wander" }))).toContain("The Hobbit");

    const ctx = await call("get_recommendation_context", {});
    expect(ctx.isError).toBeFalsy();
    const out = text(ctx) + JSON.stringify(ctx.structuredContent);
    expect(out).toContain("The Hobbit");
    expect(out).toContain("Tolkien");
    expect(out).toContain("Dune");
  });

  it("maps errors to isError results", async () => {
    expect((await call("get_book", { bookId: 424242 })).isError).toBe(true);
    expect((await call("import_goodreads_csv", { csv: "not,a,goodreads\n1,2,3" })).isError).toBe(true);
  });
});
