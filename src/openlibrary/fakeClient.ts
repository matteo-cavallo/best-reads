/** In-memory BookMetadataClient for tests of other modules. Matches by substring on title/authors/isbn/work key. */
import type { BookCandidate } from "../types.js";
import type { BookMetadataClient, BookSearchQuery } from "./client.js";

const fold = (s: string) =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const isbnKey = (s: string) => s.replace(/[^0-9Xx]/g, "").toUpperCase();

export function createFakeMetadataClient(candidates: BookCandidate[]): BookMetadataClient {
  const copy = (c: BookCandidate): BookCandidate => structuredClone(c);
  return {
    async search(q: BookSearchQuery, limit = 8) {
      const cap = Math.max(1, Math.min(limit, 20));
      if (q.isbn) {
        const k = isbnKey(q.isbn);
        return candidates.filter((c) => c.isbn13 === k || c.isbn10 === k).slice(0, cap).map(copy);
      }
      const free = fold([q.query, q.title, q.author].filter(Boolean).join(" "));
      const tokens = free.split(" ").filter(Boolean);
      return candidates
        .filter((c) => {
          const hay = fold(`${c.title} ${c.subtitle ?? ""} ${c.authors.join(" ")}`);
          return tokens.every((t) => hay.includes(t));
        })
        .slice(0, cap)
        .map(copy);
    },
    async lookupByIsbn(isbn: string) {
      const k = isbnKey(isbn);
      const c = candidates.find((x) => x.isbn13 === k || x.isbn10 === k);
      return c ? copy(c) : null;
    },
    async lookupByWorkKey(key: string) {
      const m = /OL\d+W/i.exec(key);
      const norm = m ? `/works/${m[0].toUpperCase()}` : key;
      const c = candidates.find((x) => x.olWorkKey === norm);
      return c ? copy(c) : null;
    },
  };
}
