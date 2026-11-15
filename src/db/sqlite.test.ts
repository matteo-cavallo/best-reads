import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./connection.js";
import { migrate } from "./migrate.js";
import { createSqliteRepository } from "./sqlite.js";
import { NotFoundError, ValidationError, type Repository } from "./repository.js";
import { matchKey, normalizeIsbn } from "./normalize.js";
import type { ImportEntry, NewBook } from "../types.js";

function nb(over: Partial<NewBook> = {}): NewBook {
  return {
    olWorkKey: null, olEditionKey: null, goodreadsId: null, isbn10: null, isbn13: null,
    title: "Dune", subtitle: null, authors: ["Frank Herbert"], firstPublishYear: 1965, publisher: null,
    pageCount: null, language: null, subjects: [], description: null, coverUrl: null, source: "manual",
    ...over,
  };
}

let db: DatabaseSync;
let repo: Repository;
let clock: number;

beforeEach(() => {
  db = openDatabase(":memory:");
  clock = Date.parse("2026-01-01T00:00:00Z");
  repo = createSqliteRepository(db, { now: () => new Date((clock += 1000)) });
});

const add = async (over: Partial<NewBook> = {}) => (await repo.upsertBook(nb(over))).book;

describe("migrations & normalize", () => {
  it("is idempotent and sets user_version", () => {
    expect(migrate(db)).toBe(1);
    expect(migrate(db)).toBe(1);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(["books", "shelves", "reads", "notes", "oauth_tokens"]));
  });
  it("normalizes keys and isbns", () => {
    expect(matchKey("Les Misérables!", ["Victor Hugo"])).toBe("lesmiserables|victorhugo");
    expect(normalizeIsbn('="0143-105426"')).toBe("0143105426");
    expect(normalizeIsbn("123")).toBeNull();
  });
});

describe("upsertBook dedupe/merge", () => {
  it("creates then merges by olWorkKey, filling gaps only", async () => {
    const a = await repo.upsertBook(nb({ olWorkKey: "/works/OL1W", subjects: ["Sci-fi"] }));
    expect(a.created).toBe(true);
    const b = await repo.upsertBook(nb({ title: "Other title", olWorkKey: "/works/OL1W", publisher: "Ace", subjects: ["Desert", "Sci-fi"], firstPublishYear: 2000 }));
    expect(b.created).toBe(false);
    expect(b.book.id).toBe(a.book.id);
    expect(b.book.title).toBe("Dune");
    expect(b.book.publisher).toBe("Ace");
    expect(b.book.firstPublishYear).toBe(1965);
    expect(b.book.subjects).toEqual(["Sci-fi", "Desert"]);
  });
  it("matches by isbn13, goodreadsId, then normalized title+author", async () => {
    const a = await add({ isbn13: "9780441172719" });
    expect((await repo.upsertBook(nb({ title: "x", authors: ["y"], isbn13: "978-0-441-17271-9" }))).book.id).toBe(a.id);
    const g = await add({ title: "Emma", authors: ["Jane Austen"], goodreadsId: "42" });
    expect((await repo.upsertBook(nb({ title: "zzz", authors: ["q"], goodreadsId: "42" }))).book.id).toBe(g.id);
    const d = await repo.upsertBook(nb({ title: "DUNE!", authors: ["frank  herbert"] }));
    expect(d.created).toBe(false);
    expect(d.book.id).toBe(a.id);
    expect((await repo.upsertBook(nb({ title: "Dune Messiah" }))).created).toBe(true);
  });
  it("does not violate unique keys when merging", async () => {
    await add({ title: "A", authors: ["x"], goodreadsId: "7" });
    const b = await add({ title: "B", authors: ["y"], olWorkKey: "/works/OL2W" });
    const m = await repo.upsertBook(nb({ title: "B", authors: ["y"], olWorkKey: "/works/OL2W", goodreadsId: "7" }));
    expect(m.book.id).toBe(b.id);
    expect(m.book.goodreadsId).toBeNull();
  });
  it("rejects empty title and finds by external ids", async () => {
    await expect(repo.upsertBook(nb({ title: "  " }))).rejects.toBeInstanceOf(ValidationError);
    const a = await add({ olWorkKey: "/works/OL9W", isbn13: "9780441172719", goodreadsId: "5" });
    expect((await repo.findBookByExternalIds({ olWorkKey: "/works/OL9W" }))?.id).toBe(a.id);
    expect((await repo.findBookByExternalIds({ isbn13: "9780441172719" }))?.id).toBe(a.id);
    expect((await repo.findBookByExternalIds({ goodreadsId: "5" }))?.id).toBe(a.id);
    expect(await repo.findBookByExternalIds({})).toBeNull();
    expect(await repo.getBook(999)).toBeNull();
  });
});

describe("shelves", () => {
  it("sets, replaces (keeps addedAt), clears", async () => {
    const b = await add();
    const s1 = await repo.setShelf(b.id, "to-read");
    const s2 = await repo.setShelf(b.id, "reading");
    expect(s2.shelf).toBe("reading");
    expect(s2.addedAt).toBe(s1.addedAt);
    expect(s2.updatedAt > s1.updatedAt).toBe(true);
    await repo.clearShelf(b.id);
    expect(await repo.getShelf(b.id)).toBeNull();
    expect(await repo.getBook(b.id)).not.toBeNull();
    await expect(repo.setShelf(999, "read")).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.clearShelf(999)).rejects.toBeInstanceOf(NotFoundError);
  });
  it("cascades on book delete", async () => {
    const b = await add();
    await repo.setShelf(b.id, "read");
    await repo.addNote({ bookId: b.id, kind: "note", body: "x" });
    await repo.logReading({ bookId: b.id, rating: 3 });
    db.prepare("DELETE FROM books WHERE id = ?").run(b.id);
    for (const t of ["shelves", "notes", "reads"]) {
      expect((db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c).toBe(0);
    }
  });
});

describe("logReading", () => {
  it("start -> reading, finish -> read on the same read", async () => {
    const b = await add();
    const s = await repo.logReading({ bookId: b.id, startedAt: "2026-02-01" });
    expect(s).toMatchObject({ shelf: "reading", createdRead: true });
    const f = await repo.logReading({ bookId: b.id, finishedAt: "2026-02-10", rating: 5, review: "great" });
    expect(f).toMatchObject({ shelf: "read", createdRead: false });
    expect(f.read).toMatchObject({ id: s.read.id, startedAt: "2026-02-01", finishedAt: "2026-02-10", rating: 5, review: "great" });
    expect((await repo.getShelf(b.id))?.shelf).toBe("read");
  });
  it("start+finish together -> read; rate only creates dateless read", async () => {
    const b = await add();
    expect((await repo.logReading({ bookId: b.id, startedAt: "2026-02-01", finishedAt: "2026-02-02" })).shelf).toBe("read");
    const c = await add({ title: "Emma", authors: ["Austen"] });
    const r = await repo.logReading({ bookId: c.id, rating: 4 });
    expect(r).toMatchObject({ shelf: "read", createdRead: true });
    expect(r.read.finishedAt).toBeNull();
  });
  it("rate-only applies to the most recent read", async () => {
    const b = await add();
    await repo.logReading({ bookId: b.id, startedAt: "2020-01-01", finishedAt: "2020-01-05" });
    const second = await repo.logReading({ bookId: b.id, startedAt: "2023-01-01", finishedAt: "2023-01-05", newRead: true });
    const r = await repo.logReading({ bookId: b.id, rating: 2 });
    expect(r.createdRead).toBe(false);
    expect(r.read.id).toBe(second.read.id);
    expect(r.read.rating).toBe(2);
  });
  it("re-read via newRead; latest rating wins by finishedAt", async () => {
    const b = await add();
    await repo.logReading({ bookId: b.id, finishedAt: "2024-05-01", rating: 2 });
    const re = await repo.logReading({ bookId: b.id, startedAt: "2025-01-01", newRead: true });
    expect(re.createdRead).toBe(true);
    expect(re.shelf).toBe("reading");
    await repo.logReading({ bookId: b.id, finishedAt: "2025-02-01", rating: 5 });
    const page = await repo.searchLibrary({});
    expect(page.items[0]).toMatchObject({ rating: 5, lastFinishedAt: "2025-02-01", shelf: "read" });
    const d = await repo.getBookDetail(b.id);
    expect(d?.reads.map((r) => r.finishedAt)).toEqual(["2025-02-01", "2024-05-01"]);
  });
  it("can clear rating with null; validates input", async () => {
    const b = await add();
    await repo.logReading({ bookId: b.id, rating: 3 });
    const r = await repo.logReading({ bookId: b.id, rating: null });
    expect(r.read.rating).toBeNull();
    await expect(repo.logReading({ bookId: b.id, rating: 6 })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.logReading({ bookId: b.id, rating: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.logReading({ bookId: b.id, rating: 2.5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.logReading({ bookId: b.id, finishedAt: "2026-13-40" })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.logReading({ bookId: b.id, startedAt: "2026-03-02", finishedAt: "2026-03-01", newRead: true })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.logReading({ bookId: 999, rating: 3 })).rejects.toBeInstanceOf(NotFoundError);
  });
  it("is atomic: failed validation leaves no read behind and shelf untouched", async () => {
    const b = await add();
    await repo.setShelf(b.id, "to-read");
    await repo.logReading({ bookId: b.id, startedAt: "2026-03-05", finishedAt: "2026-03-01" }).catch(() => {});
    expect((await repo.getBookDetail(b.id))?.reads).toHaveLength(0);
    expect((await repo.getShelf(b.id))?.shelf).toBe("to-read");
  });
  it("finishedAt before existing open read's startedAt is rejected", async () => {
    const b = await add();
    await repo.logReading({ bookId: b.id, startedAt: "2026-03-05" });
    await expect(repo.logReading({ bookId: b.id, finishedAt: "2026-03-01" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("notes", () => {
  it("adds note and highlight; validates", async () => {
    const b = await add();
    const n = await repo.addNote({ bookId: b.id, kind: "highlight", body: "Fear is the mind-killer", chapter: "1", page: 12 });
    expect(n).toMatchObject({ kind: "highlight", chapter: "1", page: 12 });
    await repo.addNote({ bookId: b.id, kind: "note", body: "second" });
    const d = await repo.getBookDetail(b.id);
    expect(d?.notes.map((x) => x.body)).toEqual(["second", "Fear is the mind-killer"]);
    await expect(repo.addNote({ bookId: b.id, kind: "note", body: "  " })).rejects.toBeInstanceOf(ValidationError);
    await expect(repo.addNote({ bookId: 999, kind: "note", body: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("searchLibrary", () => {
  beforeEach(async () => {
    const dune = await add({ subjects: ["Science fiction", "Desert"] });
    const emma = await add({ title: "Emma", authors: ["Jane Austen"], subjects: ["Romance"] });
    const hobbit = await add({ title: "The Hobbit", authors: ["J.R.R. Tolkien"], subjects: ["Fantasy"] });
    await add({ title: "100% Pure_Joy", authors: ["Anon"] });
    await repo.setShelf(dune.id, "read");
    await repo.logReading({ bookId: dune.id, finishedAt: "2025-03-01", rating: 5 });
    await repo.setShelf(emma.id, "read");
    await repo.logReading({ bookId: emma.id, finishedAt: "2025-06-01", rating: 2 });
    await repo.setShelf(hobbit.id, "to-read");
    await repo.addNote({ bookId: hobbit.id, kind: "note", body: "recommended by a friend about dragons" });
  });
  it("matches tokens across title/author/subject/notes, case-insensitively", async () => {
    expect((await repo.searchLibrary({ q: "herbert DUNE" })).items.map((i) => i.title)).toEqual(["Dune"]);
    expect((await repo.searchLibrary({ q: "desert" })).total).toBe(1);
    expect((await repo.searchLibrary({ q: "dragons" })).items[0]?.title).toBe("The Hobbit");
    expect((await repo.searchLibrary({ q: "dragons herbert" })).total).toBe(0);
    expect((await repo.searchLibrary({ q: "tolkien" })).items[0]?.noteCount).toBe(1);
  });
  it("escapes LIKE wildcards", async () => {
    expect((await repo.searchLibrary({ q: "100%" })).total).toBe(1);
    expect((await repo.searchLibrary({ q: "_" })).total).toBe(1);
    expect((await repo.searchLibrary({ q: "%" })).total).toBe(1);
  });
  it("filters by shelf, rating and finished range", async () => {
    expect((await repo.searchLibrary({ shelf: "read" })).total).toBe(2);
    expect((await repo.searchLibrary({ minRating: 4 })).items.map((i) => i.title)).toEqual(["Dune"]);
    expect((await repo.searchLibrary({ maxRating: 2 })).items.map((i) => i.title)).toEqual(["Emma"]);
    expect((await repo.searchLibrary({ finishedFrom: "2025-05-01", finishedTo: "2025-12-31" })).items.map((i) => i.title)).toEqual(["Emma"]);
  });
  it("sorts and pages with stable ties", async () => {
    expect((await repo.searchLibrary({ sort: "title" })).items.map((i) => i.title)).toEqual(["100% Pure_Joy", "Dune", "Emma", "The Hobbit"]);
    expect((await repo.searchLibrary({ sort: "rating_desc" })).items.slice(0, 2).map((i) => i.title)).toEqual(["Dune", "Emma"]);
    expect((await repo.searchLibrary({ sort: "finished_desc" })).items.slice(0, 2).map((i) => i.title)).toEqual(["Emma", "Dune"]);
    expect((await repo.searchLibrary({ sort: "added_asc" })).items.map((i) => i.title)[0]).toBe("100% Pure_Joy");
    expect((await repo.searchLibrary({ sort: "added_desc" })).items.map((i) => i.title)[0]).toBe("The Hobbit");
    const p = await repo.searchLibrary({ sort: "title", limit: 2, offset: 1 });
    expect(p.total).toBe(4);
    expect(p.items.map((i) => i.title)).toEqual(["Dune", "Emma"]);
    expect((await repo.searchLibrary({ limit: 1000 })).items).toHaveLength(4);
  });
});

describe("getRecommendationContext", () => {
  it("buckets loved/disliked/neutral and aggregates", async () => {
    const mk = async (title: string, author: string, subjects: string[], rating: number | null, finished: string | null, shelf: "read" | "to-read" | "reading") => {
      const b = await add({ title, authors: [author], subjects });
      await repo.setShelf(b.id, shelf);
      if (finished || rating) await repo.logReading({ bookId: b.id, finishedAt: finished ?? undefined, rating: rating ?? undefined });
      return b;
    };
    const a = await mk("A", "Ann", ["scifi", "space"], 5, "2025-01-01", "read");
    await mk("B", "Ann", ["scifi"], 4, "2025-03-01", "read");
    await mk("C", "Bob", ["romance"], 3, "2025-02-01", "read");
    await mk("D", "Cy", ["scifi"], 1, "2025-04-01", "read");
    await mk("E", "Dee", ["x"], 2, "2024-01-01", "read");
    await mk("F", "Eve", ["y"], null, null, "to-read");
    await mk("G", "Fay", ["z"], null, null, "reading");
    await repo.addNote({ bookId: a.id, kind: "highlight", body: "x".repeat(500) });
    const dislikedBook = (await repo.searchLibrary({ q: "Cy" })).items[0]!;
    await repo.addNote({ bookId: dislikedBook.id, kind: "note", body: "meh" });

    const c = await repo.getRecommendationContext();
    expect(c.counts).toEqual({ "to-read": 1, reading: 1, read: 5, total: 7, rated: 5 });
    expect(c.averageRating).toBe(3);
    expect(c.loved.map((b) => b.title)).toEqual(["A", "B"]);
    expect(c.disliked.map((b) => b.title)).toEqual(["E", "D"]);
    expect([...c.loved, ...c.disliked].some((b) => b.title === "C")).toBe(false);
    expect(c.recentReads.map((b) => b.title)).toEqual(["D", "B", "C", "A", "E"]);
    expect(c.currentlyReading.map((b) => b.title)).toEqual(["G"]);
    expect(c.toRead.map((b) => b.title)).toEqual(["F"]);
    expect(c.topAuthors[0]).toEqual({ author: "Ann", books: 2, avgRating: 4.5 });
    expect(c.topSubjects[0]).toEqual({ subject: "scifi", books: 3, avgRating: 3.33 });
    expect(c.recentNotes).toHaveLength(1);
    expect(c.recentNotes[0]!.body.length).toBe(300);
    expect(c.recentNotes[0]!.title).toBe("A");
    expect((await repo.getRecommendationContext({ limit: 1, recentCount: 2 })).recentReads).toHaveLength(2);
    expect((await repo.getRecommendationContext({ limit: 1 })).loved).toHaveLength(1);
  });
  it("handles an empty library", async () => {
    const c = await repo.getRecommendationContext();
    expect(c.averageRating).toBeNull();
    expect(c.counts.total).toBe(0);
    expect(c.topAuthors).toEqual([]);
  });
});

describe("importEntries", () => {
  const entry = (over: Partial<ImportEntry> = {}, book: Partial<NewBook> = {}): ImportEntry => ({
    book: nb({ goodreadsId: "g1", source: "goodreads", ...book }),
    shelf: "read",
    reads: [{ startedAt: null, finishedAt: "2024-01-02", rating: 4, review: "nice" }],
    notes: [{ kind: "note", body: "private" }],
    addedAt: "2023-12-25",
    ...over,
  });
  it("imports and is idempotent", async () => {
    const entries = [
      entry(),
      entry({ shelf: "to-read", reads: [], notes: [], addedAt: "2022-01-01" }, { goodreadsId: "g2", title: "Emma", authors: ["Austen"] }),
      entry({ reads: [{ startedAt: null, finishedAt: null, rating: null, review: null }, { startedAt: null, finishedAt: null, rating: null, review: null }], notes: [] }, { goodreadsId: "g3", title: "Ulysses", authors: ["Joyce"] }),
    ];
    const r1 = await repo.importEntries(entries);
    expect(r1).toMatchObject({ total: 3, created: 3, merged: 0, skipped: 0, errors: [] });
    const shelf = await repo.getShelf((await repo.searchLibrary({ q: "emma" })).items[0]!.id);
    expect(shelf?.addedAt).toBe("2022-01-01T00:00:00.000Z");
    const r2 = await repo.importEntries(entries);
    expect(r2).toMatchObject({ created: 0, merged: 3, skipped: 3, errors: [] });
    const u = (await repo.searchLibrary({ q: "ulysses" })).items[0]!;
    expect((await repo.getBookDetail(u.id))?.reads).toHaveLength(2);
    const d = (await repo.getBookDetail((await repo.searchLibrary({ q: "dune" })).items[0]!.id))!;
    expect(d.reads).toHaveLength(1);
    expect(d.notes).toHaveLength(1);
    expect(d.reads[0]).toMatchObject({ rating: 4, review: "nice", finishedAt: "2024-01-02" });
  });
  it("does not override the shelf of an existing book", async () => {
    const b = await add({ goodreadsId: "g1" });
    await repo.setShelf(b.id, "reading");
    const r = await repo.importEntries([entry()]);
    expect(r.merged).toBe(1);
    expect((await repo.getShelf(b.id))?.shelf).toBe("reading");
  });
  it("isolates bad rows with savepoints", async () => {
    const entries = [
      entry({}, { goodreadsId: "ok1", title: "Good One", authors: ["A"] }),
      entry({ reads: [{ startedAt: null, finishedAt: "2024-01-02", rating: 9, review: null }] }, { goodreadsId: "bad", title: "Bad Rating", authors: ["B"] }),
      entry({ reads: [{ startedAt: "2024-02-02", finishedAt: "2024-01-02", rating: null, review: null }] }, { goodreadsId: "bad2", title: "Bad Dates", authors: ["C"] }),
      entry({}, { goodreadsId: "ok2", title: "Good Two", authors: ["D"] }),
    ];
    const r = await repo.importEntries(entries);
    expect(r.created).toBe(2);
    expect(r.errors.map((e) => [e.row, e.title])).toEqual([[2, "Bad Rating"], [3, "Bad Dates"]]);
    expect((await repo.searchLibrary({})).total).toBe(2);
    expect((await repo.searchLibrary({ q: "Bad" })).total).toBe(0);
  });
});

describe("review fixes", () => {
  const csvText = [
    "Book Id,Title,Author,ISBN,ISBN13,My Rating,Exclusive Shelf,Date Read,Bookshelves",
    '1,"Dune (Dune, #1)",Frank Herbert,"=""0441172717""","=""9780441172718""",5,read,2020/05/01,"favorites, sci-fi"',
  ].join("\n");

  it("Goodreads import then add_book yields one book; shelves are not subjects", async () => {
    const { importGoodreadsCsv } = await import("../importers/goodreads.js");
    await importGoodreadsCsv(csvText, repo);
    const r = await repo.upsertBook(nb({ title: "Dune", olWorkKey: "/works/OL1W" }));
    expect(r.created).toBe(false);
    const page = await repo.searchLibrary({});
    expect(page.total ?? page.items?.length).toBe(1);
    const ctx = await repo.getRecommendationContext({});
    expect(JSON.stringify(ctx.topSubjects)).not.toContain("favorites");
  });

  it("matches by isbn10 and strips Italian edition suffix", async () => {
    await add({ title: "Il nome della rosa", authors: ["Umberto Eco"], isbn10: "8845292614" });
    const r = await repo.upsertBook(nb({ title: "Il nome della rosa (Italian Edition)", authors: ["Umberto Eco"], isbn10: "8845292614" }));
    expect(r.created).toBe(false);
    expect(matchKey("Dune (Dune, #1)", ["F"])).toBe(matchKey("Dune", ["F"]));
  });

  it("re-import after editing a rating does not duplicate reads", async () => {
    const { importGoodreadsCsv } = await import("../importers/goodreads.js");
    await importGoodreadsCsv(csvText, repo);
    const b = (await repo.searchLibrary({})).items[0]!;
    const id = (b as { id?: number; bookId?: number }).id ?? (b as { bookId?: number }).bookId!;
    const d = await repo.getBookDetail(id);
    expect(d!.reads).toHaveLength(1);
    await importGoodreadsCsv(csvText.replace(",5,read", ",3,read"), repo);
    expect((await repo.getBookDetail(id))!.reads).toHaveLength(1);
  });

  it("search is accent- and case-insensitive", async () => {
    await add({ title: "Perché leggere i classici", authors: ["Italo Calvino"] });
    for (const q of ["perche", "PERCHÉ", "perché"]) expect((await repo.searchLibrary({ q })).items).toHaveLength(1);
  });
});
