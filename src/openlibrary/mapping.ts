/** Open Library JSON -> BookCandidate. Pure functions; every missing field becomes null/[] (never undefined). */
import type { BookCandidate } from "../types.js";

type Json = Record<string, unknown>;

export function cleanIsbn(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[^0-9Xx]/g, "").toUpperCase();
  if (s.length === 13 && /^\d{13}$/.test(s)) return s;
  if (s.length === 10 && /^\d{9}[\dX]$/.test(s)) return s;
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];

export function normalizeWorkKey(key: string): string {
  const k = key.trim();
  const m = /(OL\d+W)/i.exec(k);
  return m ? `/works/${m[1]!.toUpperCase()}` : k.startsWith("/") ? k : `/works/${k}`;
}

export function coverUrlFor(coversUrl: string, coverId: unknown, isbn13: string | null, isbn10: string | null = null): string | null {
  if (typeof coverId === "number" && coverId > 0) return `${coversUrl}/b/id/${coverId}-M.jpg`;
  const isbn = isbn13 ?? isbn10;
  return isbn ? `${coversUrl}/b/isbn/${isbn}-M.jpg` : null;
}

export function descriptionOf(v: unknown): string | null {
  if (typeof v === "string") return str(v);
  if (v && typeof v === "object") return str((v as Json).value);
  return null;
}

export function pickIsbns(list: string[], preferred?: string | null): { isbn10: string | null; isbn13: string | null } {
  const cleaned = list.map(cleanIsbn).filter((x): x is string => x !== null);
  const p = preferred ? cleanIsbn(preferred) : null;
  const all = p ? [p, ...cleaned] : cleaned;
  return {
    isbn13: all.find((x) => x.length === 13) ?? null,
    isbn10: all.find((x) => x.length === 10) ?? null,
  };
}

export function editionKeyOf(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return s.startsWith("/books/") ? s : `/books/${s}`;
}

/** Map one `docs[]` element of /search.json. Returns null when it has no usable key/title. */
export function mapSearchDoc(doc: unknown, coversUrl: string, preferredIsbn?: string | null): BookCandidate | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Json;
  const key = str(d.key);
  const title = str(d.title);
  if (!key || !title || !/OL\d+W/i.test(key)) return null;
  const { isbn10, isbn13 } = pickIsbns(strArr(d.isbn), preferredIsbn);
  const publishers = strArr(d.publisher);
  return {
    olWorkKey: normalizeWorkKey(key),
    olEditionKey: editionKeyOf(d.cover_edition_key) ?? editionKeyOf(strArr(d.edition_key)[0]),
    title,
    subtitle: str(d.subtitle),
    authors: strArr(d.author_name),
    firstPublishYear: num(d.first_publish_year),
    isbn10,
    isbn13,
    publisher: publishers[0] ?? null,
    pageCount: num(d.number_of_pages_median),
    language: strArr(d.language)[0] ?? null,
    subjects: strArr(d.subject).slice(0, 10),
    description: null,
    coverUrl: coverUrlFor(coversUrl, d.cover_i, isbn13, isbn10),
  };
}

export function yearFrom(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /\b(\d{4})\b/.exec(v);
  return m ? Number(m[1]) : null;
}

export function languageFromEdition(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const first = v[0] as Json | undefined;
  const key = first && typeof first.key === "string" ? first.key : null;
  return key ? (key.split("/").pop() ?? null) : null;
}

/** Fill gaps of `base` with `extra` (never overwrite existing non-empty values). */
export function mergeCandidates(base: BookCandidate, extra: Partial<BookCandidate>): BookCandidate {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra) as [keyof BookCandidate, unknown][]) {
    const cur = out[k];
    const empty = cur === null || cur === undefined || (Array.isArray(cur) && cur.length === 0) || cur === "";
    if (empty && v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) {
      (out as unknown as Record<string, unknown>)[k] = v;
    }
  }
  out.subjects = out.subjects.slice(0, 10);
  return out;
}
