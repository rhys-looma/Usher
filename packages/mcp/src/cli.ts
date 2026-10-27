// @usher-run/mcp: Usher's MCP server for agents, over stdio. One file on npm, no dependencies.
//
//   npx @usher-run/mcp             serve over stdio (what an MCP client runs)
//   npx @usher-run/mcp --check     knock on the demo site and print what came back
//   npx @usher-run/mcp --version
//
// USHER_REGISTRY_URL (default: the public registry) and USHER_AGENT_KEY_FILE (default
// ~/.usher/agent-key.json, created on first run, readable only by you). The key is the agent's
// identity: keep it, and every knock is signed with it.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RegistryClient } from '../../registry/src/client.ts';
import { DEFAULT_KEY_FILE, loadOrCreateIdentity } from '../../registry/src/identity-file.ts';
import { createMcpServer } from '../../registry/src/mcp.ts';
import { capFallback, registerFillTools } from './fill.ts';

// Filled in at build time from package.json (version, usher.defaultRegistry, usher.demoForm).
declare const USHER_MCP_VERSION: string;
declare const USHER_DEFAULT_REGISTRY: string;
declare const USHER_DEMO_FORM: string;

const HELP = `Usher MCP server ${USHER_MCP_VERSION}

  npx @usher-run/mcp            serve over stdio, for an MCP client
  npx @usher-run/mcp --check    knock on the demo site and print the result
  npx @usher-run/mcp --version

Environment:
  USHER_REGISTRY_URL     registry to knock on (default ${USHER_DEFAULT_REGISTRY})
  USHER_AGENT_KEY_FILE   the agent's private key (default ${DEFAULT_KEY_FILE}, created on first run)
`;

const registry = (process.env.USHER_REGISTRY_URL || USHER_DEFAULT_REGISTRY).replace(/\/$/, '');
const keyFile = process.env.USHER_AGENT_KEY_FILE || DEFAULT_KEY_FILE;
const arg = process.argv[2];

if (arg === '--version' || arg === '-v') {
  console.log(USHER_MCP_VERSION);
} else if (arg === '--help' || arg === '-h') {
  console.log(HELP);
} else if (arg === '--check') {
  // Knocks on the demo quote form, signed with this agent's key, and says what came back.
  const identity = await loadOrCreateIdentity(keyFile);
  const client = new RegistryClient(registry, identity);
  const form = process.env.USHER_CHECK_URL || USHER_DEMO_FORM;
  try {
    const reply = await client.knock({ url: form, intent: 'quote.car_insurance' });
    const map = reply.map as { fingerprint?: { digest?: string }; fields?: unknown[]; actions?: unknown[] } | null;
    console.log(`Knocked on ${form}
  registry   ${registry}
  agent key  ${identity.id} (${keyFile})
  pass       ${reply.token ? `a token, valid until ${reply.expires_at}` : 'none'}
  map        ${map ? `${map.fields?.length ?? 0} fields, ${map.actions?.length ?? 0} actions (${map.fingerprint?.digest?.slice(0, 19)}…)` : 'none yet'}
  rules      ${reply.rules ? 'yes' : 'none'}
  session    ${reply.session}${form === USHER_DEMO_FORM ? `\n  see it     ${registry}/demo/dashboard (the demo site's live dashboard)` : ''}
OK`);
  } catch (err) {
    console.error(`Knock on ${form} via ${registry} failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
} else if (arg) {
  console.error(`Unknown option ${arg}.\n\n${HELP}`);
  process.exit(2);
} else {
  const server = await createMcpServer(registry, keyFile, USHER_MCP_VERSION);
  // usher_fill: Usher does the filling, in its own headless browser; the model only for pages
  // with no map (MODEL_API_KEY, within USHER_DAILY_MODEL_BUDGET_USD a day).
  const fallback = capFallback();
  const fill = registerFillTools(server, { registryUrl: registry, keyFile, ...(fallback && { fallback }) });
  // The client closing stdin ends the server, browser and all; an open browser would keep it alive.
  const stop = () => void fill.close().finally(() => process.exit(0));
  process.stdin.once('end', stop).once('close', stop);
  await server.connect(new StdioServerTransport());
}
