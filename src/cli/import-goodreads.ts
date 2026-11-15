/** Usage: npm run import:goodreads -- export.csv [--db path] [--dry-run] */
import { readFileSync } from "node:fs";
import { openDatabase } from "../db/connection.js";
import { createSqliteRepository } from "../db/sqlite.js";
import { dryRunGoodreadsCsv, importGoodreadsCsv } from "../importers/goodreads.js";
import { loadConfig } from "../config.js";

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  let file: string | undefined;
  let dbPath: string | undefined;
  let dry = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") dry = true;
    else if (a === "--db") dbPath = args[++i];
    else if (!a.startsWith("--")) file = a;
  }
  if (!file) {
    console.error("Usage: import-goodreads <export.csv> [--db path] [--dry-run]");
    return 2;
  }
  const text = readFileSync(file, "utf8");
  let report;
  if (dry) {
    report = dryRunGoodreadsCsv(text);
  } else {
    const db = openDatabase(dbPath ?? loadConfig().dbPath);
    const repo = createSqliteRepository(db);
    try {
      report = await importGoodreadsCsv(text, repo);
    } finally {
      await repo.close();
    }
  }
  console.log(
    `${dry ? "[dry-run] " : ""}total=${report.total} created=${report.created} merged=${report.merged} skipped=${report.skipped} errors=${report.errors.length} warnings=${report.warnings.length}`,
  );
  for (const e of report.errors) console.error(`error  row ${e.row}${e.title ? ` (${e.title})` : ""}: ${e.message}`);
  for (const w of report.warnings) console.warn(`warn   row ${w.row}${w.title ? ` (${w.title})` : ""}: ${w.message}`);
  return report.errors.length > 0 && report.created + report.merged === 0 && !dry ? 1 : 0;
}

main(process.argv).then((c) => process.exit(c), (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
