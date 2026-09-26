/**
 * The FireFinder loop from the README, played through the real Claude
 * integration: the bundled MCP server is started over stdio exactly as Claude
 * Desktop / Claude Code start it, and two "users" call its tools.
 *
 *   npm run dev      (in another terminal)
 *   npm run demo
 */
import { existsSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const apiUrl = process.env.FIREFINDER_API_URL || 'http://localhost:8787';
const apiKey =
  process.env.FIREFINDER_API_KEY || (existsSync('.data/dev-api-key') ? readFileSync('.data/dev-api-key', 'utf8').trim() : '');
if (!apiKey) {
  console.error('Set FIREFINDER_API_KEY, or start the local server once (npm run dev) to create .data/dev-api-key.');
  process.exit(1);
}
if (!existsSync('packages/mcp/dist/firefinder-mcp.js')) {
  console.error('Build the MCP server first: npm run build:mcp');
  process.exit(1);
}

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const indent = (text: string) => text.split('\n').map((line) => `     ${dim(line)}`).join('\n');

async function claudeFor(installId: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['packages/mcp/dist/firefinder-mcp.js'],
    // FIREFINDER_API_REGION (if set) is passed through from the environment.
    env: { ...(process.env as Record<string, string>), FIREFINDER_API_URL: apiUrl, FIREFINDER_API_KEY: apiKey, FIREFINDER_CLIENT_ID: installId },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'firefinder-demo', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function tool(claude: Client, name: string, args: Record<string, unknown>): Promise<string> {
  console.log(`  🤖 Claude → ${name}(${JSON.stringify(args).slice(0, 110)}${JSON.stringify(args).length > 110 ? '…' : ''})`);
  const result = await claude.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>).map((c) => c.text).join('\n');
  console.log(indent(text));
  if (result.isError) throw new Error(`${name} failed`);
  return text;
}

const run = Date.now().toString(36);
const userA = await claudeFor(`demo-user-a-${run}`);
const userB = await claudeFor(`demo-user-b-${run}`);

try {
  console.log('\n━━━ User A ━━━');
  console.log('  👤 "My application keeps crashing with error ERR_DLOPEN_FAILED since I updated Node."');
  const firstSearch = await tool(userA, 'search_firefinder', {
    problem: 'Application keeps crashing with error ERR_DLOPEN_FAILED after updating Node.js',
    software: 'Node.js',
    error_message: 'ERR_DLOPEN_FAILED',
  });

  let id: string;
  if (firstSearch.includes('No verified FireFinder solution')) {
    console.log('  🤖 Claude: "Native modules were built for the old Node version. Run `npm rebuild`, then start the app."');
    console.log('  👤 "That fixed it!"');
    const saved = await tool(userA, 'submit_solution', {
      problem: 'Application crashes on startup with ERR_DLOPEN_FAILED after upgrading Node.js',
      solution: 'Native modules were compiled for the previous Node version. Run `npm rebuild` (or `npx electron-rebuild` for Electron apps), then start the app again.',
      software: 'Node.js',
      operating_system: 'Windows 11',
      error_message: 'ERR_DLOPEN_FAILED',
      user_evidence: 'That fixed it!',
    });
    id = saved.match(/id: ([0-9a-f-]{36})/)![1]!;
  } else {
    console.log(dim('  (already solved in an earlier demo run; User A is covered too)'));
    id = firstSearch.match(/id: ([0-9a-f-]{36})/)![1]!;
  }

  console.log('\n━━━ User B, later ━━━');
  console.log('  👤 "I\'m getting ERR_DLOPEN_FAILED and my app keeps crashing."');
  const secondSearch = await tool(userB, 'search_firefinder', {
    problem: "I'm getting ERR_DLOPEN_FAILED and my app keeps crashing",
    operating_system: 'Windows 11',
  });
  if (!secondSearch.includes(id)) throw new Error("User B did not get User A's solution");
  console.log('  🤖 Claude: "🔥 Previously solved: run `npm rebuild` so native modules match your Node version."');
  console.log('  👤 "It worked, thanks!"');
  await tool(userB, 'confirm_solution', { id, operating_system: 'Windows 11', user_evidence: 'It worked, thanks!' });

  console.log('\n🔥 Solved once, remembered, and verified again by the next person.\n');
} finally {
  await userA.close();
  await userB.close();
}
