import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry, MemoryToolCallStore, type ToolCallContext } from '../../src/tools/registry.js';
import { McpToolConnection } from '../../src/tools/mcp/client.js';

const connections: McpToolConnection[] = [];
afterEach(async () => { for (const connection of connections.splice(0)) await connection.close(); });
const context = (callId: string): ToolCallContext => ({ runId: 'run', callId, inputVersion: 'v1', progressVersion: 'p1', grantedPermissions: ['reference:read'] });
async function setup(timeoutMs = 1000) {
  const registry = new ToolRegistry(new MemoryToolCallStore());
  const connection = new McpToolConnection({
    command: process.execPath,
    args: ['--import', 'tsx', fileURLToPath(new URL('../../src/tools/mcp/reference-server.ts', import.meta.url))],
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
  });
  connections.push(connection);
  await connection.connect(registry, [{ name: 'lookup_rule', permissions: ['reference:read'], timeoutMs, maxOutputBytes: 4096, idempotency: 'read-only' }]);
  return { registry, connection };
}
describe('real MCP SDK stdio integration with local read-only reference server', () => {
  it('negotiates capabilities, discovers and calls a host tool through schema and permission gates', async () => {
    const { registry } = await setup();
    expect(registry.list()).toEqual([expect.objectContaining({ name: 'mcp.lookup_rule', location: 'mcp-host' })]);
    expect(await registry.execute(context('1'), 'mcp.lookup_rule', { key: 'ranking' })).toMatchObject({ ok: true, value: { key: 'ranking', rule: expect.stringContaining('descending') } });
    expect(await registry.execute({ ...context('2'), grantedPermissions: [] }, 'mcp.lookup_rule', { key: 'ranking' })).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
  });
  it('rejects invalid args and reports timeout without claiming a sandbox boundary', async () => {
    const { registry } = await setup(30);
    expect(await registry.execute(context('1'), 'mcp.lookup_rule', { key: 'unknown' })).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
    expect(await registry.execute(context('2'), 'mcp.lookup_rule', { key: 'ranking', delayMs: 1000 })).toMatchObject({ error: { code: 'TOOL_TIMEOUT' } });
  });
  it('cleans up registrations and the child process on close', async () => {
    const { registry, connection } = await setup();
    await connection.close();
    expect(registry.list()).toEqual([]);
    expect(await registry.execute(context('1'), 'mcp.lookup_rule', { key: 'ranking' })).toMatchObject({ error: { code: 'UNKNOWN_TOOL' } });
  });
});
