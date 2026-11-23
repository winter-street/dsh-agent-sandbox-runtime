import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { canonicalJson, type JsonValue, type ToolRegistry } from '../registry.js';

export interface McpToolGrant { name: string; permissions: string[]; timeoutMs: number; maxOutputBytes: number; idempotency?: 'read-only' | 'idempotent' | 'non-idempotent' }
/** Configuration/allowlist are operator-controlled. MCP annotations are not authorization. */
export class McpToolConnection {
  private readonly client = new Client({ name: 'agent-runtime', version: '0.1.0' }, { capabilities: {} });
  private transport: StdioClientTransport | undefined;
  private unregister: Array<() => void> = [];
  private connected = false;
  constructor(private readonly server: StdioServerParameters) {}

  async connect(registry: ToolRegistry, grants: readonly McpToolGrant[]): Promise<void> {
    if (this.connected) throw new Error('MCP connection already active');
    const transport = new StdioClientTransport({ ...this.server, stderr: this.server.stderr ?? 'pipe', maxBufferSize: 1_000_000 });
    this.transport = transport;
    // Drain bounded diagnostic bytes without forwarding server-controlled messages into prompts.
    let diagnosticBytes = 0;
    transport.stderr?.on('data', chunk => { diagnosticBytes = Math.min(4096, diagnosticBytes + Buffer.byteLength(chunk)); });
    try {
      await this.client.connect(transport);
      if (!this.client.getServerCapabilities()?.tools) throw new Error('MCP server does not advertise tools');
      const discovered = new Map<string, Awaited<ReturnType<Client['listTools']>>['tools'][number]>();
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let pages = 0; pages < 20; pages += 1) {
        const page = await this.client.listTools(cursor ? { cursor } : undefined);
        for (const tool of page.tools) {
          if (discovered.has(tool.name)) throw new Error('MCP discovery returned duplicate tool names');
          discovered.set(tool.name, tool);
        }
        if (!page.nextCursor) break;
        if (cursors.has(page.nextCursor) || pages === 19) throw new Error('MCP tool discovery pagination is not bounded');
        cursors.add(page.nextCursor); cursor = page.nextCursor;
      }
      for (const grant of grants) {
        const tool = discovered.get(grant.name);
        if (!tool) throw new Error(`Granted MCP tool was not discovered: ${grant.name}`);
        this.unregister.push(registry.register({
          name: `mcp.${tool.name}`, description: tool.description ?? tool.name,
          inputSchema: tool.inputSchema, outputSchema: tool.outputSchema ?? { type: 'object' },
          location: 'mcp-host', permissions: [...grant.permissions], timeoutMs: grant.timeoutMs,
          maxOutputBytes: grant.maxOutputBytes, idempotency: grant.idempotency ?? 'non-idempotent', retry: { maxAttempts: 1, retryableCodes: [] },
          execute: async (args, context) => {
            if (!this.connected) throw Object.assign(new Error('MCP transport is disconnected'), { code: 'EXECUTION_UNKNOWN' });
            try {
              const response = await this.client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, undefined, { signal: context.signal, timeout: grant.timeoutMs });
              if (response.isError) throw new Error(`MCP tool failed: ${JSON.stringify(response.content)}`);
              const value = response.structuredContent ?? { content: response.content };
              canonicalJson(value);
              return value as JsonValue;
            } catch (error) {
              if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) throw Object.assign(new Error('MCP request timed out; remote cancellation is advisory'), { code: 'TOOL_TIMEOUT' });
              if (!this.connected) throw Object.assign(new Error('MCP disconnected before a final result; execution outcome is unknown'), { code: 'EXECUTION_UNKNOWN' });
              throw error;
            }
          },
        }));
      }
      this.client.onclose = () => { this.connected = false; };
      this.connected = true;
    } catch (error) { await this.close(); throw error; }
  }
  async close(): Promise<void> {
    this.connected = false;
    for (const unregister of this.unregister.splice(0).reverse()) unregister();
    await this.client.close();
    await this.transport?.close();
    this.transport = undefined;
  }
}
