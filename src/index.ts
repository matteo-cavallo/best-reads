/** Entry point: config -> db -> repo + Open Library client -> HTTP server. */
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { createSqliteRepository } from "./db/sqlite.js";
import { createOpenLibraryClient } from "./openlibrary/openLibraryClient.js";
import { createApp } from "./http.js";

const config = loadConfig();
const db = openDatabase(config.dbPath);
const repo = createSqliteRepository(db);
const metadata = createOpenLibraryClient({
  baseUrl: config.openLibrary.baseUrl,
  coversUrl: config.openLibrary.coversUrl,
  userAgent: config.openLibrary.userAgent,
  timeoutMs: config.openLibrary.timeoutMs,
});
const app = createApp({ config, db, deps: { repo, metadata } });

const server = app.listen(config.port, () => {
  console.log(`Best Reads MCP server listening on :${config.port} (MCP endpoint ${config.publicUrl}${config.mcpPath})`);
  if (!config.auth.ownerPassword) console.warn("OWNER_PASSWORD not set: OAuth consent disabled (static token only).");
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
