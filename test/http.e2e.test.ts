import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/connection.js";
import { createAppHandle, type AppHandle } from "../src/http.js";

const OWNER = "correct horse battery";
const STATIC = "static-token-for-tests-0123456789";
const REDIRECT = "http://127.0.0.1:9999/callback";

const b64url = (b: Buffer) => b.toString("base64url");
const pkce = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
};

function stubServer(): McpServer {
  const s = new McpServer({ name: "stub", version: "0.0.0" });
  s.registerTool("ping", { description: "ping", inputSchema: z.object({ msg: z.string() }) }, async ({ msg }) => ({
    content: [{ type: "text", text: `pong ${msg}` }],
  }));
  return s;
}

let server: Server;
let handle: AppHandle;
let base: string;
let config: ReturnType<typeof loadConfig>;

beforeAll(async () => {
  // Port is unknown until listen; PUBLIC_URL only affects metadata so we patch it after listening.
  config = loadConfig({ NODE_ENV: "test", OWNER_PASSWORD: OWNER, STATIC_BEARER_TOKEN: STATIC, ACCESS_TOKEN_TTL_S: "3600" });
  const db = openDatabase(":memory:");
  handle = createAppHandle({ config, db, createServer: stubServer });
  await new Promise<void>((resolve) => {
    server = handle.app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.publicUrl = base; // issuer/resource derived at createApp time use localhost:3000; tests call by actual URL
});
afterAll(async () => {
  handle.close();
  await new Promise<void>((r) => server.close(() => r()));
});

const rpc = (token: string | null, body: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

async function register(): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test <b>Client</b>",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  const j = (await res.json()) as { client_id: string };
  expect(j.client_id).toMatch(/^[0-9a-f]{48}$/);
  return j.client_id;
}

async function startAuthorize(clientId: string, challenge: string, state = "st4te") {
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "library",
    resource: `${base}/mcp`,
  }).toString();
  const res = await fetch(url, { redirect: "manual" });
  const html = await res.text();
  const pending = /name="pending" value="([^"]+)"/.exec(html)?.[1];
  return { res, html, pending };
}

const consent = (pending: string, password: string) =>
  fetch(`${base}/authorize/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending, password }).toString(),
  });

async function fullFlow() {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const { pending } = await startAuthorize(clientId, challenge);
  const res = await consent(pending!, OWNER);
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe(REDIRECT);
  expect(loc.searchParams.get("state")).toBe("st4te");
  const code = loc.searchParams.get("code")!;
  return { clientId, verifier, code };
}

const tokenReq = (params: Record<string, string>) =>
  fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });

describe("basics", () => {
  it("healthz is public", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("serves OAuth metadata documents", async () => {
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.registration_endpoint).toBeTruthy();
    expect(as.token_endpoint).toBeTruthy();
    const pr = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(String(pr.resource)).toMatch(/\/mcp$/);
    expect(pr.authorization_servers).toBeTruthy();
  });

  it("/mcp without token -> 401 with resource_metadata", async () => {
    const r = await rpc(null, INIT);
    expect(r.status).toBe(401);
    const h = r.headers.get("www-authenticate") ?? "";
    expect(h).toMatch(/^Bearer /);
    expect(h).toContain("resource_metadata=");
    expect(h).toContain("/.well-known/oauth-protected-resource/mcp");
  });

  it("/mcp with garbage token -> 401", async () => {
    expect((await rpc("nope", INIT)).status).toBe(401);
  });

  it("GET and DELETE /mcp -> 405 when authenticated", async () => {
    for (const method of ["GET", "DELETE"]) {
      const r = await fetch(`${base}/mcp`, { method, headers: { authorization: `Bearer ${STATIC}` } });
      expect(r.status).toBe(405);
    }
  });

  it("CORS preflight on /mcp is answered without auth", async () => {
    const r = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { origin: "https://claude.ai" } });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-headers")).toContain("Mcp-Protocol-Version");
  });
});

describe("static bearer", () => {
  it("works end to end with the SDK client", async () => {
    const client = new Client({ name: "t", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${STATIC}` } },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("ping");
    const out = await client.callTool({ name: "ping", arguments: { msg: "x" } });
    expect(JSON.stringify(out)).toContain("pong x");
    await client.close();
  });

  it("malformed JSON -> 4xx, not a crash", async () => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${STATIC}`, accept: "application/json, text/event-stream" },
      body: "{bad",
    });
    expect(r.status).toBe(400);
  });
});

describe("OAuth 2.1 + PKCE flow", () => {
  it("consent page escapes client name and shows form", async () => {
    const clientId = await register();
    const { res, html, pending } = await startAuthorize(clientId, pkce().challenge);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html).not.toContain("<b>Client</b>");
    expect(html).toContain("&lt;b&gt;Client&lt;/b&gt;");
    expect(pending).toBeTruthy();
  });

  it("wrong password re-renders without redirect; right password issues usable tokens", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const { pending } = await startAuthorize(clientId, challenge);
    const bad = await consent(pending!, "wrong");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("location")).toBeNull();
    expect(await bad.text()).toContain("Wrong password");

    const ok = await consent(pending!, OWNER);
    expect(ok.status).toBe(302);
    const code = new URL(ok.headers.get("location")!).searchParams.get("code")!;

    const tok = await tokenReq({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      resource: `${base}/mcp`,
    });
    expect(tok.status).toBe(200);
    expect(tok.headers.get("cache-control")).toBe("no-store");
    const t = (await tok.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
    expect(t.token_type.toLowerCase()).toBe("bearer");
    expect(t.expires_in).toBe(3600);

    const init = await rpc(t.access_token, INIT);
    expect(init.status).toBe(200);
    const list = await rpc(t.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-protocol-version": "2025-06-18" });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain("ping");
    const call = await rpc(t.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping", arguments: { msg: "oauth" } } });
    expect(await call.text()).toContain("pong oauth");
  });

  it("rejects wrong PKCE verifier", async () => {
    const { clientId, code } = await fullFlow();
    const r = await tokenReq({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: b64url(randomBytes(32)),
      redirect_uri: REDIRECT,
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("authorization code is single use", async () => {
    const { clientId, verifier, code } = await fullFlow();
    const p = { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT };
    expect((await tokenReq(p)).status).toBe(200);
    const again = await tokenReq(p);
    expect(again.status).toBe(400);
  });

  it("rejects redirect_uri mismatch at the token endpoint", async () => {
    const { clientId, verifier, code } = await fullFlow();
    const r = await tokenReq({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: "http://127.0.0.1:9999/other",
    });
    expect(r.status).toBe(400);
  });

  it("refresh rotates tokens and invalidates the old pair", async () => {
    const { clientId, verifier, code } = await fullFlow();
    const first = (await (
      await tokenReq({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT })
    ).json()) as { access_token: string; refresh_token: string };

    const r2 = await tokenReq({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token });
    expect(r2.status).toBe(200);
    const second = (await r2.json()) as { access_token: string; refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);

    expect((await rpc(second.access_token, INIT)).status).toBe(200);
    expect((await rpc(first.access_token, INIT)).status).toBe(401);
    expect((await tokenReq({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token })).status).toBe(400);
  });

  it("revoked token is rejected", async () => {
    const { clientId, verifier, code } = await fullFlow();
    const t = (await (
      await tokenReq({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT })
    ).json()) as { access_token: string };
    expect((await rpc(t.access_token, INIT)).status).toBe(200);
    const rev = await fetch(`${base}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, token: t.access_token }).toString(),
    });
    expect(rev.status).toBe(200);
    expect((await rpc(t.access_token, INIT)).status).toBe(401);
  });

  it("unknown / expired pending request is rejected", async () => {
    const r = await consent("does-not-exist", OWNER);
    expect(r.status).toBe(400);
  });

  it("authorize with unregistered redirect_uri is refused (no consent page)", async () => {
    const clientId = await register();
    const url = `${base}/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://evil.example/cb",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    })}`;
    const r = await fetch(url, { redirect: "manual" });
    expect(r.status).toBe(400);
  });

  it("rate limits repeated wrong passwords", async () => {
    const clientId = await register();
    const { pending } = await startAuthorize(clientId, pkce().challenge);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await consent(pending!, "bad" + i)).status);
    expect(statuses).toContain(429);
    // even the right password is blocked while limited
    expect((await consent(pending!, OWNER)).status).toBe(429);
  });
});
