import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./migrate.js";

/** Opens (creating if needed) a SQLite database, sets pragmas and runs migrations. Use ":memory:" for tests. */
export function openDatabase(path: string): DatabaseSync {
  const inMemory = path === ":memory:" || path === "";
  if (!inMemory && !path.startsWith("file:")) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(inMemory ? ":memory:" : path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (!inMemory) db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}
