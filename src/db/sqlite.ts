import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  Book,
  BookDetail,
  BookSummary,
  DateOnly,
  ImportEntry,
  ImportReport,
  LibraryPage,
  LibraryQuery,
  LogReadingInput,
  LogReadingResult,
  NewBook,
  NewNote,
  Note,
  NoteKind,
  ReadEntry,
  RecommendationContext,
  RecommendationOptions,
  ShelfEntry,
  ShelfName,
  UpsertBookResult,
} from "../types.js";
import { NOTE_KINDS, SHELVES } from "../types.js";
import { NotFoundError, ValidationError, type Repository } from "./repository.js";
import { foldText, isValidDateOnly, matchKey, normalizeIsbn } from "./normalize.js";

type Row = Record<string, unknown>;
type Params = SQLInputValue[];

export interface SqliteRepositoryOptions {
  /** Clock override for tests. */
  now?: () => Date;
}

const NOTE_PREVIEW_MAX = 300;

function parseJsonArray(s: unknown): string[] {
  if (typeof s !== "string") return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toBook(r: Row): Book {
  return {
    id: r.id as number,
    olWorkKey: (r.ol_work_key as string | null) ?? null,
    olEditionKey: (r.ol_edition_key as string | null) ?? null,
    goodreadsId: (r.goodreads_id as string | null) ?? null,
    isbn10: (r.isbn10 as string | null) ?? null,
    isbn13: (r.isbn13 as string | null) ?? null,
    title: r.title as string,
    subtitle: (r.subtitle as string | null) ?? null,
    authors: parseJsonArray(r.authors),
    firstPublishYear: (r.first_publish_year as number | null) ?? null,
    publisher: (r.publisher as string | null) ?? null,
    pageCount: (r.page_count as number | null) ?? null,
    language: (r.language as string | null) ?? null,
    subjects: parseJsonArray(r.subjects),
    description: (r.description as string | null) ?? null,
    coverUrl: (r.cover_url as string | null) ?? null,
    source: r.source as Book["source"],
    createdAt: r.created_at as string,
  };
}

function toRead(r: Row): ReadEntry {
  return {
    id: r.id as number,
    bookId: r.book_id as number,
    startedAt: (r.started_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
    rating: (r.rating as number | null) ?? null,
    review: (r.review as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function toNote(r: Row): Note {
  return {
    id: r.id as number,
    bookId: r.book_id as number,
    kind: r.kind as NoteKind,
    body: r.body as string,
    chapter: (r.chapter as string | null) ?? null,
    page: (r.page as number | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function toSummary(r: Row): BookSummary {
  return {
    id: r.id as number,
    title: r.title as string,
    authors: parseJsonArray(r.authors),
    firstPublishYear: (r.first_publish_year as number | null) ?? null,
    coverUrl: (r.cover_url as string | null) ?? null,
    isbn13: (r.isbn13 as string | null) ?? null,
    shelf: (r.shelf as ShelfName | null) ?? null,
    rating: (r.latest_rating as number | null) ?? null,
    lastFinishedAt: (r.last_finished as string | null) ?? null,
    noteCount: (r.note_count as number) ?? 0,
  };
}

/** Summary projection; extra columns shelf_added_at / shelf_updated_at are used for ordering. */
const SUMMARY_SQL = `
SELECT b.id, b.title, b.subtitle, b.authors, b.subjects, b.first_publish_year, b.cover_url, b.isbn13, b.created_at,
  s.shelf AS shelf, s.added_at AS shelf_added_at, s.updated_at AS shelf_updated_at,
  (SELECT r.rating FROM reads r WHERE r.book_id = b.id AND r.rating IS NOT NULL
     ORDER BY r.finished_at DESC, r.id DESC LIMIT 1) AS latest_rating,
  (SELECT MAX(r.finished_at) FROM reads r WHERE r.book_id = b.id AND r.finished_at IS NOT NULL) AS last_finished,
  (SELECT COUNT(*) FROM notes n WHERE n.book_id = b.id) AS note_count
FROM books b LEFT JOIN shelves s ON s.book_id = b.id`;

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function checkRating(rating: number | null | undefined): void {
  if (rating === undefined || rating === null) return;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new ValidationError(`rating must be an integer between 1 and 5 (got ${rating})`);
  }
}

function checkDate(label: string, d: string | null | undefined): void {
  if (d === undefined || d === null) return;
  if (!isValidDateOnly(d)) throw new ValidationError(`${label} must be a valid YYYY-MM-DD date (got "${d}")`);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function createSqliteRepository(db: DatabaseSync, options: SqliteRepositoryOptions = {}): Repository {
  const now = options.now ?? (() => new Date());
  const nowIso = (): string => now().toISOString();
  db.function("fold", { deterministic: true }, (v) => (typeof v === "string" ? foldText(v) : v));

  // ---------------------------------------------------------------- helpers
  const all = (sql: string, params: Params = []): Row[] => db.prepare(sql).all(...params) as Row[];
  const get = (sql: string, params: Params = []): Row | undefined => db.prepare(sql).get(...params) as Row | undefined;
  const run = (sql: string, params: Params = []): { changes: number | bigint; lastInsertRowid: number | bigint } =>
    db.prepare(sql).run(...params);

  let depth = 0;
  let spCounter = 0;
  /** Runs fn atomically: BEGIN at depth 0, SAVEPOINT when nested. Synchronous on purpose. */
  function tx<T>(fn: () => T): T {
    if (depth === 0) {
      db.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    }
    const sp = `sp_${++spCounter}`;
    db.exec(`SAVEPOINT ${sp}`);
    depth++;
    try {
      const out = fn();
      db.exec(`RELEASE ${sp}`);
      return out;
    } catch (e) {
      db.exec(`ROLLBACK TO ${sp}`);
      db.exec(`RELEASE ${sp}`);
      throw e;
    } finally {
      depth--;
    }
  }

  function requireBook(id: number): Row {
    const r = get("SELECT * FROM books WHERE id = ?", [id]);
    if (!r) throw new NotFoundError("Book", id);
    return r;
  }

  function findMatch(input: NewBook, isbn13: string | null, isbn10: string | null, key: string): Row | undefined {
    if (input.olWorkKey) {
      const r = get("SELECT * FROM books WHERE ol_work_key = ?", [input.olWorkKey]);
      if (r) return r;
    }
    for (const isbn of [isbn13, isbn10].filter((x): x is string => !!x)) {
      const r = get("SELECT * FROM books WHERE isbn13 = ? OR isbn10 = ? ORDER BY id LIMIT 1", [isbn, isbn]);
      if (r) return r;
    }
    if (input.goodreadsId) {
      const r = get("SELECT * FROM books WHERE goodreads_id = ?", [input.goodreadsId]);
      if (r) return r;
    }
    return get("SELECT * FROM books WHERE match_key = ? ORDER BY id LIMIT 1", [key]);
  }

  function upsertBookSync(input: NewBook): UpsertBookResult {
    const title = input.title?.trim();
    if (!title) throw new ValidationError("title is required");
    const authors = (input.authors ?? []).map((a) => a.trim()).filter(Boolean);
    const isbn13 = normalizeIsbn(input.isbn13);
    const isbn13v = isbn13 && isbn13.length === 13 ? isbn13 : null;
    const isbn10n = normalizeIsbn(input.isbn10);
    const isbn10v = isbn10n && isbn10n.length === 10 ? isbn10n : null;
    const key = matchKey(title, authors);
    const subjects = [...new Set((input.subjects ?? []).map((s) => s.trim()).filter(Boolean))];
    const source = input.source ?? "manual";

    const existing = findMatch(input, isbn13v, isbn10v, key);
    if (!existing) {
      const res = run(
        `INSERT INTO books (ol_work_key, ol_edition_key, goodreads_id, isbn10, isbn13, title, subtitle, authors,
           first_publish_year, publisher, page_count, language, subjects, description, cover_url, source, match_key, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          input.olWorkKey ?? null,
          input.olEditionKey ?? null,
          input.goodreadsId ?? null,
          isbn10v,
          isbn13v,
          title,
          input.subtitle ?? null,
          JSON.stringify(authors),
          input.firstPublishYear ?? null,
          input.publisher ?? null,
          input.pageCount ?? null,
          input.language ?? null,
          JSON.stringify(subjects),
          input.description ?? null,
          input.coverUrl ?? null,
          source,
          key,
          nowIso(),
        ],
      );
      return { book: toBook(requireBook(Number(res.lastInsertRowid))), created: true };
    }

    // Merge: fill gaps only.
    const id = existing.id as number;
    const sets: string[] = [];
    const params: Params = [];
    const fill = (col: string, current: unknown, value: unknown): void => {
      if ((current === null || current === undefined || current === "") && value !== null && value !== undefined && value !== "") {
        sets.push(`${col} = ?`);
        params.push(value as SQLInputValue);
      }
    };
    const taken = (col: string, value: string): boolean =>
      !!get(`SELECT 1 AS x FROM books WHERE ${col} = ? AND id <> ?`, [value, id]);
    if (input.olWorkKey && !existing.ol_work_key && !taken("ol_work_key", input.olWorkKey)) fill("ol_work_key", null, input.olWorkKey);
    if (input.goodreadsId && !existing.goodreads_id && !taken("goodreads_id", input.goodreadsId)) fill("goodreads_id", null, input.goodreadsId);
    fill("ol_edition_key", existing.ol_edition_key, input.olEditionKey);
    fill("isbn10", existing.isbn10, isbn10v);
    fill("isbn13", existing.isbn13, isbn13v);
    fill("subtitle", existing.subtitle, input.subtitle);
    fill("first_publish_year", existing.first_publish_year, input.firstPublishYear);
    fill("publisher", existing.publisher, input.publisher);
    fill("page_count", existing.page_count, input.pageCount);
    fill("language", existing.language, input.language);
    fill("description", existing.description, input.description);
    fill("cover_url", existing.cover_url, input.coverUrl);
    const existingAuthors = parseJsonArray(existing.authors);
    if (existingAuthors.length === 0 && authors.length > 0) {
      sets.push("authors = ?", "match_key = ?");
      params.push(JSON.stringify(authors), key);
    }
    const existingSubjects = parseJsonArray(existing.subjects);
    const union = [...new Set([...existingSubjects, ...subjects])];
    if (union.length !== existingSubjects.length) {
      sets.push("subjects = ?");
      params.push(JSON.stringify(union));
    }
    if (sets.length > 0) run(`UPDATE books SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
    return { book: toBook(requireBook(id)), created: false };
  }

  function setShelfSync(bookId: number, shelf: ShelfName, addedAtOverride?: string): ShelfEntry {
    if (!SHELVES.includes(shelf)) throw new ValidationError(`unknown shelf "${shelf}"`);
    requireBook(bookId);
    const ts = nowIso();
    run(
      `INSERT INTO shelves (book_id, shelf, added_at, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(book_id) DO UPDATE SET shelf = excluded.shelf, updated_at = excluded.updated_at`,
      [bookId, shelf, addedAtOverride ?? ts, ts],
    );
    return getShelfSync(bookId)!;
  }

  function getShelfSync(bookId: number): ShelfEntry | null {
    const r = get("SELECT * FROM shelves WHERE book_id = ?", [bookId]);
    if (!r) return null;
    return {
      bookId: r.book_id as number,
      shelf: r.shelf as ShelfName,
      addedAt: r.added_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  function insertRead(
    bookId: number,
    v: { startedAt: string | null; finishedAt: string | null; rating: number | null; review: string | null },
  ): ReadEntry {
    const res = run(
      "INSERT INTO reads (book_id, started_at, finished_at, rating, review, created_at) VALUES (?,?,?,?,?,?)",
      [bookId, v.startedAt, v.finishedAt, v.rating, v.review, nowIso()],
    );
    return toRead(get("SELECT * FROM reads WHERE id = ?", [Number(res.lastInsertRowid)])!);
  }

  function checkDateOrder(startedAt: string | null, finishedAt: string | null): void {
    if (startedAt && finishedAt && finishedAt < startedAt) {
      throw new ValidationError(`finishedAt (${finishedAt}) cannot be before startedAt (${startedAt})`);
    }
  }

  function logReadingSync(input: LogReadingInput): LogReadingResult {
    requireBook(input.bookId);
    checkRating(input.rating);
    checkDate("startedAt", input.startedAt);
    checkDate("finishedAt", input.finishedAt);
    const hasDates = input.startedAt != null || input.finishedAt != null;
    const hasRatingOrReview = input.rating !== undefined || input.review !== undefined;

    const openRead = get(
      "SELECT * FROM reads WHERE book_id = ? AND finished_at IS NULL ORDER BY id DESC LIMIT 1",
      [input.bookId],
    );
    let target: Row | undefined;
    if (!input.newRead) {
      if (hasDates) target = openRead;
      else
        target =
          openRead ??
          get(
            "SELECT * FROM reads WHERE book_id = ? ORDER BY finished_at DESC, started_at DESC, id DESC LIMIT 1",
            [input.bookId],
          );
    }

    let read: ReadEntry;
    let createdRead: boolean;
    if (target) {
      const cur = toRead(target);
      const startedAt = input.startedAt ?? cur.startedAt;
      const finishedAt = input.finishedAt ?? cur.finishedAt;
      checkDateOrder(startedAt, finishedAt);
      const rating = input.rating !== undefined ? input.rating : cur.rating;
      const review = input.review !== undefined ? input.review : cur.review;
      run("UPDATE reads SET started_at = ?, finished_at = ?, rating = ?, review = ? WHERE id = ?", [
        startedAt,
        finishedAt,
        rating,
        review,
        cur.id,
      ]);
      read = toRead(get("SELECT * FROM reads WHERE id = ?", [cur.id])!);
      createdRead = false;
    } else {
      const startedAt = input.startedAt ?? null;
      const finishedAt = input.finishedAt ?? null;
      checkDateOrder(startedAt, finishedAt);
      read = insertRead(input.bookId, {
        startedAt,
        finishedAt,
        rating: input.rating ?? null,
        review: input.review ?? null,
      });
      createdRead = true;
    }

    let shelf: ShelfName;
    if (input.finishedAt != null) shelf = "read";
    else if (input.startedAt != null) shelf = "reading";
    else if (hasRatingOrReview) shelf = "read";
    else shelf = read.finishedAt ? "read" : "reading";
    setShelfSync(input.bookId, shelf);
    return { read, shelf, createdRead };
  }

  function detailSync(id: number): BookDetail | null {
    const b = get("SELECT * FROM books WHERE id = ?", [id]);
    if (!b) return null;
    const shelf = getShelfSync(id)?.shelf ?? null;
    const reads = all(
      "SELECT * FROM reads WHERE book_id = ? ORDER BY finished_at DESC, started_at DESC, id DESC",
      [id],
    ).map(toRead);
    const notes = all("SELECT * FROM notes WHERE book_id = ? ORDER BY created_at DESC, id DESC", [id]).map(toNote);
    return { book: toBook(b), shelf, reads, notes };
  }

  // ---------------------------------------------------------------- search
  function searchSync(q: LibraryQuery): LibraryPage {
    const where: string[] = [];
    const params: Params = [];
    const tokens = (q.q ?? "").split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      const pat = `%${likeEscape(foldText(t))}%`;
      where.push(
        `(fold(base.title) LIKE ? ESCAPE '\\' OR fold(base.subtitle) LIKE ? ESCAPE '\\' OR fold(base.authors) LIKE ? ESCAPE '\\'
          OR fold(base.subjects) LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM notes n WHERE n.book_id = base.id AND fold(n.body) LIKE ? ESCAPE '\\'))`,
      );
      params.push(pat, pat, pat, pat, pat);
    }
    if (q.shelf) {
      where.push("base.shelf = ?");
      params.push(q.shelf);
    }
    if (q.minRating != null) {
      where.push("base.latest_rating >= ?");
      params.push(q.minRating);
    }
    if (q.maxRating != null) {
      where.push("base.latest_rating <= ?");
      params.push(q.maxRating);
    }
    if (q.finishedFrom) {
      where.push("base.last_finished >= ?");
      params.push(q.finishedFrom);
    }
    if (q.finishedTo) {
      where.push("base.last_finished <= ?");
      params.push(q.finishedTo);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const order: Record<NonNullable<LibraryQuery["sort"]>, string> = {
      added_desc: "COALESCE(base.shelf_added_at, base.created_at) DESC",
      added_asc: "COALESCE(base.shelf_added_at, base.created_at) ASC",
      title: "base.title COLLATE NOCASE ASC",
      rating_desc: "base.latest_rating DESC",
      finished_desc: "base.last_finished DESC",
    };
    const orderSql = `${order[q.sort ?? "added_desc"] ?? order.added_desc}, base.id DESC`;
    const limit = Math.min(Math.max(Math.trunc(q.limit ?? 20), 1), 100);
    const offset = Math.max(Math.trunc(q.offset ?? 0), 0);

    const total = get(`WITH base AS (${SUMMARY_SQL}) SELECT COUNT(*) AS c FROM base ${whereSql}`, params)!.c as number;
    const rows = all(
      `WITH base AS (${SUMMARY_SQL}) SELECT * FROM base ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { total, items: rows.map(toSummary) };
  }

  // ---------------------------------------------------------------- recommendation context
  function contextSync(options: RecommendationOptions = {}): RecommendationContext {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 15), 1), 50);
    const recentCount = Math.min(Math.max(Math.trunc(options.recentCount ?? 10), 1), 50);
    const rows = all(`${SUMMARY_SQL} ORDER BY b.id`);
    const books = rows.map((r) => ({ s: toSummary(r), subjects: parseJsonArray(r.subjects), addedAt: r.shelf_added_at as string | null, updatedAt: r.shelf_updated_at as string | null }));

    const counts = { "to-read": 0, reading: 0, read: 0, total: books.length, rated: 0 };
    let ratingSum = 0;
    for (const { s } of books) {
      if (s.shelf) counts[s.shelf]++;
      if (s.rating != null) {
        counts.rated++;
        ratingSum += s.rating;
      }
    }
    const averageRating = counts.rated ? Math.round((ratingSum / counts.rated) * 100) / 100 : null;

    const cmpDesc = (a: BookSummary, b: BookSummary): number =>
      (b.rating ?? 0) - (a.rating ?? 0) ||
      (b.lastFinishedAt ?? "").localeCompare(a.lastFinishedAt ?? "") ||
      b.id - a.id;
    const summaries = books.map((b) => b.s);
    const lovedAll = summaries.filter((s) => s.rating != null && s.rating >= 4).sort(cmpDesc);
    const disliked = summaries.filter((s) => s.rating != null && s.rating <= 2).sort(cmpDesc).slice(0, limit);
    const recentReads = summaries
      .filter((s) => s.lastFinishedAt)
      .sort((a, b) => b.lastFinishedAt!.localeCompare(a.lastFinishedAt!) || b.id - a.id)
      .slice(0, recentCount);
    const currentlyReading = books
      .filter((b) => b.s.shelf === "reading")
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || b.s.id - a.s.id)
      .map((b) => b.s)
      .slice(0, limit);
    const toRead = books
      .filter((b) => b.s.shelf === "to-read")
      .sort((a, b) => (a.addedAt ?? "").localeCompare(b.addedAt ?? "") || a.s.id - b.s.id)
      .map((b) => b.s)
      .slice(0, limit);

    // Taste frequencies over books that have actually been read.
    const readBooks = books.filter((b) => b.s.shelf === "read" || b.s.rating != null || b.s.lastFinishedAt != null);
    const rank = (m: Map<string, { n: number; sum: number; rated: number }>, field: "author" | "subject") =>
      [...m.entries()]
        .map(([name, v]) => ({
          [field]: name,
          books: v.n,
          avgRating: v.rated ? Math.round((v.sum / v.rated) * 100) / 100 : null,
        }))
        .sort(
          (a, b) =>
            b.books - a.books ||
            (b.avgRating ?? -1) - (a.avgRating ?? -1) ||
            String(a[field]).localeCompare(String(b[field])),
        )
        .slice(0, 10);
    const authorMap = new Map<string, { n: number; sum: number; rated: number }>();
    const subjectMap = new Map<string, { n: number; sum: number; rated: number }>();
    const bump = (m: typeof authorMap, name: string, rating: number | null): void => {
      const v = m.get(name) ?? { n: 0, sum: 0, rated: 0 };
      v.n++;
      if (rating != null) {
        v.sum += rating;
        v.rated++;
      }
      m.set(name, v);
    };
    for (const b of readBooks) {
      for (const a of new Set(b.s.authors)) bump(authorMap, a, b.s.rating);
      for (const sub of new Set(b.subjects)) bump(subjectMap, sub, b.s.rating);
    }
    const topAuthors = rank(authorMap, "author") as RecommendationContext["topAuthors"];
    const topSubjects = rank(subjectMap, "subject") as RecommendationContext["topSubjects"];

    const lovedIds = lovedAll.map((s) => s.id);
    let recentNotes: RecommendationContext["recentNotes"] = [];
    if (lovedIds.length) {
      const ph = lovedIds.map(() => "?").join(",");
      recentNotes = all(
        `SELECT n.book_id, n.kind, n.body, b.title FROM notes n JOIN books b ON b.id = n.book_id
         WHERE n.book_id IN (${ph}) ORDER BY n.created_at DESC, n.id DESC LIMIT 10`,
        lovedIds,
      ).map((r) => ({
        bookId: r.book_id as number,
        title: r.title as string,
        kind: r.kind as NoteKind,
        body: truncate(r.body as string, NOTE_PREVIEW_MAX),
      }));
    }

    return {
      generatedAt: nowIso(),
      counts,
      averageRating,
      loved: lovedAll.slice(0, limit),
      disliked,
      recentReads,
      currentlyReading,
      toRead,
      topAuthors,
      topSubjects,
      recentNotes,
    };
  }

  // ---------------------------------------------------------------- import
  function importOne(entry: ImportEntry): { created: boolean; changed: boolean } {
    const { book, created } = upsertBookSync(entry.book);
    let changed = created;

    if (entry.shelf && !getShelfSync(book.id)) {
      const addedAt = entry.addedAt && isValidDateOnly(entry.addedAt) ? `${entry.addedAt}T00:00:00.000Z` : undefined;
      setShelfSync(book.id, entry.shelf, addedAt);
      changed = true;
    }

    // Count-based dedupe so repeated identical (e.g. undated "read count") reads are preserved yet idempotent.
    const sig = (r: { startedAt: string | null; finishedAt: string | null }): string =>
      `${r.startedAt ?? ""}|${r.finishedAt ?? ""}`;
    const existingCounts = new Map<string, number>();
    for (const r of all("SELECT * FROM reads WHERE book_id = ?", [book.id]).map(toRead)) {
      existingCounts.set(sig(r), (existingCounts.get(sig(r)) ?? 0) + 1);
    }
    for (const r of entry.reads) {
      checkRating(r.rating);
      checkDate("startedAt", r.startedAt);
      checkDate("finishedAt", r.finishedAt);
      checkDateOrder(r.startedAt, r.finishedAt);
      const k = sig(r);
      const have = existingCounts.get(k) ?? 0;
      if (have > 0) {
        existingCounts.set(k, have - 1);
        continue;
      }
      insertRead(book.id, { startedAt: r.startedAt, finishedAt: r.finishedAt, rating: r.rating, review: r.review });
      changed = true;
    }

    const bodies = new Set(all("SELECT body FROM notes WHERE book_id = ?", [book.id]).map((r) => r.body as string));
    for (const n of entry.notes) {
      if (!NOTE_KINDS.includes(n.kind)) throw new ValidationError(`unknown note kind "${n.kind}"`);
      if (!n.body?.trim() || bodies.has(n.body)) continue;
      insertNote({ bookId: book.id, kind: n.kind, body: n.body });
      bodies.add(n.body);
      changed = true;
    }
    return { created, changed };
  }

  function insertNote(input: NewNote): Note {
    const res = run("INSERT INTO notes (book_id, kind, body, chapter, page, created_at) VALUES (?,?,?,?,?,?)", [
      input.bookId,
      input.kind,
      input.body,
      input.chapter ?? null,
      input.page ?? null,
      nowIso(),
    ]);
    return toNote(get("SELECT * FROM notes WHERE id = ?", [Number(res.lastInsertRowid)])!);
  }

  // ---------------------------------------------------------------- Repository
  return {
    async upsertBook(input) {
      return tx(() => upsertBookSync(input));
    },
    async getBook(id) {
      const r = get("SELECT * FROM books WHERE id = ?", [id]);
      return r ? toBook(r) : null;
    },
    async getBookDetail(id) {
      return detailSync(id);
    },
    async findBookByExternalIds(ids) {
      if (ids.olWorkKey) {
        const r = get("SELECT * FROM books WHERE ol_work_key = ?", [ids.olWorkKey]);
        if (r) return toBook(r);
      }
      const isbn = normalizeIsbn(ids.isbn13);
      if (isbn) {
        const r = get("SELECT * FROM books WHERE isbn13 = ? OR isbn10 = ? ORDER BY id LIMIT 1", [isbn, isbn]);
        if (r) return toBook(r);
      }
      if (ids.goodreadsId) {
        const r = get("SELECT * FROM books WHERE goodreads_id = ?", [ids.goodreadsId]);
        if (r) return toBook(r);
      }
      return null;
    },
    async searchLibrary(query) {
      return searchSync(query);
    },
    async setShelf(bookId, shelf) {
      return tx(() => setShelfSync(bookId, shelf));
    },
    async clearShelf(bookId) {
      requireBook(bookId);
      run("DELETE FROM shelves WHERE book_id = ?", [bookId]);
    },
    async getShelf(bookId) {
      return getShelfSync(bookId);
    },
    async logReading(input) {
      return tx(() => logReadingSync(input));
    },
    async addNote(input) {
      requireBook(input.bookId);
      if (!NOTE_KINDS.includes(input.kind)) throw new ValidationError(`unknown note kind "${input.kind}"`);
      if (!input.body || !input.body.trim()) throw new ValidationError("note body is required");
      if (input.page != null && (!Number.isInteger(input.page) || input.page < 0)) {
        throw new ValidationError("page must be a non-negative integer");
      }
      return tx(() => insertNote(input));
    },
    async getRecommendationContext(options) {
      return contextSync(options);
    },
    async importEntries(entries) {
      const report: ImportReport = { total: entries.length, created: 0, merged: 0, skipped: 0, errors: [], warnings: [] };
      tx(() => {
        entries.forEach((entry, i) => {
          const row = i + 1;
          try {
            const r = tx(() => importOne(entry));
            if (r.created) report.created++;
            else {
              report.merged++;
              if (!r.changed) report.skipped++;
            }
          } catch (e) {
            report.errors.push({ row, title: entry?.book?.title, message: e instanceof Error ? e.message : String(e) });
          }
        });
      });
      return report;
    },
    async close() {
      db.close();
    },
  };
}
