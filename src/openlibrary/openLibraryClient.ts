/** Open Library implementation of BookMetadataClient. All HTTP goes through the injectable `fetch`. */
import type { BookCandidate } from "../types.js";
import { MetadataUnavailableError, type BookMetadataClient, type BookSearchQuery } from "./client.js";
import {
  cleanIsbn,
  coverUrlFor,
  descriptionOf,
  editionKeyOf,
  languageFromEdition,
  mapSearchDoc,
  mergeCandidates,
  normalizeWorkKey,
  pickIsbns,
  yearFrom,
} from "./mapping.js";

export interface OpenLibraryClientOptions {
  baseUrl: string;
  coversUrl: string;
  userAgent: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  /** Delay before the single retry (default 300 ms). Tests pass 0. */
  retryDelayMs?: number;
}

const SEARCH_FIELDS =
  "key,title,subtitle,author_name,first_publish_year,isbn,publisher,number_of_pages_median,language,subject,cover_i,cover_edition_key,edition_key";

type Json = Record<string, unknown>;

export function createOpenLibraryClient(opts: OpenLibraryClientOptions): BookMetadataClient {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const covers = opts.coversUrl.replace(/\/+$/, "");
  const retryDelay = opts.retryDelayMs ?? 300;
  const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

  /** GET JSON. 404 -> null. 5xx/429/network error -> one retry, then MetadataUnavailableError. */
  async function getJson(path: string): Promise<Json | null> {
    const url = `${base}${path}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(retryDelay);
      try {
        const res = await doFetch(url, {
          headers: { "User-Agent": opts.userAgent, Accept: "application/json" },
          signal: AbortSignal.timeout(opts.timeoutMs),
          redirect: "follow",
        });
        if (res.status === 404) return null;
        if (res.status >= 500 || res.status === 429) {
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        if (!res.ok) throw new MetadataUnavailableError(`Open Library returned HTTP ${res.status}`);
        const body: unknown = await res.json();
        if (!body || typeof body !== "object") throw new MetadataUnavailableError("Open Library returned an unexpected payload");
        return body as Json;
      } catch (e) {
        if (e instanceof MetadataUnavailableError) throw e;
        lastErr = e;
      }
    }
    const name = (lastErr as { name?: string } | undefined)?.name;
    const why = name === "TimeoutError" || name === "AbortError" ? "timed out" : lastErr instanceof Error ? lastErr.message : "request failed";
    throw new MetadataUnavailableError(`Open Library unavailable (${why})`, { cause: lastErr });
  }

  async function searchRaw(params: Record<string, string>, limit: number, preferredIsbn?: string | null): Promise<BookCandidate[]> {
    const qs = new URLSearchParams({ ...params, limit: String(limit), fields: SEARCH_FIELDS });
    const body = await getJson(`/search.json?${qs.toString()}`);
    const docs = body && Array.isArray(body.docs) ? body.docs : [];
    const out: BookCandidate[] = [];
    for (const d of docs) {
      const c = mapSearchDoc(d, covers, preferredIsbn);
      if (c) out.push(c);
      if (out.length >= limit) break;
    }
    return out;
  }

  async function authorNames(keys: string[]): Promise<string[]> {
    const names: string[] = [];
    for (const k of keys.slice(0, 5)) {
      try {
        const a = await getJson(`${k.startsWith("/") ? k : `/authors/${k}`}.json`);
        const n = a && typeof a.name === "string" ? a.name.trim() : "";
        if (n) names.push(n);
      } catch {
        /* best effort */
      }
    }
    return names;
  }

  const workAuthorKeys = (work: Json): string[] =>
    (Array.isArray(work.authors) ? work.authors : [])
      .map((a) => ((a as Json)?.author as Json | undefined)?.key ?? (a as Json)?.key)
      .filter((k): k is string => typeof k === "string");

  async function lookupByWorkKey(key: string): Promise<BookCandidate | null> {
    const wk = normalizeWorkKey(key);
    const work = await getJson(`${wk}.json`);
    if (!work) return null;
    const title = typeof work.title === "string" ? work.title.trim() : "";
    if (!title) return null;
    let found: BookCandidate | null = null;
    try {
      found = (await searchRaw({ q: `key:${wk}` }, 1))[0] ?? null;
    } catch {
      found = null;
    }
    const coverId = Array.isArray(work.covers) ? work.covers.find((c) => typeof c === "number" && c > 0) : undefined;
    const fromWork: Partial<BookCandidate> = {
      subtitle: typeof work.subtitle === "string" && work.subtitle.trim() ? work.subtitle.trim() : null,
      description: descriptionOf(work.description),
      subjects: (Array.isArray(work.subjects) ? work.subjects : [])
        .filter((s): s is string => typeof s === "string")
        .slice(0, 10),
      firstPublishYear: yearFrom(work.first_publish_date),
      coverUrl: coverUrlFor(covers, coverId, null),
    };
    const base: BookCandidate =
      found ?? {
        olWorkKey: wk,
        olEditionKey: null,
        title,
        subtitle: null,
        authors: [],
        firstPublishYear: null,
        isbn10: null,
        isbn13: null,
        publisher: null,
        pageCount: null,
        language: null,
        subjects: [],
        description: null,
        coverUrl: null,
      };
    const merged = mergeCandidates(base, fromWork);
    if (merged.authors.length === 0) merged.authors = await authorNames(workAuthorKeys(work));
    return merged;
  }

  async function lookupByIsbn(isbnRaw: string): Promise<BookCandidate | null> {
    const isbn = cleanIsbn(isbnRaw);
    if (!isbn) return null;
    const edition = await getJson(`/isbn/${isbn}.json`);
    if (!edition) {
      // Edition endpoint misses some books that search still knows.
      const viaSearch = (await searchRaw({ isbn }, 1, isbn))[0];
      return viaSearch ?? null;
    }
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const { isbn10, isbn13 } = pickIsbns([...arr(edition.isbn_13), ...arr(edition.isbn_10)], isbn);
    const workKeyRaw = Array.isArray(edition.works) ? ((edition.works[0] as Json | undefined)?.key as string | undefined) : undefined;
    const editionCover = Array.isArray(edition.covers) ? edition.covers.find((c) => typeof c === "number" && c > 0) : undefined;
    const editionKey = editionKeyOf(edition.key);
    const editionCand: Partial<BookCandidate> = {
      olEditionKey: editionKey,
      title: typeof edition.title === "string" ? edition.title.trim() : undefined,
      subtitle: typeof edition.subtitle === "string" ? edition.subtitle.trim() : null,
      isbn10,
      isbn13,
      publisher: arr(edition.publishers)[0] ?? null,
      pageCount: typeof edition.number_of_pages === "number" ? edition.number_of_pages : null,
      language: languageFromEdition(edition.languages),
      firstPublishYear: yearFrom(edition.publish_date),
      description: descriptionOf(edition.description),
      coverUrl: coverUrlFor(covers, editionCover, isbn13, isbn10),
    };
    let base: BookCandidate | null = null;
    if (workKeyRaw) {
      try {
        base = await lookupByWorkKey(workKeyRaw);
      } catch {
        base = null;
      }
    }
    if (!base) {
      const viaSearch = (await searchRaw({ isbn }, 1, isbn))[0];
      base =
        viaSearch ??
        (workKeyRaw && typeof editionCand.title === "string"
          ? {
              olWorkKey: normalizeWorkKey(workKeyRaw),
              olEditionKey: null,
              title: editionCand.title,
              subtitle: null,
              authors: [],
              firstPublishYear: null,
              isbn10: null,
              isbn13: null,
              publisher: null,
              pageCount: null,
              language: null,
              subjects: [],
              description: null,
              coverUrl: null,
            }
          : null);
    }
    if (!base) return null; // edition without a work cannot be keyed
    // The specific edition's data wins over the work-level guesses.
    const out: BookCandidate = { ...base };
    for (const k of ["olEditionKey", "isbn10", "isbn13", "publisher", "pageCount", "language"] as const) {
      const v = editionCand[k];
      if (v !== null && v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
    }
    return mergeCandidates(out, {
      coverUrl: editionCand.coverUrl ?? null,
      subtitle: editionCand.subtitle ?? null,
      firstPublishYear: editionCand.firstPublishYear ?? null,
      description: editionCand.description ?? null,
    });
  }

  return {
    async search(q: BookSearchQuery, limit = 8) {
      const cap = Math.max(1, Math.min(Math.floor(limit) || 8, 20));
      const isbn = q.isbn ? cleanIsbn(q.isbn) : null;
      if (q.isbn) {
        if (!isbn) return [];
        return searchRaw({ isbn }, cap, isbn);
      }
      const params: Record<string, string> = {};
      if (q.title?.trim() || q.author?.trim()) {
        if (q.title?.trim()) params.title = q.title.trim();
        if (q.author?.trim()) params.author = q.author.trim();
        if (q.query?.trim()) params.q = q.query.trim();
      } else if (q.query?.trim()) {
        params.q = q.query.trim();
      } else {
        return [];
      }
      return searchRaw(params, cap);
    },
    lookupByIsbn,
    lookupByWorkKey,
  };
}
