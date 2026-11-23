import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/** Fixed, public reference data only. No filesystem/network/write capability is exposed. */
const definitions: Record<string, string> = {
  missing_value: 'Exclude missing measurements from the metric denominator and report excluded row count.',
  ranking: 'Sort descending by count, then ascending by device identifier for ties.',
};
const server = new McpServer({ name: 'agent-runtime-reference', version: '1.0.0' });
server.registerTool('lookup_rule', {
  description: 'Read a fixed public analysis rule by key.',
  inputSchema: { key: z.enum(['missing_value', 'ranking']), delayMs: z.number().int().min(0).max(2000).default(0) },
  outputSchema: { key: z.string(), rule: z.string() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ key, delayMs }, extra) => {
  if (delayMs > 0) await new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(new Error('Reference lookup cancelled')); };
    const timer = setTimeout(() => { extra.signal.removeEventListener('abort', stop); resolve(); }, delayMs);
    if (extra.signal.aborted) stop();
    else extra.signal.addEventListener('abort', stop, { once: true });
  });
  const value = { key, rule: definitions[key]! };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
});
await server.connect(new StdioServerTransport());
