import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
  ApiKeyAuthenticator,
  CachedEmbedder,
  consoleLogger,
  createApp,
  FireFinderService,
  MemoryRateLimiter,
  PostgresStore,
  type AppEnv,
  type Logger,
} from '@firefinder/core';
import { createRemoteMcpApp, PostgresOAuthStore } from '@firefinder/mcp/remote';
import type { Context, Hono } from 'hono';
import type { ServerConfig } from './config.ts';
import { migrate, openDatabase, type Database } from './db.ts';
import { TransformersEmbedder } from './embedder.ts';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public');

// The developer console is static and talks only to this origin.
const CONSOLE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export interface FireFinderServer {
  app: Hono<AppEnv>;
  db: Database;
  embedder: TransformersEmbedder;
  store: PostgresStore;
  service: FireFinderService;
  close(): Promise<void>;
}

export async function createServer(config: ServerConfig, logger: Logger = consoleLogger): Promise<FireFinderServer> {
  const db = await openDatabase(config.databaseUrl, { poolMax: config.dbPoolMax, prepare: config.dbPrepare });
  if (config.autoMigrate) await migrate(db, (message) => logger.info(message));

  const store = new PostgresStore(db.sql);
  const embedder = new TransformersEmbedder({ dtype: config.embeddingDtype, cacheDir: config.embeddingCacheDir });
  const service = new FireFinderService({
    store,
    embedder: new CachedEmbedder(embedder),
    config: { voterSecret: config.voterSecret },
  });

  const rateLimiter = new MemoryRateLimiter();
  const app = createApp({
    service,
    authenticator: new ApiKeyAuthenticator(store),
    rateLimiter,
    rateLimits: {
      read: { limit: config.rateLimits.readPerMinute, windowSeconds: 60 },
      write: { limit: config.rateLimits.writePerMinute, windowSeconds: 60 },
    },
    corsOrigins: config.corsOrigins,
    clientIp: (c) => clientIp(c, config.trustProxy),
    logger,
  });

  // Remote MCP endpoint (claude.ai, Claude mobile): <publicUrl>/mcp with OAuth 2.1.
  app.route(
    '/',
    createRemoteMcpApp({
      service,
      oauthStore: new PostgresOAuthStore(db.sql),
      rateLimiter,
      publicUrl: config.publicUrl,
      secret: config.oauthSecret,
      clientIp: (c) => clientIp(c, config.trustProxy),
      logger,
      config: config.mcp,
    }),
  );

  if (config.devConsole) mountDeveloperConsole(app);

  return { app, db, embedder, store, service, close: () => db.close() };
}

function clientIp(c: Context, trustProxy: boolean): string | null {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null; // not running behind a Node socket (e.g. app.request in tests)
  }
}

function mountDeveloperConsole(app: Hono<AppEnv>): void {
  const assets: Array<[route: string, file: string, type: string]> = [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/console.js', 'console.js', 'text/javascript; charset=utf-8'],
    ['/console.css', 'console.css', 'text/css; charset=utf-8'],
  ];
  for (const [route, file, type] of assets) {
    const body = readFileSync(join(PUBLIC_DIR, file), 'utf8');
    app.get(route, (c) =>
      c.body(body, 200, { 'content-type': type, 'content-security-policy': CONSOLE_CSP, 'cache-control': 'no-cache' }),
    );
  }
}

/** Starts listening; resolves once the port is bound. Port 0 picks a free port. */
export function listen(server: FireFinderServer, port: number, host: string): Promise<{ url: string; stop(): Promise<void> }> {
  return new Promise((resolveListen) => {
    const http = serve({ fetch: server.app.fetch, port, hostname: host }, (info: AddressInfo) => {
      const displayHost = info.family === 'IPv6' ? `[${info.address}]` : info.address;
      resolveListen({
        url: `http://${displayHost}:${info.port}`,
        stop: () => new Promise((done) => http.close(() => done())),
      });
    });
  });
}
