/** Normalisation helpers for dedupe (owner: A). */

/** lowercase, NFKD accent-stripped, non-alphanumerics removed. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Strips trailing "(Series, #n)" and "(Italian Edition)" style suffixes (Goodreads decorations). */
export function stripTitleSuffix(title: string): string {
  let t = title.trim();
  for (let i = 0; i < 3; i++) {
    const next = t
      .replace(/\s*\([^()]*#\s*\d+[^()]*\)\s*$/u, "")
      .replace(/\s*\([^()]*\b(?:edition|edizione|ed\.)\s*\)\s*$/iu, "")
      .trim();
    if (next === t || !next) break;
    t = next;
  }
  return t;
}

/** Lowercase + accent folding, keeps spaces/punctuation (for substring search). */
export function foldText(s: string): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** `title|firstAuthor`, both normalized; series/edition suffixes in the title are ignored. */
export function matchKey(title: string, authors: readonly string[]): string {
  return `${normalizeText(stripTitleSuffix(title))}|${normalizeText(authors[0] ?? "")}`;
}

/** Strip `=`, quotes, hyphens, spaces; returns digits(+X) if length is 10 or 13, else null. */
export function normalizeIsbn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9Xx]/g, "").toUpperCase();
  return cleaned.length === 10 || cleaned.length === 13 ? cleaned : null;
}

export function isValidDateOnly(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
