/**
 * Tool INPUT schemas (zod) = the public tool contract. Owner: architect; C registers tools with these exact shapes.
 * Descriptions are written for the model: keep them, they are what Claude reads.
 */
import { z } from "zod";
import { NOTE_KINDS, SHELVES } from "../types.js";

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date");
const shelf = z.enum(SHELVES);
const bookId = z.number().int().positive().describe("Library book id (from search_library / add_book results)");

export const SearchLibraryInput = z.object({
  query: z.string().trim().max(200).optional().describe("Text matched against title, author, subjects and notes"),
  shelf: shelf.optional().describe("Restrict to a shelf"),
  minRating: z.number().int().min(1).max(5).optional(),
  maxRating: z.number().int().min(1).max(5).optional(),
  finishedFrom: dateOnly.optional(),
  finishedTo: dateOnly.optional(),
  sort: z.enum(["added_desc", "added_asc", "title", "rating_desc", "finished_desc"]).default("added_desc"),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export const SearchOpenLibraryInput = z
  .object({
    query: z.string().trim().min(1).max(200).optional().describe("Free text: title and/or author"),
    title: z.string().trim().min(1).max(200).optional(),
    author: z.string().trim().min(1).max(200).optional(),
    isbn: z.string().trim().min(10).max(17).optional(),
    limit: z.number().int().min(1).max(20).default(8),
  })
  .refine((v) => v.query || v.title || v.author || v.isbn, "Provide query, title, author or isbn");

/** Provide EITHER olWorkKey/isbn (exact) OR title(+author) (best match). */
export const AddBookInput = z
  .object({
    olWorkKey: z.string().regex(/^(\/works\/)?OL\d+W$/).optional().describe('Open Library work key from search_open_library, e.g. "/works/OL45883W"'),
    isbn: z.string().trim().min(10).max(17).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    author: z.string().trim().min(1).max(200).optional(),
    shelf: shelf.default("to-read"),
  })
  .refine((v) => v.olWorkKey || v.isbn || v.title, "Provide olWorkKey, isbn or title");

export const SetShelfInput = z.object({
  bookId,
  shelf: shelf.nullable().describe("Target shelf, or null to remove the book from all shelves"),
});

export const LogReadingInput = z
  .object({
    bookId,
    startedAt: dateOnly.optional().describe("Date the user started the book; moves it to 'reading'"),
    finishedAt: dateOnly.optional().describe("Date the user finished; moves it to 'read'"),
    rating: z.number().int().min(1).max(5).nullable().optional().describe("1-5 stars; null clears"),
    review: z.string().max(10_000).nullable().optional(),
    newRead: z.boolean().optional().describe("Force a new read entry (re-read)"),
  })
  .refine((v) => v.startedAt || v.finishedAt || v.rating !== undefined || v.review !== undefined, "Provide at least one of startedAt, finishedAt, rating, review")
  .refine((v) => !v.startedAt || !v.finishedAt || v.finishedAt >= v.startedAt, "finishedAt must be on/after startedAt");

export const AddNoteInput = z.object({
  bookId,
  kind: z.enum(NOTE_KINDS).default("note").describe("'highlight' for a quoted passage, 'note' for the user's own thoughts"),
  body: z.string().trim().min(1).max(10_000),
  chapter: z.string().trim().max(200).optional(),
  page: z.number().int().positive().optional(),
});

export const GetRecommendationContextInput = z.object({
  limit: z.number().int().min(1).max(50).default(15).describe("Max items per list"),
  recentCount: z.number().int().min(1).max(50).default(10),
});

export const GetBookInput = z.object({ bookId });

export const ShowShelfInput = z.object({
  shelf: shelf.optional().describe("Omit to show the whole library"),
  limit: z.number().int().min(1).max(100).default(30),
  offset: z.number().int().min(0).default(0),
});

export const ImportGoodreadsCsvInput = z.object({
  csv: z.string().min(1).max(5_000_000).describe("Full text of the Goodreads library export CSV"),
  dryRun: z.boolean().default(false).describe("Parse and report without writing"),
});

export type SearchLibraryArgs = z.infer<typeof SearchLibraryInput>;
export type SearchOpenLibraryArgs = z.infer<typeof SearchOpenLibraryInput>;
export type AddBookArgs = z.infer<typeof AddBookInput>;
export type SetShelfArgs = z.infer<typeof SetShelfInput>;
export type LogReadingArgs = z.infer<typeof LogReadingInput>;
export type AddNoteArgs = z.infer<typeof AddNoteInput>;
export type GetRecommendationContextArgs = z.infer<typeof GetRecommendationContextInput>;
export type GetBookArgs = z.infer<typeof GetBookInput>;
export type ShowShelfArgs = z.infer<typeof ShowShelfInput>;
export type ImportGoodreadsCsvArgs = z.infer<typeof ImportGoodreadsCsvInput>;
