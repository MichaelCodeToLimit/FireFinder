import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { consoleLogger, generateApiKey, hashApiKey } from '@firefinder/core';
import { createServer, listen, type FireFinderServer } from './app.ts';
import { loadConfig, type ServerConfig } from './config.ts';

const logger = consoleLogger;
const config = loadConfig();
const server = await createServer(config, logger);
await ensureLocalDevKey(server, config);

// Load the embedding model now so the first search is fast.
server.embedder
  .warmup()
  .then(() => logger.info('embedding model ready', { model: server.embedder.model }))
  .catch((error) => logger.error('embedding model failed to load', { error: String(error) }));

const { url, stop } = await listen(server, config.port, config.host);
logger.info('🔥 FireFinder API listening', {
  url,
  database: server.db.kind,
  console: config.devConsole ? `${url}/` : 'disabled',
});

/**
 * Zero-setup local development: the first time a local PGlite database starts
 * without any API keys, create one and save it to .data/dev-api-key.
 */
async function ensureLocalDevKey(server: FireFinderServer, config: ServerConfig): Promise<void> {
  if (server.db.kind !== 'pglite') return;
  const [row] = await server.db.sql.query<{ n: number }>('select count(*)::int as n from firefinder.api_keys');
  if (Number(row?.n) > 0) return;

  const { key, prefix } = generateApiKey();
  await server.store.createApiKey({ name: 'local-dev', keyPrefix: prefix, keyHash: await hashApiKey(key), scopes: ['read', 'write', 'admin'] });
  const location = config.databaseUrl.slice('pglite://'.length);
  if (location && location !== 'memory') {
    const file = resolve(dirname(resolve(location)), 'dev-api-key');
    writeFileSync(file, `${key}\n`, { mode: 0o600 });
    logger.info('created local development API key', { key, saved_to: file });
  } else {
    logger.info('created local development API key', { key });
  }
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { signal });
    await stop();
    await server.close();
    process.exit(0);
  });
}
