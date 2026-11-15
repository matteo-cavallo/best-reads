import type { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./schema.js";

/** Applies pending migrations (PRAGMA user_version based). Idempotent. Returns the resulting version. */
export function migrate(db: DatabaseSync, migrations: readonly string[] = MIGRATIONS): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row.user_version;
  for (let i = version; i < migrations.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(migrations[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    version = i + 1;
  }
  return version;
}
