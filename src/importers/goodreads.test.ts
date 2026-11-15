import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Repository } from "../db/repository.js";
import type { ImportReport } from "../types.js";
import { dryRunGoodreadsCsv, importGoodreadsCsv, parseDate, parseGoodreadsCsv } from "./goodreads.js";

const csv = (n: string) => readFileSync(new URL(`../../test/fixtures/goodreads/${n}`, import.meta.url), "utf8");

describe("parseGoodreadsCsv (English export)", () => {
  const p = parseGoodreadsCsv(csv("export.csv"));
  const byTitle = (t: string) => p.entries.filter((e) => e.book.title.startsWith(t));

  it("counts rows and reports per-row issues without failing", () => {
    expect(p.report.total).toBe(8);
    expect(p.entries).toHaveLength(7);
    expect(p.report.errors).toEqual([{ row: 9, message: "Missing title" }]);
    expect(p.rows).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("handles BOM, ISBN quoting, multi-line review, series title, authors", () => {
    const d = byTitle("Dune")[0]!;
    expect(d.book).toMatchObject({
      title: "Dune",
      goodreadsId: "100",
      isbn10: "0441172717",
      isbn13: "9780441172718",
      authors: ["Frank Herbert"],
      firstPublishYear: 1965,
      pageCount: 604,
      publisher: "Ace",
      source: "goodreads",
      olWorkKey: null,
      coverUrl: "https://covers.openlibrary.org/b/isbn/9780441172718-M.jpg",
      subjects: [],
    });
    expect(d.shelf).toBe("read");
    expect(d.addedAt).toBe("2023-01-02");
    expect(d.reads[0]).toEqual({ startedAt: null, finishedAt: "2023-03-14", rating: 5, review: 'Great, sweeping\nstory "wow"' });
    expect(d.notes).toEqual([{ kind: "note", body: "Goodreads shelves: sci-fi, favorites" }]);
  });

  it("Read Count > 1 adds extra undated unrated reads", () => {
    const d = byTitle("Dune")[0]!;
    expect(d.reads).toHaveLength(2);
    expect(d.reads[1]).toEqual({ startedAt: null, finishedAt: null, rating: null, review: null });
  });

  it("rating 0 -> null, empty ISBN -> null, additional authors, no cover without isbn13", () => {
    const e = byTitle("The Name")[0]!;
    expect(e.reads[0]!.rating).toBeNull();
    expect(e.book.isbn10).toBeNull();
    expect(e.book.isbn13).toBeNull();
    expect(e.book.coverUrl).toBeNull();
    expect(e.book.authors).toEqual(["Umberto Eco", "William Weaver"]);
  });

  it("to-read: no reads, private notes become notes; reading: no reads, review becomes note", () => {
    const t = byTitle("Piranesi")[0]!;
    expect(t.shelf).toBe("to-read");
    expect(t.reads).toEqual([]);
    expect(t.notes).toEqual([
      { kind: "note", body: "Recommended by Anna" },
      { kind: "note", body: "Goodreads shelves: fantasy" },
    ]);
    const r = byTitle("Project")[0]!;
    expect(r.shelf).toBe("reading");
    expect(r.reads).toEqual([]);
    expect(r.notes).toEqual([{ kind: "note", body: "Loving it so far" }]);
    expect(p.report.warnings.some((w) => w.title === "Project Hail Mary" && /Rating/.test(w.message))).toBe(true);
  });

  it("duplicate row is emitted twice (repository dedupes)", () => {
    expect(byTitle("Dune")).toHaveLength(2);
  });

  it("bad dates and invalid isbn -> warnings, nulls", () => {
    const b = byTitle("Bad Date")[0]!;
    expect(b.reads[0]!.finishedAt).toBeNull();
    expect(b.addedAt).toBeNull();
    expect(b.reads[0]!.rating).toBe(3);
    const msgs = p.report.warnings.filter((w) => w.title === "Bad Date Book").map((w) => w.message).join("|");
    expect(msgs).toMatch(/Date Read/);
    expect(msgs).toMatch(/Date Added/);
    expect(msgs).toMatch(/Invalid ISBN/);
  });

  it("unknown shelf -> null shelf + warning", () => {
    const w = byTitle("Weird")[0]!;
    expect(w.shelf).toBeNull();
    expect(p.report.warnings.some((x) => /Unknown shelf "on-hold"/.test(x.message))).toBe(true);
  });
});

describe("other inputs", () => {
  it("rejects non-Goodreads and empty files", () => {
    for (const text of [csv("not-goodreads.csv"), ""]) {
      const r = parseGoodreadsCsv(text);
      expect(r.entries).toEqual([]);
      expect(r.report.errors).toEqual([{ row: 1, message: "Not a Goodreads export" }]);
    }
  });

  it("parses Italian headers/shelves and dd/mm/yyyy dates", () => {
    const p = parseGoodreadsCsv(csv("italian.csv"));
    expect(p.report.errors).toEqual([]);
    const [a, b] = p.entries;
    expect(a!.shelf).toBe("read");
    expect(a!.reads[0]).toEqual({ startedAt: null, finishedAt: "2022-12-25", rating: 4, review: "Bellissimo" });
    expect(a!.book.isbn13).toBe("9788845229497");
    expect(a!.addedAt).toBe("2022-11-13");
    expect(b!.shelf).toBe("to-read");
    expect(b!.addedAt).toBe("2023-02-01");
  });

  it("survives a malformed CSV record", () => {
    const text = 'Title,Author,Exclusive Shelf\nGood,A,read\n"Unclosed,B,read\n';
    const r = parseGoodreadsCsv(text);
    expect(r.entries.length + r.report.errors.length).toBeGreaterThan(0);
  });

  it("parseDate variants", () => {
    expect(parseDate("2023/3/4")).toBe("2023-03-04");
    expect(parseDate("2023-03-04")).toBe("2023-03-04");
    expect(parseDate("03/04/2023")).toBe("2023-03-04");
    expect(parseDate("03/04/2023", true)).toBe("2023-04-03");
    expect(parseDate("25/12/2023")).toBe("2023-12-25");
    expect(parseDate("")).toBeNull();
    expect(() => parseDate("2023/02/30")).toThrow();
    expect(() => parseDate("hello")).toThrow();
  });
});

describe("importGoodreadsCsv", () => {
  it("passes entries to the repo and merges reports with CSV row numbers", async () => {
    const importEntries = vi.fn(async (): Promise<ImportReport> => ({
      total: 7, created: 5, merged: 1, skipped: 1,
      errors: [{ row: 3, title: "x", message: "boom" }],
      warnings: [],
    }));
    const repo = { importEntries } as unknown as Repository;
    const r = await importGoodreadsCsv(csv("export.csv"), repo);
    expect(importEntries).toHaveBeenCalledTimes(1);
    expect((importEntries.mock.calls[0] as unknown as [unknown[]])[0]).toHaveLength(7);
    expect(r.total).toBe(8);
    expect(r.created).toBe(5);
    expect(r.skipped).toBe(2);
    expect(r.errors.map((e) => e.row)).toEqual([4, 9]); // repo row 3 -> CSV row 4
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("does not call the repo when the file is not a Goodreads export", async () => {
    const importEntries = vi.fn();
    const r = await importGoodreadsCsv(csv("not-goodreads.csv"), { importEntries } as unknown as Repository);
    expect(importEntries).not.toHaveBeenCalled();
    expect(r.errors[0]!.message).toBe("Not a Goodreads export");
    expect(r.created).toBe(0);
  });

  it("dry run reports without persistence", () => {
    const r = dryRunGoodreadsCsv(csv("export.csv"));
    expect(r.total).toBe(8);
    expect(r.created).toBe(0);
    expect(r.errors).toHaveLength(1);
  });
});
