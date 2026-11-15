import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { SingleUserOAuthProvider } from "./provider.js";
import { OAuthStore } from "./store.js";

function make(over: Record<string, string> = {}, nowRef = { t: 1_700_000_000_000 }) {
  const config = loadConfig({ NODE_ENV: "test", ...over });
  const store = new OAuthStore(openDatabase(":memory:"), () => Math.floor(nowRef.t / 1000));
  const provider = new SingleUserOAuthProvider({ config, store, now: () => nowRef.t });
  return { provider, store, nowRef };
}

describe("SingleUserOAuthProvider", () => {
  it("accepts the static token and rejects others", async () => {
    const { provider } = make({ STATIC_BEARER_TOKEN: "x".repeat(32) });
    expect((await provider.verifyAccessToken("x".repeat(32))).clientId).toBe("static");
    await expect(provider.verifyAccessToken("y".repeat(32))).rejects.toThrow();
  });

  it("static token disabled when not configured", async () => {
    const { provider } = make();
    await expect(provider.verifyAccessToken("anything")).rejects.toThrow();
  });

  it("stores only hashes and expires tokens", async () => {
    const { provider, store, nowRef } = make({ ACCESS_TOKEN_TTL_S: "60" });
    const client = await provider.clientsStore.registerClient!({ redirect_uris: ["http://localhost/cb"] });
    store.saveCode("code1", {
      clientId: client.client_id, codeChallenge: "c", redirectUri: "http://localhost/cb", resource: null, scopes: ["library"],
      expiresAt: Math.floor(nowRef.t / 1000) + 600,
    });
    const tokens = await provider.exchangeAuthorizationCode(client, "code1");
    expect((await provider.verifyAccessToken(tokens.access_token)).clientId).toBe(client.client_id);
    nowRef.t += 61_000;
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    const raw = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db
      .prepare("SELECT token_hash FROM oauth_tokens").all() as { token_hash: string }[];
    expect(raw.some((r) => r.token_hash === tokens.access_token)).toBe(false);
  });

  it("expired authorization code is rejected", async () => {
    const { provider, store, nowRef } = make();
    const client = await provider.clientsStore.registerClient!({ redirect_uris: ["http://localhost/cb"] });
    store.saveCode("c2", {
      clientId: client.client_id, codeChallenge: "c", redirectUri: "http://localhost/cb", resource: null, scopes: [],
      expiresAt: Math.floor(nowRef.t / 1000) + 10,
    });
    nowRef.t += 11_000;
    await expect(provider.exchangeAuthorizationCode(client, "c2")).rejects.toThrow();
  });

  it("deleteExpired purges old rows", () => {
    const { store, nowRef } = make();
    store.saveCode("c3", { clientId: "a", codeChallenge: "c", redirectUri: "r", resource: null, scopes: [], expiresAt: 1 });
    store.deleteExpired();
    nowRef.t += 1;
    expect(store.peekCode("c3")).toBeUndefined();
  });

  it("rejects unknown redirect URIs and accepts connector/loopback", async () => {
    const { provider } = make();
    await expect(provider.clientsStore.registerClient!({ redirect_uris: ["http://evil.example/cb"] })).rejects.toThrow();
    await expect(provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] })).resolves.toBeTruthy();
  });
});
