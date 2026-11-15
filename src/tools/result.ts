/** Result helpers + text summaries shared by all tools. Every result = text fallback + structuredContent. */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { NotFoundError, ValidationError } from "../db/repository.js";
import { MetadataUnavailableError } from "../openlibrary/client.js";
import type { BookCandidate, BookDetail, BookSummary, ToolStructured } from "../types.js";

export function ok(text: string, structured: ToolStructured): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured as unknown as Record<string, unknown> };
}

export function failText(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Map domain errors to clear isError results. Unknown errors get a generic message (no stack leaked). */
export function fail(e: unknown): CallToolResult {
  if (e instanceof NotFoundError) return failText(e.message);
  if (e instanceof ValidationError) return failText(`Invalid request: ${e.message}`);
  if (e instanceof MetadataUnavailableError) {
    return failText(`Open Library is unavailable right now (${e.message}). Try again later, or add the book manually later.`);
  }
  return failText(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
}

/** Wrap a handler so it never throws to the transport. */
export function safe<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
}

const stars = (n: number | null) => (n ? ` ★${n}` : "");
const authorsOf = (a: string[]) => (a.length ? a.join(", ") : "unknown author");
const year = (y: number | null) => (y ? ` (${y})` : "");

export function summaryLine(b: BookSummary): string {
  const extra = [b.lastFinishedAt ? `finished ${b.lastFinishedAt}` : "", b.noteCount ? `${b.noteCount} notes` : ""].filter(Boolean).join(", ");
  return `#${b.id} ${b.title} — ${authorsOf(b.authors)}${year(b.firstPublishYear)} [${b.shelf ?? "no shelf"}]${stars(b.rating)}${extra ? ` — ${extra}` : ""}`;
}

export function candidateLine(c: BookCandidate, i: number): string {
  const lib = c.inLibrary ? ` [in library as #${c.libraryBookId}]` : "";
  return `${i + 1}. ${c.title} — ${authorsOf(c.authors)}${year(c.firstPublishYear)} · ${c.olWorkKey}${c.isbn13 ? ` · ISBN ${c.isbn13}` : ""}${lib}`;
}

export function detailText(d: BookDetail, action: string | null): string {
  const b = d.book;
  const lines: string[] = [];
  if (action) lines.push(action);
  lines.push(`#${b.id} ${b.title} — ${authorsOf(b.authors)}${year(b.firstPublishYear)} [${d.shelf ?? "no shelf"}]`);
  const meta = [b.pageCount ? `${b.pageCount} pages` : "", b.publisher ?? "", b.isbn13 ? `ISBN ${b.isbn13}` : "", b.subjects.length ? `subjects: ${b.subjects.slice(0, 6).join(", ")}` : ""].filter(Boolean);
  if (meta.length) lines.push(meta.join(" · "));
  if (b.description) lines.push(b.description.length > 400 ? `${b.description.slice(0, 400)}…` : b.description);
  if (d.reads.length) {
    lines.push("Reads:");
    for (const r of d.reads) {
      lines.push(`- ${r.startedAt ?? "?"} → ${r.finishedAt ?? "?"}${stars(r.rating)}${r.review ? ` — ${r.review.length > 200 ? `${r.review.slice(0, 200)}…` : r.review}` : ""}`);
    }
  }
  if (d.notes.length) {
    lines.push("Notes:");
    for (const n of d.notes.slice(0, 20)) {
      const loc = [n.chapter, n.page ? `p.${n.page}` : ""].filter(Boolean).join(", ");
      lines.push(`- [${n.kind}${loc ? `, ${loc}` : ""}] ${n.body.length > 300 ? `${n.body.slice(0, 300)}…` : n.body}`);
    }
  }
  return lines.join("\n");
}
