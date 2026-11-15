import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RecommendationContext, RecommendationContextStructured, ServerDeps } from "../types.js";
import { GetRecommendationContextInput, type GetRecommendationContextArgs } from "./schemas.js";
import { ok, safe, summaryLine } from "./result.js";

export function contextText(c: RecommendationContext): string {
  const section = (name: string, rows: string[]) => (rows.length ? [`\n${name}:`, ...rows.map((r) => `- ${r}`)] : [`\n${name}: none`]);
  const k = c.counts;
  return [
    `Reading profile (${c.generatedAt.slice(0, 10)}): ${k.total} books — to-read ${k["to-read"]}, reading ${k.reading}, read ${k.read}; ${k.rated} rated, average ${c.averageRating ?? "n/a"}`,
    ...section("Loved (rating >= 4)", c.loved.map(summaryLine)),
    ...section("Disliked (rating <= 2) — do not recommend similar", c.disliked.map(summaryLine)),
    ...section("Recent reads", c.recentReads.map(summaryLine)),
    ...section("Currently reading", c.currentlyReading.map(summaryLine)),
    ...section("To-read (already queued, avoid re-suggesting)", c.toRead.map(summaryLine)),
    ...section("Top authors", c.topAuthors.map((a) => `${a.author}: ${a.books} book(s), avg ${a.avgRating ?? "n/a"}`)),
    ...section("Top subjects", c.topSubjects.map((s) => `${s.subject}: ${s.books} book(s), avg ${s.avgRating ?? "n/a"}`)),
    ...section("Recent notes on loved books", c.recentNotes.map((n) => `#${n.bookId} ${n.title} [${n.kind}] ${n.body}`)),
  ].join("\n");
}

export function registerRecommendationTool(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "get_recommendation_context",
    {
      title: "Get reading taste context",
      description:
        "Returns raw facts about the user's reading taste: loved and disliked books, recent reads, current and queued books, top authors/subjects, notes on loved books. It does NOT recommend anything: reason over this data yourself (and use search_open_library to find candidates), avoiding books already in the library.",
      inputSchema: GetRecommendationContextInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async (a: GetRecommendationContextArgs) => {
      const context = await deps.repo.getRecommendationContext({ limit: a.limit, recentCount: a.recentCount });
      const structured: RecommendationContextStructured = { kind: "recommendation-context", context };
      return ok(contextText(context), structured);
    }) as never,
  );
}
