import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MetadataUnavailableError } from "./client.js";
import { createOpenLibraryClient } from "./openLibraryClient.js";
import { createFakeMetadataClient } from "./fakeClient.js";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`../../test/fixtures/openlibrary/${n}`, import.meta.url), "utf8"));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Route = (url: URL) => Response | Promise<Response> | undefined;
function mockFetch(...routes: Route[]) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    for (const r of routes) {
      const res = await r(url);
      if (res) return res;
    }
    return json({}, 404);
  });
}
const make = (f: ReturnType<typeof mockFetch>) =>
  createOpenLibraryClient({
    baseUrl: "https://ol.test",
    coversUrl: "https://covers.test",
    userAgent: "BestReads/test",
    timeoutMs: 500,
    retryDelayMs: 0,
    fetch: f as unknown as typeof fetch,
  });

describe("search", () => {
  it("maps docs, sends UA, builds covers, caps subjects, skips bad docs", async () => {
    const f = mockFetch((u) => (u.pathname === "/search.json" ? json(fx("search-dune.json")) : undefined));
    const res = await make(f).search({ query: "dune" }, 5);
    expect(res).toHaveLength(2);
    const c = res[0]!;
    expect(c).toMatchObject({
      olWorkKey: "/works/OL893415W",
      olEditionKey: "/books/OL7353617M",
      title: "Dune",
      authors: ["Frank Herbert"],
      firstPublishYear: 1965,
      isbn13: "9780441172719",
      isbn10: "0441172717",
      publisher: "Ace",
      pageCount: 612,
      language: "eng",
      description: null,
      subtitle: null,
      coverUrl: "https://covers.test/b/id/12345-M.jpg",
    });
    expect(c.subjects).toHaveLength(10);
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toContain("q=dune");
    expect(String(url)).toContain("limit=5");
    expect((init!.headers as Record<string, string>)["User-Agent"]).toBe("BestReads/test");
  });

  it("uses title/author params and clamps limit to 20", async () => {
    const f = mockFetch(() => json(fx("search-empty.json")));
    expect(await make(f).search({ title: "Dune", author: "Herbert" }, 99)).toEqual([]);
    const u = new URL(String(f.mock.calls[0]![0]));
    expect(u.searchParams.get("title")).toBe("Dune");
    expect(u.searchParams.get("author")).toBe("Herbert");
    expect(u.searchParams.get("limit")).toBe("20");
  });

  it("empty query returns [] without fetching; invalid isbn too", async () => {
    const f = mockFetch();
    expect(await make(f).search({})).toEqual([]);
    expect(await make(f).search({ isbn: "xx" })).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("isbn search normalises and prefers requested isbn", async () => {
    const f = mockFetch(() => json(fx("search-dune.json")));
    const [c] = await make(f).search({ isbn: "978-0-441-17271-8" });
    expect(new URL(String(f.mock.calls[0]![0])).searchParams.get("isbn")).toBe("9780441172718");
    expect(c!.isbn13).toBe("9780441172718");
  });

  it("cover falls back to isbn, then null", async () => {
    const f = mockFetch(() =>
      json({ docs: [{ key: "/works/OL2W", title: "A", isbn: ["9780441172718"] }, { key: "/works/OL3W", title: "B" }] }),
    );
    const r = await make(f).search({ query: "x" });
    expect(r[0]!.coverUrl).toBe("https://covers.test/b/isbn/9780441172718-M.jpg");
    expect(r[1]!.coverUrl).toBeNull();
    expect(r[1]!.authors).toEqual([]);
  });
});

describe("errors", () => {
  it("retries once on 500 then succeeds", async () => {
    let n = 0;
    const f = mockFetch(() => (n++ === 0 ? json({}, 500) : json(fx("search-dune.json"))));
    expect(await make(f).search({ query: "dune" })).toHaveLength(2);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("500 twice -> MetadataUnavailableError", async () => {
    const f = mockFetch(() => json({}, 503));
    await expect(make(f).search({ query: "dune" })).rejects.toBeInstanceOf(MetadataUnavailableError);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("429 is retried", async () => {
    const f = mockFetch(() => json({}, 429));
    await expect(make(f).search({ query: "a" })).rejects.toThrow(/unavailable/);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("network failure -> MetadataUnavailableError", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(make(f as never).search({ query: "a" })).rejects.toBeInstanceOf(MetadataUnavailableError);
  });
  it("timeout -> MetadataUnavailableError mentioning timed out", async () => {
    const f = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason));
    }));
    const c = createOpenLibraryClient({ baseUrl: "https://ol.test", coversUrl: "https://c.test", userAgent: "x", timeoutMs: 20, retryDelayMs: 0, fetch: f as never });
    await expect(c.search({ query: "a" })).rejects.toThrow(/timed out/);
  });
  it("4xx other than 404 and invalid json -> error", async () => {
    await expect(make(mockFetch(() => json({}, 400))).search({ query: "a" })).rejects.toBeInstanceOf(MetadataUnavailableError);
    const bad = mockFetch(() => new Response("<html>", { status: 200 }));
    await expect(make(bad).search({ query: "a" })).rejects.toBeInstanceOf(MetadataUnavailableError);
  });
});

describe("lookups", () => {
  const routes: Route[] = [
    (u) => (u.pathname === "/works/OL893415W.json" ? json(fx("work-dune.json")) : undefined),
    (u) => (u.pathname === "/search.json" ? json(fx("search-work-dune.json")) : undefined),
    (u) => (u.pathname === "/isbn/9780441172718.json" ? json(fx("edition-dune.json")) : undefined),
    (u) => (u.pathname === "/authors/OL79034A.json" ? json(fx("author.json")) : undefined),
  ];

  it("lookupByWorkKey merges work description with search data (bare key ok)", async () => {
    const c = await make(mockFetch(...routes)).lookupByWorkKey("OL893415W");
    expect(c).toMatchObject({
      olWorkKey: "/works/OL893415W",
      title: "Dune",
      authors: ["Frank Herbert"],
      description: "Set on the desert planet Arrakis.",
      firstPublishYear: 1965,
      coverUrl: "https://covers.test/b/id/12345-M.jpg",
    });
    expect(c!.subjects).toContain("Science fiction");
  });

  it("lookupByWorkKey falls back to author fetch when search finds nothing", async () => {
    const f = mockFetch(
      (u) => (u.pathname === "/search.json" ? json(fx("search-empty.json")) : undefined),
      ...routes.filter((_, i) => i !== 1),
    );
    const c = await make(f).lookupByWorkKey("/works/OL893415W");
    expect(c!.authors).toEqual(["Frank Herbert"]);
    expect(c!.coverUrl).toBe("https://covers.test/b/id/12345-M.jpg");
  });

  it("lookupByWorkKey 404 -> null", async () => {
    expect(await make(mockFetch()).lookupByWorkKey("/works/OL1W")).toBeNull();
  });

  it("lookupByIsbn: edition data wins, work supplies authors/description", async () => {
    const c = await make(mockFetch(...routes)).lookupByIsbn("978-0-441-17271-8");
    expect(c).toMatchObject({
      olWorkKey: "/works/OL893415W",
      olEditionKey: "/books/OL7353617M",
      isbn13: "9780441172718",
      isbn10: "0441172717",
      publisher: "Ace Books",
      pageCount: 604,
      language: "eng",
      authors: ["Frank Herbert"],
      description: "Set on the desert planet Arrakis.",
    });
  });

  it("lookupByIsbn unknown -> null; invalid -> null without fetch", async () => {
    const f = mockFetch((u) => (u.pathname === "/search.json" ? json(fx("search-empty.json")) : undefined));
    expect(await make(f).lookupByIsbn("9780000000002")).toBeNull();
    const g = mockFetch();
    expect(await make(g).lookupByIsbn("nope")).toBeNull();
    expect(g).not.toHaveBeenCalled();
  });

  it("lookupByIsbn falls back to search when /isbn 404s", async () => {
    const f = mockFetch((u) => (u.pathname === "/search.json" ? json(fx("search-dune.json")) : undefined));
    const c = await make(f).lookupByIsbn("9780441172719");
    expect(c!.title).toBe("Dune");
  });
});

describe("fake client", () => {
  const base = {
    olEditionKey: null, subtitle: null, firstPublishYear: 1965, isbn10: null, publisher: null, pageCount: null,
    language: null, subjects: [], description: null, coverUrl: null,
  };
  const fake = createFakeMetadataClient([
    { ...base, olWorkKey: "/works/OL1W", title: "Dune", authors: ["Frank Herbert"], isbn13: "9780441172718" },
    { ...base, olWorkKey: "/works/OL2W", title: "Emma", authors: ["Jane Austen"], isbn13: null },
  ]);
  it("searches and looks up", async () => {
    expect((await fake.search({ query: "herbert dune" })).map((c) => c.title)).toEqual(["Dune"]);
    expect((await fake.search({ title: "emma" }, 1))).toHaveLength(1);
    expect((await fake.lookupByIsbn("978-0-441-17271-8"))?.title).toBe("Dune");
    expect((await fake.lookupByWorkKey("OL2W"))?.title).toBe("Emma");
    expect(await fake.lookupByWorkKey("OL9W")).toBeNull();
  });
});
