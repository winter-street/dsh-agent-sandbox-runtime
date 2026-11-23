import { describe, expect, it, vi } from 'vitest';
import { MemoryToolCallStore, ToolRegistry, canonicalJson, jsonHash, type RegisteredTool, type ToolCallContext } from '../../src/tools/registry.js';

function setup() {
  const registry = new ToolRegistry(new MemoryToolCallStore());
  const execute = vi.fn<RegisteredTool['execute']>().mockResolvedValue({ sum: 5 });
  const tool: RegisteredTool = {
    name: 'sum', description: 'Sum two integers', location: 'sandbox', permissions: ['sandbox:execute'],
    timeoutMs: 50, maxOutputBytes: 1000, idempotency: 'read-only', retry: { maxAttempts: 2, retryableCodes: ['TOOL_TIMEOUT'] },
    inputSchema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { sum: { type: 'integer' } }, required: ['sum'], additionalProperties: false }, execute,
  };
  const unregister = registry.register(tool);
  const context: ToolCallContext = { runId: 'run', callId: 'call', inputVersion: 'input-v1', progressVersion: 'step-v1', grantedPermissions: ['sandbox:execute'] };
  return { registry, execute, context, unregister, tool };
}

describe('tool registry protocol', () => {
  it('validates JSON Schema before execution and preserves explicit execution location', async () => {
    const { registry, execute, context } = setup();
    expect(await registry.execute(context, 'sum', { a: '2', b: 3 })).toMatchObject({ ok: false, location: 'sandbox', error: { code: 'INVALID_ARGUMENT' } });
    expect(execute).not.toHaveBeenCalled();
    expect(registry.list()[0]).toMatchObject({ location: 'sandbox', permissions: ['sandbox:execute'], idempotency: 'read-only' });
  });
  it('hashes canonical arguments and replays a stable call once', async () => {
    const { registry, execute, context } = setup();
    const first = await registry.execute(context, 'sum', { a: 2, b: 3 });
    const second = await registry.execute(context, 'sum', { b: 3, a: 2 });
    expect(second).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await registry.execute(context, 'sum', { a: 4, b: 3 })).toMatchObject({ error: { code: 'CALL_CONFLICT' } });
  });
  it('makes permission/policy rejection stable for a repeated call ID', async () => {
    const { registry, execute, context } = setup();
    const first = await registry.execute({ ...context, grantedPermissions: [] }, 'sum', { a: 2, b: 3 });
    expect(first).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
    expect(await registry.execute(context, 'sum', { a: 2, b: 3 })).toEqual(first);
    expect(execute).not.toHaveBeenCalled();
    expect(await registry.execute({ ...context, callId: 'second', authorize: () => ({ allowed: false, reason: 'local limit' }) }, 'sum', { a: 2, b: 3 })).toMatchObject({ error: { code: 'POLICY_TOOL_BLOCKED' } });
  });
  it('does not dispatch another call while its duplicate execution is pending', async () => {
    const { registry, execute, context } = setup();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    execute.mockImplementation(async () => { await pending; return { sum: 5 }; });
    const first = registry.execute(context, 'sum', { a: 2, b: 3 });
    expect(await registry.execute(context, 'sum', { a: 2, b: 3 })).toMatchObject({ error: { code: 'EXECUTION_UNKNOWN' } });
    finish(); await first;
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('re-enters a durable owner after a pause and on replay without replacing its lifecycle errors', async () => {
    const { registry, tool, context, unregister } = setup(); unregister();
    const execute = vi.fn<RegisteredTool['execute']>()
      .mockRejectedValueOnce(new Error('approval required'))
      .mockResolvedValue({ sum: 5 });
    registry.register({ ...tool, idempotency: 'idempotent', executionOwner: 'executor', execute });
    await expect(registry.execute(context, 'sum', { a: 2, b: 3 })).rejects.toThrow('approval required');
    const result = await registry.execute(context, 'sum', { a: 2, b: 3 });
    expect(result).toMatchObject({ ok: true, value: { sum: 5 } });
    expect(await registry.execute(context, 'sum', { a: 2, b: 3 })).toEqual(result);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(await registry.execute(context, 'sum', { a: 3, b: 3 })).toMatchObject({ error: { code: 'CALL_CONFLICT' } });
  });

  it('accepts concurrent identical completions from the durable execution owner', async () => {
    const { registry, tool, context, unregister } = setup(); unregister();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const execute = vi.fn<RegisteredTool['execute']>().mockImplementation(async () => { await gate; return { sum: 5 }; });
    registry.register({ ...tool, idempotency: 'idempotent', executionOwner: 'executor', execute });
    const first = registry.execute(context, 'sum', { a: 2, b: 3 });
    const second = registry.execute(context, 'sum', { a: 2, b: 3 });
    finish();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ ok: true, value: { sum: 5 } });
    expect(b).toEqual(a);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('normalizes bad output and output size before publishing a successful result', async () => {
    const { registry, execute, context } = setup();
    execute.mockResolvedValue({ sum: 'bad' });
    expect(await registry.execute(context, 'sum', { a: 2, b: 3 })).toMatchObject({ error: { code: 'INVALID_OUTPUT' } });
  });
  it('waits for cooperative timeout cleanup and exposes its classified result', async () => {
    const { registry, execute, context } = setup();
    execute.mockImplementation(async (_args, execution) => new Promise((_resolve, reject) => {
      execution.signal.addEventListener('abort', () => setTimeout(() => reject(execution.signal.reason), 5), { once: true });
    }));
    expect(await registry.execute(context, 'sum', { a: 2, b: 3 })).toMatchObject({ error: { code: 'TOOL_TIMEOUT', retryable: true } });
  });
  it('rejects non-JSON input and unregisters cleanly', async () => {
    const { registry, context, unregister } = setup();
    expect(() => canonicalJson({ value: Number.NaN })).toThrow();
    expect(() => canonicalJson({ value: undefined })).toThrow();
    expect(jsonHash({ b: 1, a: 2 })).toBe(jsonHash({ a: 2, b: 1 }));
    unregister();
    expect(await registry.execute(context, 'sum', {})).toMatchObject({ error: { code: 'UNKNOWN_TOOL' } });
  });

  it('does not mark a non-idempotent tool retryable when it returns after its timeout', async () => {
    const { registry, tool, context, unregister } = setup(); unregister();
    registry.register({ ...tool, idempotency: 'non-idempotent', execute: async (_args, execution) => {
      await new Promise<void>(resolve => execution.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { sum: 5 };
    } });
    expect(await registry.execute(context, 'sum', { a: 2, b: 3 })).toMatchObject({ error: { code: 'TOOL_TIMEOUT', retryable: false } });
  });
});
