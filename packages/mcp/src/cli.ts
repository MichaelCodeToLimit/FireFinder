#!/usr/bin/env node
/**
 * FireFinder MCP server over stdio, for Claude Desktop and Claude Code.
 *
 *   FIREFINDER_API_URL   FireFinder API base URL (default http://localhost:8787)
 *   FIREFINDER_API_KEY   API key with read+write scopes (required)
 *   FIREFINDER_CLIENT_ID optional; defaults to a random id in ~/.firefinder/client-id
 *   FIREFINDER_API_REGION optional; Supabase region to run the API in (the database's region)
 *
 * stdout carries the MCP protocol; diagnostics go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FireFinderClient } from '@firefinder/client';
import { loadOrCreateClientId } from './client-id.ts';
import { createFireFinderMcpServer, MCP_SERVER_VERSION } from './server.ts';

const apiKey = process.env.FIREFINDER_API_KEY;
if (!apiKey) {
  console.error('[firefinder-mcp] FIREFINDER_API_KEY is not set. Create one with `npm run keys:create` and add it to your MCP config.');
  process.exit(1);
}

const baseUrl = process.env.FIREFINDER_API_URL ?? 'http://localhost:8787';
const client = new FireFinderClient({
  baseUrl,
  apiKey,
  clientId: process.env.FIREFINDER_CLIENT_ID ?? loadOrCreateClientId(),
  region: process.env.FIREFINDER_API_REGION || undefined,
  userAgent: `firefinder-mcp/${MCP_SERVER_VERSION}`,
});

const server = createFireFinderMcpServer(client);
await server.connect(new StdioServerTransport());
console.error(`[firefinder-mcp] ready; API ${baseUrl}`);
