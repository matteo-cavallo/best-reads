/** SQLite-backed OAuth store (tables oauth_* from MIGRATIONS[0]). Secrets/tokens are stored as sha256 hex. */
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export interface CodeRow {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource: string | null;
  scopes: string[];
  expiresAt: number;
}
export interface TokenRow {
  kind: "access" | "refresh";
  clientId: string;
  scopes: string[];
  resource: string | null;
  expiresAt: number;
  pairId: string;
}

export class OAuthStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly nowS: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare("SELECT client_json FROM oauth_clients WHERE client_id = ?").get(clientId) as
      | { client_json: string }
      | undefined;
    return row ? (JSON.parse(row.client_json) as OAuthClientInformationFull) : undefined;
  }

  countClients(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get() as { n: number }).n);
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.db
      .prepare("INSERT INTO oauth_clients (client_id, client_json, created_at) VALUES (?, ?, ?)")
      .run(client.client_id, JSON.stringify(client), new Date().toISOString());
  }

  saveCode(code: string, row: CodeRow): void {
    this.db
      .prepare(
        "INSERT INTO oauth_codes (code_hash, client_id, code_challenge, redirect_uri, resource, scopes, expires_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(sha256(code), row.clientId, row.codeChallenge, row.redirectUri, row.resource, JSON.stringify(row.scopes), row.expiresAt);
  }

  /** Reads a non-expired code without consuming it. */
  peekCode(code: string): CodeRow | undefined {
    return this.readCode(code);
  }

  /** Reads and deletes the code (single use). Expired codes are deleted and reported as missing. */
  consumeCode(code: string): CodeRow | undefined {
    const row = this.readCode(code);
    this.db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(sha256(code));
    return row;
  }

  private readCode(code: string): CodeRow | undefined {
    const r = this.db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(sha256(code)) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    const expiresAt = Number(r.expires_at);
    if (expiresAt <= this.nowS()) return undefined;
    return {
      clientId: String(r.client_id),
      codeChallenge: String(r.code_challenge),
      redirectUri: String(r.redirect_uri),
      resource: (r.resource as string | null) ?? null,
      scopes: JSON.parse(String(r.scopes)) as string[],
      expiresAt,
    };
  }

  saveToken(token: string, row: TokenRow): void {
    this.db
      .prepare(
        "INSERT INTO oauth_tokens (token_hash, kind, client_id, scopes, resource, expires_at, pair_id) VALUES (?,?,?,?,?,?,?)",
      )
      .run(sha256(token), row.kind, row.clientId, JSON.stringify(row.scopes), row.resource, row.expiresAt, row.pairId);
  }

  /** Looks up a non-expired token of the given kind. */
  getToken(token: string, kind: "access" | "refresh"): TokenRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = ?")
      .get(sha256(token), kind) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const expiresAt = Number(r.expires_at);
    if (expiresAt <= this.nowS()) return undefined;
    return {
      kind,
      clientId: String(r.client_id),
      scopes: JSON.parse(String(r.scopes)) as string[],
      resource: (r.resource as string | null) ?? null,
      expiresAt,
      pairId: String(r.pair_id),
    };
  }

  deletePair(pairId: string): void {
    this.db.prepare("DELETE FROM oauth_tokens WHERE pair_id = ?").run(pairId);
  }

  deleteExpired(): void {
    const now = this.nowS();
    this.db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at <= ?").run(now);
  }
}
