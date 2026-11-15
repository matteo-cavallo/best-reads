/**
 * Runtime configuration. Owner: architect (contract). Consumers: D (index/http/auth), A (dbPath), B (openlibrary).
 * `loadConfig` is pure: pass an env object (tests pass their own).
 */
import { z } from "zod";

const intFromEnv = (def: number) =>
  z.preprocess((v) => (v === undefined || v === "" ? def : Number(v)), z.number().int().positive());

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: intFromEnv(3000),
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  DB_PATH: z.string().default("./data/best-reads.db"),
  OWNER_PASSWORD: z.string().optional(),
  STATIC_BEARER_TOKEN: z.string().optional(),
  OPENLIBRARY_BASE_URL: z.string().url().default("https://openlibrary.org"),
  OPENLIBRARY_COVERS_URL: z.string().url().default("https://covers.openlibrary.org"),
  OPENLIBRARY_CONTACT: z.string().optional(),
  OPENLIBRARY_TIMEOUT_MS: intFromEnv(8000),
  ACCESS_TOKEN_TTL_S: intFromEnv(3600),
  REFRESH_TOKEN_TTL_S: intFromEnv(2_592_000),
});

export interface Config {
  env: "development" | "test" | "production";
  port: number;
  /** Public base URL without trailing slash. Used as OAuth issuer and for resource metadata. */
  publicUrl: string;
  /** Path of the MCP endpoint, always "/mcp". */
  mcpPath: "/mcp";
  dbPath: string;
  auth: {
    /** Password the owner types on the OAuth consent page. undefined => OAuth consent disabled. */
    ownerPassword: string | undefined;
    /** Static bearer token accepted in addition to OAuth tokens. undefined => disabled. */
    staticBearerToken: string | undefined;
    accessTokenTtlS: number;
    refreshTokenTtlS: number;
  };
  openLibrary: {
    baseUrl: string;
    coversUrl: string;
    userAgent: string;
    timeoutMs: number;
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = EnvSchema.parse(env);
  const staticToken = e.STATIC_BEARER_TOKEN?.trim() || undefined;
  const ownerPassword = e.OWNER_PASSWORD?.trim() || undefined;
  if (staticToken !== undefined && staticToken.length < 24) {
    throw new Error("STATIC_BEARER_TOKEN must be at least 24 characters");
  }
  if (e.NODE_ENV === "production") {
    if (!ownerPassword && !staticToken) {
      throw new Error("Production requires OWNER_PASSWORD and/or STATIC_BEARER_TOKEN");
    }
    if (!e.PUBLIC_URL.startsWith("https://")) {
      throw new Error("Production requires an https PUBLIC_URL");
    }
  }
  const contact = e.OPENLIBRARY_CONTACT?.trim();
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ""),
    mcpPath: "/mcp",
    dbPath: e.DB_PATH,
    auth: {
      ownerPassword,
      staticBearerToken: staticToken,
      accessTokenTtlS: e.ACCESS_TOKEN_TTL_S,
      refreshTokenTtlS: e.REFRESH_TOKEN_TTL_S,
    },
    openLibrary: {
      baseUrl: e.OPENLIBRARY_BASE_URL.replace(/\/+$/, ""),
      coversUrl: e.OPENLIBRARY_COVERS_URL.replace(/\/+$/, ""),
      userAgent: contact ? `BestReads/0.1 (${contact})` : "BestReads/0.1 (personal reading tracker)",
      timeoutMs: e.OPENLIBRARY_TIMEOUT_MS,
    },
  };
}
