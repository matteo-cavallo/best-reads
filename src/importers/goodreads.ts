/**
 * Goodreads library export (CSV) -> ImportEntry[]; plus importGoodreadsCsv(csvText, repo) used by the tools module.
 * Tolerant: malformed rows are reported in `errors`, odd values in `warnings`; nothing is fatal except a missing header.
 */
import { parse } from "csv-parse/sync";
import { stripTitleSuffix } from "../db/normalize.js";
import type { Repository } from "../db/repository.js";
import type { DateOnly, ImportEntry, ImportReport, ShelfName } from "../types.js";

export interface ParsedGoodreads {
  entries: ImportEntry[];
  /** rows[i] = CSV row number (header = 1, first data row = 2) of entries[i]. */
  rows: number[];
  report: Pick<ImportReport, "total" | "errors" | "warnings">;
}

type Row = Record<string, string>;
type Issue = { row: number; title?: string; message: string };

// canonical column -> accepted header names (lowercased, trimmed). English first, Italian variants after.
const ALIASES: Record<string, string[]> = {
  bookId: ["book id", "id libro", "id"],
  title: ["title", "titolo"],
  author: ["author", "autore"],
  additionalAuthors: ["additional authors", "autori aggiuntivi", "altri autori"],
  isbn: ["isbn"],
  isbn13: ["isbn13", "isbn 13"],
  rating: ["my rating", "il mio voto", "mio voto", "voto"],
  publisher: ["publisher", "editore", "casa editrice"],
  pages: ["number of pages", "numero di pagine", "pagine"],
  yearPublished: ["year published", "anno di pubblicazione", "anno pubblicazione"],
  originalYear: ["original publication year", "anno di pubblicazione originale", "anno pubblicazione originale"],
  dateRead: ["date read", "data lettura", "data di lettura", "letto il"],
  dateAdded: ["date added", "data aggiunta", "data di aggiunta"],
  exclusiveShelf: ["exclusive shelf", "scaffale esclusivo", "scaffale"],
  bookshelves: ["bookshelves", "scaffali"],
  review: ["my review", "la mia recensione", "mia recensione", "recensione"],
  privateNotes: ["private notes", "note private"],
  readCount: ["read count", "numero di letture", "conteggio letture"],
};

const SHELF_MAP: Record<string, ShelfName> = {
  "to-read": "to-read",
  "want-to-read": "to-read",
  "da-leggere": "to-read",
  "currently-reading": "reading",
  reading: "reading",
  "in-lettura": "reading",
  "sto-leggendo": "reading",
  read: "read",
  letto: "read",
  letti: "read",
};

export function cleanIsbnCell(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/[="'\s-]/g, "").toUpperCase();
  if (!s) return null;
  if (/^\d{13}$/.test(s) || /^\d{9}[\dX]$/.test(s)) return s;
  return null;
}

/** Returns ISO date, or null if blank. Throws on unparseable input. `dayFirst` resolves ambiguous d/m vs m/d. */
export function parseDate(raw: string | undefined, dayFirst = false): DateOnly | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?:[T\s].*)?$/.exec(s))) {
    y = +r[1]!;
    m = +r[2]!;
    d = +r[3]!;
  } else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) {
    const a = +r[1]!;
    const b = +r[2]!;
    y = +r[3]!;
    if (a > 12) [d, m] = [a, b];
    else if (b > 12) [m, d] = [a, b];
    else if (dayFirst) [d, m] = [a, b];
    else [m, d] = [a, b];
  } else {
    throw new Error(`Unrecognised date "${s}"`);
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || m > 12 || d < 1 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new Error(`Invalid date "${s}"`);
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const intOrNull = (s: string | undefined): number | null => {
  const t = (s ?? "").trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
};

export function parseGoodreadsCsv(csvText: string): ParsedGoodreads {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const entries: ImportEntry[] = [];
  const rowNumbers: number[] = [];
  const notGoodreads = (): ParsedGoodreads => ({
    entries: [],
    rows: [],
    report: { total: 0, errors: [{ row: 1, message: "Not a Goodreads export" }], warnings: [] },
  });

  const skipped: Issue[] = [];
  let records: string[][];
  try {
    records = parse(csvText, {
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      skip_records_with_error: true,
      on_skip: (err: unknown) => {
        const e = err as { lines?: number; message?: string } | undefined;
        skipped.push({ row: e?.lines ?? 0, message: `Malformed CSV record: ${e?.message ?? "parse error"}` });
      },
    }) as string[][];
  } catch (e) {
    return {
      entries: [],
      rows: [],
      report: { total: 0, errors: [{ row: 1, message: `Not a Goodreads export (CSV unreadable: ${(e as Error).message})` }], warnings: [] },
    };
  }
  const header = records[0];
  if (!header) return notGoodreads();

  const colIndex: Record<string, number> = {};
  const norm = header.map((h) => h.replace(/^﻿/, "").trim().toLowerCase());
  for (const [canon, names] of Object.entries(ALIASES)) {
    const i = norm.findIndex((h) => names.includes(h));
    if (i >= 0) colIndex[canon] = i;
  }
  if (colIndex.title === undefined || colIndex.exclusiveShelf === undefined) return notGoodreads();
  const italian = norm.some((h) => ["titolo", "autore", "scaffale esclusivo", "il mio voto"].includes(h));
  const get = (cells: string[], canon: string): string => {
    const i = colIndex[canon];
    return i === undefined ? "" : (cells[i] ?? "").trim();
  };

  const dataRows = records.slice(1);
  let total = dataRows.length + skipped.length;
  errors.push(...skipped);

  dataRows.forEach((cells, idx) => {
    const row = idx + 2;
    const title = get(cells, "title");
    const warn = (message: string) => warnings.push({ row, title: title || undefined, message });
    if (!title) {
      errors.push({ row, message: "Missing title" });
      return;
    }
    if (cells.length < 3) {
      errors.push({ row, title, message: "Row has too few columns" });
      return;
    }

    const authors: string[] = [];
    for (const a of [get(cells, "author"), ...get(cells, "additionalAuthors").split(",")]) {
      const t = a.trim();
      if (t && !authors.some((x) => x.toLowerCase() === t.toLowerCase())) authors.push(t);
    }

    const isbn10Raw = cleanIsbnCell(get(cells, "isbn"));
    const isbn13Raw = cleanIsbnCell(get(cells, "isbn13"));
    if (get(cells, "isbn").replace(/[="'\s-]/g, "") && !isbn10Raw) warn("Invalid ISBN ignored");
    if (get(cells, "isbn13").replace(/[="'\s-]/g, "") && !isbn13Raw) warn("Invalid ISBN13 ignored");
    // Some exports put a 13-digit value into the ISBN column, or vice versa.
    const all = [isbn10Raw, isbn13Raw].filter((x): x is string => !!x);
    const isbn13 = all.find((x) => x.length === 13) ?? null;
    const isbn10 = all.find((x) => x.length === 10) ?? null;

    const shelfRaw = get(cells, "exclusiveShelf").toLowerCase();
    let shelf: ShelfName | null = null;
    if (shelfRaw) {
      shelf = SHELF_MAP[shelfRaw] ?? null;
      if (!shelf) warn(`Unknown shelf "${shelfRaw}"; imported without a shelf`);
    }

    const ratingN = Number(get(cells, "rating") || "0");
    let rating: number | null = null;
    if (Number.isInteger(ratingN) && ratingN >= 1 && ratingN <= 5) rating = ratingN;
    else if (!(Number.isFinite(ratingN) && ratingN === 0)) warn(`Invalid rating "${get(cells, "rating")}" ignored`);

    const safeDate = (canon: string, label: string): DateOnly | null => {
      try {
        return parseDate(get(cells, canon), italian);
      } catch (e) {
        warn(`${label}: ${(e as Error).message}; ignored`);
        return null;
      }
    };
    const dateRead = safeDate("dateRead", "Date Read");
    const dateAdded = safeDate("dateAdded", "Date Added");

    const review = get(cells, "review") || null;
    const privateNotes = get(cells, "privateNotes");
    const notes: ImportEntry["notes"] = [];
    const reads: ImportEntry["reads"] = [];

    if (shelf === "read") {
      reads.push({ startedAt: null, finishedAt: dateRead, rating, review });
      const count = intOrNull(get(cells, "readCount")) ?? 1;
      for (let i = 1; i < Math.min(count, 20); i++) reads.push({ startedAt: null, finishedAt: null, rating: null, review: null });
    } else {
      if (rating !== null) warn("Rating on a book not on the read shelf was ignored");
      if (dateRead) warn("Date Read on a book not on the read shelf was ignored");
      if (review) notes.push({ kind: "note", body: review });
    }
    if (privateNotes) notes.push({ kind: "note", body: privateNotes });

    const exclusiveNames = new Set(Object.keys(SHELF_MAP));
    const userShelves = get(cells, "bookshelves")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !exclusiveNames.has(s.toLowerCase()));
    // User shelves are personal tags, not genres: keep them as a note, never as subjects.
    if (userShelves.length) notes.push({ kind: "note", body: `Goodreads shelves: ${userShelves.join(", ")}` });

    const pages = intOrNull(get(cells, "pages"));
    const year = intOrNull(get(cells, "originalYear")) ?? intOrNull(get(cells, "yearPublished"));
    entries.push({
      book: {
        olWorkKey: null,
        olEditionKey: null,
        goodreadsId: get(cells, "bookId") || null,
        isbn10,
        isbn13,
        title: stripTitleSuffix(title) || title,
        subtitle: null,
        authors,
        firstPublishYear: year,
        publisher: get(cells, "publisher") || null,
        pageCount: pages,
        language: null,
        subjects: [],
        description: null,
        coverUrl: isbn13 ? `https://covers.openlibrary.org/b/isbn/${isbn13}-M.jpg` : null,
        source: "goodreads",
      },
      shelf,
      reads,
      notes,
      addedAt: dateAdded,
    });
    rowNumbers.push(row);
  });

  errors.sort((a, b) => a.row - b.row);
  return { entries, rows: rowNumbers, report: { total, errors, warnings } };
}

/** Parse + persist. Parse-level errors/warnings are merged with the repository's report; row numbers refer to the CSV. */
export async function importGoodreadsCsv(csvText: string, repo: Repository): Promise<ImportReport> {
  const parsed = parseGoodreadsCsv(csvText);
  const { total, errors, warnings } = parsed.report;
  if (parsed.entries.length === 0) {
    return { total, created: 0, merged: 0, skipped: errors.length, errors, warnings };
  }
  const r = await repo.importEntries(parsed.entries);
  // Repository rows are positions in `entries` (assumed 1-based or 0-based); map back to CSV rows when in range.
  const remap = <T extends { row: number }>(list: T[]): T[] =>
    list.map((x) => ({ ...x, row: parsed.rows[x.row - 1] ?? x.row }));
  return {
    total,
    created: r.created,
    merged: r.merged,
    skipped: r.skipped + errors.length,
    errors: [...errors, ...remap(r.errors)].sort((a, b) => a.row - b.row),
    warnings: [...warnings, ...remap(r.warnings)].sort((a, b) => a.row - b.row),
  };
}

/** Parse only (no persistence): for dry runs. */
export function dryRunGoodreadsCsv(csvText: string): ImportReport {
  const { report } = parseGoodreadsCsv(csvText);
  return { total: report.total, created: 0, merged: 0, skipped: report.errors.length, errors: report.errors, warnings: report.warnings };
}
