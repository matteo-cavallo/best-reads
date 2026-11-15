/** Express app: OAuth 2.1 (SDK router) + stateless Streamable HTTP MCP endpoint + health. */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import type { ServerDeps } from "./types.js";
import { SingleUserOAuthProvider, SCOPES } from "./auth/provider.js";
import { OAuthStore } from "./auth/store.js";

export interface AppOptions {
  config: Config;
  /** Database holding the oauth_* tables. */
  db: DatabaseSync;
  /** Dependencies for the real MCP server (ignored when createServer is given). */
  deps?: ServerDeps;
  /** Factory called once per POST /mcp (stateless). Tests may inject a stub. */
  createServer?: () => McpServer;
}

export interface AppHandle {
  app: Express;
  provider: SingleUserOAuthProvider;
  /** Stops the housekeeping timer. */
  close(): void;
}

const MCP_HEADERS = "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID";

export function createAppHandle(opts: AppOptions): AppHandle {
  const { config } = opts;
  const makeServer = async (): Promise<McpServer> => {
    if (opts.createServer) return opts.createServer();
    if (!opts.deps) throw new Error("createApp needs deps or createServer");
    const { createMcpServer } = await import("./server.js");
    return createMcpServer(opts.deps);
  };
  const store = new OAuthStore(opts.db);
  const provider = new SingleUserOAuthProvider({ config, store });
  store.deleteExpired();
  const timer = setInterval(() => store.deleteExpired(), 3_600_000);
  timer.unref();

  const app = express();
  app.disable("x-powered-by");
  if (config.env === "production") app.set("trust proxy", 1);

  const issuerUrl = new URL(config.publicUrl);
  const resourceServerUrl = new URL(config.publicUrl + config.mcpPath);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Consent form submission (before the SDK router so /authorize/* is not swallowed).
  app.post("/authorize/consent", express.urlencoded({ extended: false, limit: "10kb" }), provider.consentHandler);

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl,
      scopesSupported: SCOPES,
      resourceName: "Best Reads",
    }),
  );

  // CORS for /mcp (browser-based clients). Origin is echoed; auth is by bearer token, not cookies.
  app.use(config.mcpPath, (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin) {
      res.set({
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
        "Access-Control-Allow-Headers": MCP_HEADERS,
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
      });
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  const auth = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

  app.post(config.mcpPath, auth, express.json({ limit: "4mb" }), async (req: Request, res: Response) => {
    let server: McpServer | undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      server = await makeServer();
      res.on("close", () => {
        void transport.close();
        void server?.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err instanceof Error ? err.message : String(err));
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const notAllowed = (_req: Request, res: Response) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)." }, id: null });
  };
  app.get(config.mcpPath, auth, notAllowed);
  app.delete(config.mcpPath, auth, notAllowed);

  // Malformed JSON etc.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({
      jsonrpc: "2.0",
      error: { code: status === 400 ? -32700 : -32603, message: status === 400 ? "Bad request" : "Internal server error" },
      id: null,
    });
  });

  return { app, provider, close: () => clearInterval(timer) };
}

export function createApp(opts: AppOptions): Express {
  return createAppHandle(opts).app;
}
