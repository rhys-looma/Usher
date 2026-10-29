// MCP Apps (SEP-1865): Usher's tool results as small cards in clients that render them (Claude,
// ChatGPT). The card itself (decision, result and ticket, and how a site's theme applies) is
// packages/registry/src/web/card-page.ts, shared with the dashboard's live preview; this registers
// it as the server's ui:// resource.

import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CARD_HTML } from '../../registry/src/web/card-page.ts';

export const CARD_URI = 'ui://usher/card.html';
export const CARD_MIME = 'text/html;profile=mcp-app';

/** Tool metadata that links a tool's results to the card (the standard key and ChatGPT's alias). */
export const CARD_META = { ui: { resourceUri: CARD_URI }, 'openai/outputTemplate': CARD_URI };

/** Claude's dedicated origin for a server's views: the first 32 hex characters of sha256(server URL). */
export function claudeDomain(serverUrl: string): string {
  return `${createHash('sha256').update(serverUrl).digest('hex').slice(0, 32)}.claudemcpcontent.com`;
}

/**
 * Registers the card. `serverUrl`, for a server reached over HTTP (hosted), gives Claude its
 * dedicated origin for the card; a local stdio server has none, and the host's default applies.
 */
export function registerCards(server: McpServer, options: { serverUrl?: string } = {}): void {
  server.registerResource(
    'usher-card',
    CARD_URI,
    { title: 'Usher card', description: 'Usher\'s decisions, ticket and result as a small card.', mimeType: CARD_MIME, _meta: { ui: { prefersBorder: true } } },
    async () => {
      const client = server.server.getClientVersion()?.name ?? '';
      const domain = options.serverUrl && /claude/i.test(client) ? claudeDomain(options.serverUrl) : undefined;
      return { contents: [{ uri: CARD_URI, mimeType: CARD_MIME, text: CARD_HTML, _meta: { ui: { prefersBorder: true, csp: {}, ...(domain && { domain }) } } }] };
    },
  );
}
