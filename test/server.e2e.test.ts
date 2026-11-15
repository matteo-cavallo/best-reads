import { describe, expect, it, beforeEach } from "vitest";
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDatabase } from "../src/db/connection.js";
import { createSqliteRepository } from "../src/db/sqlite.js";
import { createFakeMetadataClient } from "../src/openlibrary/fakeClient.js";
import { MetadataUnavailableError, type BookMetadataClient } from "../src/openlibrary/client.js";
import { createMcpServer } from "../src/server.js";
import { html as listHtml } from "../src/ui/bookList.js";
import { html as cardHtml } from "../src/ui/bookCard.js";
import type { BookCandidate } from "../src/types.js";
import { MCP_APP_MIME, UI_RESOURCES } from "../src/types.js";

const dune: BookCandidate = {
  olWorkKey: "/works/OL893415W", olEditionKey: "/books/OL1M", title: "Dune", subtitle: null, authors: ["Frank Herbert"],
  firstPublishYear: 1965, isbn10: "0441172717", isbn13: "9780441172719", publisher: "Ace", pageCount: 412, language: "eng",
  subjects: ["Science fiction"], description: "Desert planet.", coverUrl: "https://covers.openlibrary.org/b/id/1-M.jpg",
};
const emma: BookCandidate = { ...dune, olWorkKey: "/works/OL1W", olEditionKey: null, title: "Emma", authors: ["Jane Austen"], firstPublishYear: 1815, isbn10: null, isbn13: null, subjects: ["Romance"], coverUrl: null };

async function setup(metadata: BookMetadataClient = createFakeMetadataClient([dune, emma])) {
  const repo = createSqliteRepository(openDatabase(":memory:"));
  const server = createMcpServer({ repo, metadata });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { client, call, repo };
}
const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content)[0]!.text;

describe("tools", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { s = await setup(); });

  it("lists all tools, 7 with ui resourceUri", async () => {
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["add_book", "add_note", "get_book", "get_recommendation_context", "import_goodreads_csv", "log_reading", "search_library", "search_open_library", "set_shelf", "show_shelf"],
    );
    const ui = tools.filter((t) => (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri);
    expect(ui.map((t) => t.name).sort()).toEqual(["add_book", "add_note", "get_book", "log_reading", "search_library", "set_shelf", "show_shelf"]);
    for (const t of ui) expect((t._meta as Record<string, unknown>)["ui/resourceUri"]).toBeTruthy();
    expect(tools.find((t) => t.name === "search_library")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "add_book")!.annotations?.readOnlyHint).toBe(false);
  });

  it("search_open_library flags books in library", async () => {
    let r = await s.call("search_open_library", { query: "dune" });
    expect(r.structuredContent).toMatchObject({ kind: "openlibrary-results" });
    expect((r.structuredContent as any).items[0].inLibrary).toBeUndefined();
    await s.call("add_book", { olWorkKey: "OL893415W" });
    r = await s.call("search_open_library", { query: "dune" });
    expect((r.structuredContent as any).items[0]).toMatchObject({ inLibrary: true, libraryBookId: 1 });
    expect(text(r)).toContain("in library as #1");
  });

  it("add_book by work key, title and isbn; dedupes and keeps shelf", async () => {
    const r = await s.call("add_book", { olWorkKey: "/works/OL893415W", shelf: "reading" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ kind: "book-card", action: "Added to reading", detail: { shelf: "reading" } });
    expect(text(r)).toContain("#1 Dune");
    const again = await s.call("add_book", { isbn: "978-0-441-17271-9", shelf: "read" });
    expect((again.structuredContent as any).action).toContain("Already in library");
    expect((again.structuredContent as any).detail.shelf).toBe("reading");
    const byTitle = await s.call("add_book", { title: "emma", author: "austen" });
    expect((byTitle.structuredContent as any).detail.shelf).toBe("to-read");
  });

  it("add_book errors", async () => {
    expect((await s.call("add_book", { title: "Nothing Matches" })).isError).toBe(true);
    expect((await s.call("add_book", { olWorkKey: "OL999W" })).isError).toBe(true);
    expect((await s.call("add_book", {})).isError).toBe(true);
    const down = await setup({
      search: async () => { throw new MetadataUnavailableError("timeout"); },
      lookupByIsbn: async () => null, lookupByWorkKey: async () => null,
    });
    const r = await down.call("add_book", { title: "Dune" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Open Library is unavailable");
  });

  it("set_shelf, log_reading, add_note, get_book flow", async () => {
    await s.call("add_book", { title: "Dune" });
    let r = await s.call("set_shelf", { bookId: 1, shelf: "reading" });
    expect((r.structuredContent as any).detail.shelf).toBe("reading");
    r = await s.call("log_reading", { bookId: 1, finishedAt: "2026-02-01", rating: 5, review: "Great" });
    expect((r.structuredContent as any).detail.shelf).toBe("read");
    expect((r.structuredContent as any).detail.reads[0]).toMatchObject({ rating: 5, finishedAt: "2026-02-01" });
    r = await s.call("add_note", { bookId: 1, kind: "highlight", body: "Fear is the mind-killer", page: 12 });
    expect((r.structuredContent as any).detail.notes[0]).toMatchObject({ kind: "highlight", page: 12 });
    expect(text(r)).toContain("Fear is the mind-killer");
    r = await s.call("get_book", { bookId: 1 });
    expect((r.structuredContent as any).action).toBeNull();
    r = await s.call("set_shelf", { bookId: 1, shelf: null });
    expect((r.structuredContent as any).detail.shelf).toBeNull();
  });

  it("errors: unknown ids and invalid input", async () => {
    for (const [n, a] of [["get_book", { bookId: 99 }], ["set_shelf", { bookId: 99, shelf: "read" }], ["set_shelf", { bookId: 99, shelf: null }], ["add_note", { bookId: 99, body: "x" }], ["log_reading", { bookId: 99, rating: 3 }]] as const) {
      const r = await s.call(n, a);
      expect(r.isError, n).toBe(true);
    }
    expect((await s.call("log_reading", { bookId: 1 })).isError).toBe(true);
    expect((await s.call("log_reading", { bookId: 1, rating: 9 })).isError).toBe(true);
  });

  it("search_library and show_shelf", async () => {
    await s.call("add_book", { title: "Dune", shelf: "reading" });
    await s.call("add_book", { title: "Emma" });
    let r = await s.call("search_library", { query: "austen" });
    expect(r.structuredContent).toMatchObject({ kind: "book-list", total: 1, query: "austen" });
    expect(text(r)).toContain("#2 Emma");
    r = await s.call("show_shelf", { shelf: "reading" });
    expect(r.structuredContent).toMatchObject({ kind: "book-list", shelf: "reading", total: 1 });
    r = await s.call("show_shelf", {});
    expect((r.structuredContent as any).items).toHaveLength(2);
    r = await s.call("search_library", { query: "zzz" });
    expect((r.structuredContent as any).total).toBe(0);
  });

  it("get_recommendation_context", async () => {
    await s.call("add_book", { title: "Dune" });
    await s.call("add_book", { title: "Emma" });
    await s.call("log_reading", { bookId: 1, finishedAt: "2026-01-01", rating: 5 });
    await s.call("log_reading", { bookId: 2, finishedAt: "2026-02-01", rating: 1 });
    const r = await s.call("get_recommendation_context", {});
    const c = (r.structuredContent as any).context;
    expect(c.loved.map((b: any) => b.title)).toEqual(["Dune"]);
    expect(c.disliked.map((b: any) => b.title)).toEqual(["Emma"]);
    expect(text(r)).toMatch(/Loved[\s\S]*#1 Dune[\s\S]*Disliked[\s\S]*#2 Emma/);
  });

  it("import_goodreads_csv", async () => {
    const csv = [
      "Book Id,Title,Author,Additional Authors,ISBN,ISBN13,My Rating,Publisher,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Exclusive Shelf,My Review,Private Notes,Read Count",
      '1,Dune,Frank Herbert,,"=""0441172717""","=""9780441172719""",5,Ace,412,1990,1965,2025/03/01,2025/01/01,,read,Loved it,,1',
    ].join("\n");
    const dry = await s.call("import_goodreads_csv", { csv, dryRun: true });
    expect((dry.structuredContent as any).report.total).toBe(1);
    expect((await s.call("show_shelf", {})).structuredContent).toMatchObject({ total: 0 });
    const r = await s.call("import_goodreads_csv", { csv });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as any).report.created).toBe(1);
    expect((await s.call("show_shelf", { shelf: "read" })).structuredContent).toMatchObject({ total: 1 });
    const bad = await s.call("import_goodreads_csv", { csv: "a,b\n1,2" });
    expect(bad.isError).toBe(true);
  });
});

describe("ui resources", () => {
  it("are listed and readable with the MCP App mime type", async () => {
    const { client } = await setup();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([UI_RESOURCES.bookCard, UI_RESOURCES.bookList]);
    for (const uri of [UI_RESOURCES.bookList, UI_RESOURCES.bookCard]) {
      const res = await client.readResource({ uri });
      const c = res.contents[0] as { mimeType: string; text: string; _meta?: any };
      expect(c.mimeType).toBe(MCP_APP_MIME);
      expect(c._meta.ui.csp.resourceDomains).toContain("https://covers.openlibrary.org");
      expect(c.text.length).toBeLessThan(20_000);
    }
  });

  for (const [name, html] of [["list", listHtml], ["card", cardHtml]] as const) {
    it(`${name} html is self-contained and themed`, () => {
      expect(html).toContain("prefers-color-scheme");
      expect(html).toContain("data-theme");
      expect(html).not.toMatch(/http:\/\//);
      expect(html).not.toMatch(/<script[^>]+src=/i);
      expect(html).not.toMatch(/<link[^>]+href=/i);
      expect(html).not.toMatch(/\binnerHTML\b/);
    });
  }

  it("bridge smoke test: initializes, receives tool-result, renders via stub DOM", () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(listHtml)![1]!;
    const sent: any[] = [];
    const listeners: Record<string, (e: any) => void> = {};
    const mkEl = (tag: string): any => ({
      tag, children: [] as any[], style: { setProperty() {} }, classList: { toggle() {} }, _text: "",
      setAttribute(k: string, v: string) { this[k] = v; },
      appendChild(c: any) { this.children.push(c); return c; },
      remove() {}, set textContent(v: string) { this._text = v; if (v === "") this.children = []; }, get textContent() { return this._text; },
    });
    const flat = (e: any): string => (e._text ?? "") + (e.children ?? []).map((c: any) => (typeof c === "string" ? c : flat(c))).join(" ");
    const appEl = mkEl("div");
    const parent = { postMessage: (m: any) => sent.push(m) };
    const win: any = { parent, addEventListener: (t: string, f: any) => (listeners[t] = f) };
    const ctx: any = {
      window: win, setTimeout, clearTimeout, Promise, Error,
      ResizeObserver: undefined,
      document: {
        documentElement: mkEl("html"), body: mkEl("body"),
        getElementById: () => appEl, createElement: mkEl, createTextNode: (t: string) => t,
      },
    };
    vm.createContext(ctx);
    vm.runInContext(script, ctx);
    expect(sent[0]).toMatchObject({ method: "ui/initialize", params: { protocolVersion: "2026-01-26" } });
    listeners.message!({ source: parent, data: { jsonrpc: "2.0", id: sent[0].id, result: { hostContext: { theme: "dark" } } } });
    listeners.message!({
      source: parent,
      data: {
        jsonrpc: "2.0", method: "ui/notifications/tool-result",
        params: { structuredContent: { kind: "book-list", title: "Shelf: read", shelf: "read", query: null, total: 1, items: [{ id: 1, title: "Dune", authors: ["Frank Herbert"], firstPublishYear: 1965, coverUrl: null, isbn13: null, shelf: "read", rating: 5, lastFinishedAt: null, noteCount: 0 }] } },
      },
    });
    expect(flat(appEl)).toContain("Dune");
    expect(flat(appEl)).toContain("Shelf: read (1)");
    // teardown request is answered
    listeners.message!({ source: parent, data: { jsonrpc: "2.0", id: 77, method: "ui/resource-teardown", params: {} } });
    expect(sent.at(-1)).toMatchObject({ id: 77, result: {} });
  });
});
