/** Single-user OAuth 2.1 provider for the SDK auth router. Login = owner password on the consent page. */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  TooManyRequestsError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Config } from "../config.js";
import { renderConsentPage } from "./consent.js";
import { OAuthStore, randomToken, sha256 } from "./store.js";

export const SCOPES = ["library"];
const MAX_CLIENTS = 200;
const MAX_REGISTRATIONS_PER_HOUR = 30;

/** Known connector callbacks plus loopback (native/CLI clients). */
export function isAllowedRedirectUri(uri: string, extra: readonly string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (extra.includes(uri)) return true;
  if (u.protocol === "https:" && ["claude.ai", "claude.com"].includes(u.hostname) && u.pathname === "/api/mcp/auth_callback") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}
const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_S = 600;
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

interface Pending {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expires: number;
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));
}

export interface ProviderOptions {
  config: Config;
  store: OAuthStore;
  now?: () => number; // epoch ms
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, Pending>();
  private readonly attempts = new Map<string, number[]>();
  private registrations: number[] = [];
  private readonly config: Config;
  private readonly store: OAuthStore;
  private readonly nowMs: () => number;
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(opts: ProviderOptions) {
    this.config = opts.config;
    this.store = opts.store;
    this.nowMs = opts.now ?? Date.now;
    const store = this.store;
    this.clientsStore = {
      getClient: (id) => store.getClient(id),
      registerClient: async (c) => {
        const extra = (process.env.ALLOWED_REDIRECT_URIS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        for (const uri of c.redirect_uris ?? []) {
          if (!isAllowedRedirectUri(String(uri), extra)) {
            throw new InvalidClientMetadataError(`redirect_uri not allowed: ${String(uri)}`);
          }
        }
        const nowMs = this.nowMs();
        this.registrations = this.registrations.filter((t) => nowMs - t < 3_600_000);
        if (this.registrations.length >= MAX_REGISTRATIONS_PER_HOUR || store.countClients() >= MAX_CLIENTS) {
          throw new TooManyRequestsError("Too many client registrations");
        }
        this.registrations.push(nowMs);
        const client_id = randomBytes(24).toString("hex");
        const full: OAuthClientInformationFull = {
          ...c,
          client_id,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        store.saveClient(full);
        return full;
      },
    };
  }

  private nowS(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  // ---- authorize ---------------------------------------------------------------------------------------------

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.gcPending();
    const pendingId = randomToken(24);
    this.pending.set(pendingId, { client, params, expires: this.nowMs() + PENDING_TTL_MS });
    this.sendConsent(res, pendingId, client, params, this.config.auth.ownerPassword ? undefined : 503);
  }

  private sendConsent(
    res: Response,
    pendingId: string,
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    status?: number,
    error?: string,
  ): void {
    let host = params.redirectUri;
    try {
      host = new URL(params.redirectUri).host;
    } catch {
      /* keep raw */
    }
    const disabled = !this.config.auth.ownerPassword;
    res
      .status(status ?? (error ? 401 : 200))
      .set({
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http:; frame-ancestors 'none'",
      })
      .send(
        renderConsentPage({
          pendingId,
          clientName: client.client_name ?? client.client_id,
          redirectHost: host,
          scopes: params.scopes ?? SCOPES,
          disabled,
          error: disabled ? "Owner login is not configured on this server (set OWNER_PASSWORD)." : error,
        }),
      );
  }

  /** Express handler for POST /authorize/consent (body must be urlencoded-parsed). */
  consentHandler = (req: Request, res: Response): void => {
    res.set("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pendingId = typeof body.pending === "string" ? body.pending : "";
    const password = typeof body.password === "string" ? body.password : "";
    const p = this.pending.get(pendingId);
    if (!p || p.expires <= this.nowMs()) {
      this.pending.delete(pendingId);
      res.status(400).type("html").send("<p>Authorization request expired. Please start again from Claude.</p>");
      return;
    }
    const ownerPassword = this.config.auth.ownerPassword;
    if (!ownerPassword) {
      this.sendConsent(res, pendingId, p.client, p.params, 503);
      return;
    }
    const ip = req.ip ?? "unknown";
    if (this.isBlocked(ip)) {
      res.status(429).type("html").send("<p>Too many attempts. Wait a minute and try again.</p>");
      return;
    }
    if (!safeEqual(password, ownerPassword)) {
      this.recordFailure(ip);
      this.sendConsent(res, pendingId, p.client, p.params, 401, "Wrong password.");
      return;
    }
    this.pending.delete(pendingId);
    const code = randomToken(32);
    this.store.saveCode(code, {
      clientId: p.client.client_id,
      codeChallenge: p.params.codeChallenge,
      redirectUri: p.params.redirectUri,
      resource: p.params.resource?.href ?? null,
      scopes: p.params.scopes?.length ? p.params.scopes : SCOPES,
      expiresAt: this.nowS() + CODE_TTL_S,
    });
    const target = new URL(p.params.redirectUri);
    target.searchParams.set("code", code);
    if (p.params.state !== undefined) target.searchParams.set("state", p.params.state);
    res.redirect(302, target.toString());
  };

  /** Only failed password attempts count: more than MAX_ATTEMPTS per window blocks the IP. */
  private isBlocked(ip: string): boolean {
    const now = this.nowMs();
    const recent = (this.attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    this.attempts.set(ip, recent);
    return recent.length >= MAX_ATTEMPTS;
  }

  private recordFailure(ip: string): void {
    this.attempts.set(ip, [...(this.attempts.get(ip) ?? []), this.nowMs()]);
  }

  private gcPending(): void {
    const now = this.nowMs();
    for (const [k, v] of this.pending) if (v.expires <= now) this.pending.delete(k);
  }

  // ---- token endpoint ----------------------------------------------------------------------------------------

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const row = this.store.peekCode(code);
    if (!row || row.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    return row.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.store.consumeCode(code);
    if (!row || row.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri !== undefined && redirectUri !== row.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    if (resource && row.resource && resource.href !== row.resource) throw new InvalidTargetError("resource mismatch");
    return this.issue(client.client_id, row.scopes, row.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.store.getToken(refreshToken, "refresh");
    if (!row || row.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    if (resource && row.resource && resource.href !== row.resource) throw new InvalidTargetError("resource mismatch");
    if (scopes && scopes.some((s) => !row.scopes.includes(s))) throw new InvalidGrantError("Scope not granted");
    this.store.deletePair(row.pairId); // rotation: old pair is gone
    return this.issue(client.client_id, scopes?.length ? scopes : row.scopes, row.resource);
  }

  private issue(clientId: string, scopes: string[], resource: string | null): OAuthTokens {
    const access = randomToken(32);
    const refresh = randomToken(32);
    const pairId = randomUUID();
    const now = this.nowS();
    const { accessTokenTtlS, refreshTokenTtlS } = this.config.auth;
    this.store.saveToken(access, { kind: "access", clientId, scopes, resource, expiresAt: now + accessTokenTtlS, pairId });
    this.store.saveToken(refresh, { kind: "refresh", clientId, scopes, resource, expiresAt: now + refreshTokenTtlS, pairId });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: accessTokenTtlS,
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    for (const kind of ["access", "refresh"] as const) {
      const row = this.store.getToken(request.token, kind);
      if (row && row.clientId === client.client_id) this.store.deletePair(row.pairId);
    }
  }

  // ---- resource server ---------------------------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const staticToken = this.config.auth.staticBearerToken;
    if (staticToken && safeEqual(token, staticToken)) {
      return { token, clientId: "static", scopes: SCOPES, expiresAt: this.nowS() + 3600 };
    }
    const row = this.store.getToken(token, "access");
    if (!row) throw new InvalidTokenError("Invalid or expired token");
    return {
      token,
      clientId: row.clientId,
      scopes: row.scopes,
      expiresAt: row.expiresAt,
      ...(row.resource ? { resource: new URL(row.resource) } : {}),
    };
  }
}
