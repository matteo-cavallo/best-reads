import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dryRunGoodreadsCsv, importGoodreadsCsv } from "../importers/goodreads.js";
import type { ImportReportStructured, ServerDeps } from "../types.js";
import { ImportGoodreadsCsvInput, type ImportGoodreadsCsvArgs } from "./schemas.js";
import { ok, safe } from "./result.js";

export function registerImportTool(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    "import_goodreads_csv",
    {
      title: "Import Goodreads CSV",
      description:
        "Import a Goodreads library export (the full CSV text) into the library: books, shelves, ratings, read dates, reviews, private notes. Re-importing is idempotent. Use dryRun=true to preview. For very large files prefer the `npm run import:goodreads` CLI.",
      inputSchema: ImportGoodreadsCsvInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a: ImportGoodreadsCsvArgs) => {
      const report = a.dryRun ? dryRunGoodreadsCsv(a.csv) : await importGoodreadsCsv(a.csv, deps.repo);
      const structured: ImportReportStructured = { kind: "import-report", report };
      const lines = [
        `${a.dryRun ? "Dry run: " : "Import done: "}${report.total} rows, ${report.created} created, ${report.merged} merged, ${report.skipped} skipped, ${report.errors.length} errors, ${report.warnings.length} warnings`,
        ...report.errors.slice(0, 10).map((e) => `error row ${e.row}${e.title ? ` (${e.title})` : ""}: ${e.message}`),
        ...report.warnings.slice(0, 10).map((e) => `warning row ${e.row}${e.title ? ` (${e.title})` : ""}: ${e.message}`),
      ];
      const res = ok(lines.join("\n"), structured);
      if (report.total === 0 && report.errors.length) res.isError = true;
      return res;
    }) as never,
  );
}
