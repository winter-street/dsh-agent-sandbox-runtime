import { createHash } from 'node:crypto';
import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ToolLocation = 'sandbox' | 'host' | 'mcp-host';
export type ToolErrorCode = 'UNKNOWN_TOOL' | 'INVALID_ARGUMENT' | 'PERMISSION_DENIED' | 'POLICY_TOOL_BLOCKED'
  | 'CALL_CONFLICT' | 'TOOL_TIMEOUT' | 'TOOL_CANCELLED' | 'TOOL_FAILED' | 'INVALID_OUTPUT' | 'OUTPUT_TOO_LARGE' | 'EXECUTION_UNKNOWN';
export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  location: ToolLocation;
  permissions: string[];
  timeoutMs: number;
  idempotency: 'read-only' | 'idempotent' | 'non-idempotent';
  retry: { maxAttempts: number; retryableCodes: string[] };
  maxOutputBytes: number;
  /** Durable executor owns dispatch claims, recovery, timeout and lifecycle errors. */
  executionOwner?: 'executor';
  execute(args: JsonValue, context: ToolBodyContext): Promise<JsonValue>;
}
export interface ToolBodyContext {
  runId: string; callId: string; inputVersion: string; progressVersion: string; signal: AbortSignal;
}
export interface ToolCallContext extends Omit<ToolBodyContext, 'signal'> {
  signal?: AbortSignal;
  grantedPermissions: readonly string[];
  authorize?: (tool: Readonly<RegisteredTool>, argsHash: string) => { allowed: boolean; reason?: string } | Promise<{ allowed: boolean; reason?: string }>;
}
export interface ToolCallReceipt {
  callId: string; runId: string; toolName: string; argsHash: string; inputHash: string; requestHash: string;
  location: ToolLocation;
}
export type ToolCallResult = ToolCallReceipt & (
  | { ok: true; value: JsonValue }
  | { ok: false; error: { code: ToolErrorCode; message: string; retryable: boolean }; feedbackKey: string }
);
export interface ToolCallStore {
  /** Must atomically claim one (runId,callId). Pending on restart means execution unknown. */
  claim(receipt: ToolCallReceipt): Promise<{ kind: 'new' } | { kind: 'pending' } | { kind: 'conflict' } | { kind: 'result'; result: ToolCallResult }>;
  complete(receipt: ToolCallReceipt, result: ToolCallResult): Promise<void>;
}

/** For isolated tests/demo only; production supplies durable claim/complete transactions. */
export class MemoryToolCallStore implements ToolCallStore {
  private readonly records = new Map<string, { receipt: ToolCallReceipt; result?: ToolCallResult }>();
  async claim(receipt: ToolCallReceipt) {
    const key = JSON.stringify([receipt.runId, receipt.callId]);
    const old = this.records.get(key);
    if (!old) { this.records.set(key, { receipt: structuredClone(receipt) }); return { kind: 'new' as const }; }
    if (old.receipt.requestHash !== receipt.requestHash) return { kind: 'conflict' as const };
    return old.result ? { kind: 'result' as const, result: structuredClone(old.result) } : { kind: 'pending' as const };
  }
  async complete(receipt: ToolCallReceipt, result: ToolCallResult): Promise<void> {
    const key = JSON.stringify([receipt.runId, receipt.callId]);
    const old = this.records.get(key);
    if (!old || old.receipt.requestHash !== receipt.requestHash || old.result) throw new Error('Tool call completion conflict');
    old.result = structuredClone(result);
  }
}

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || value === null || seen.has(value)) throw new TypeError('Tool data must be acyclic lossless JSON');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Tool data requires plain JSON objects');
  seen.add(value);
  let text: string;
  if (Array.isArray(value)) text = `[${Array.from(value, item => canonical(item, seen)).join(',')}]`;
  else text = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return text;
}
export function canonicalJson(value: unknown): string { return canonical(value); }
export function jsonHash(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }

function deepFreeze(value: JsonValue): JsonValue {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Tool metadata and schema boundary shared by local, sandbox and MCP adapters. */
export class ToolRegistry {
  private readonly ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
  private readonly tools = new Map<string, { definition: RegisteredTool; input: ValidateFunction; output: ValidateFunction }>();
  constructor(private readonly store: ToolCallStore) {}

  register(definition: RegisteredTool): () => void {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(definition.name) || this.tools.has(definition.name)) throw new TypeError('Invalid or duplicate tool name');
    if (![definition.timeoutMs, definition.maxOutputBytes, definition.retry.maxAttempts].every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Tool limits must be positive integers');
    if (definition.permissions.some(permission => !permission) || new Set(definition.permissions).size !== definition.permissions.length) throw new TypeError('Tool permissions must be unique nonempty strings');
    if (!['sandbox', 'host', 'mcp-host'].includes(definition.location)) throw new TypeError('Unknown tool execution location');
    if (definition.executionOwner && definition.idempotency !== 'idempotent') throw new TypeError('Executor-owned recovery requires idempotent execution identities');
    const owned: RegisteredTool = {
      ...definition, inputSchema: structuredClone(definition.inputSchema), outputSchema: structuredClone(definition.outputSchema),
      permissions: [...definition.permissions], retry: { ...definition.retry, retryableCodes: [...definition.retry.retryableCodes] },
    };
    const item = { definition: owned, input: this.ajv.compile(owned.inputSchema as AnySchema), output: this.ajv.compile(owned.outputSchema as AnySchema) };
    this.tools.set(definition.name, item);
    return () => { if (this.tools.get(definition.name) === item) this.tools.delete(definition.name); };
  }

  list(): Array<Omit<RegisteredTool, 'execute'>> {
    return [...this.tools.values()].map(({ definition: { execute: _execute, ...metadata } }) => structuredClone(metadata));
  }

  async execute(context: ToolCallContext, toolName: string, rawArgs: unknown): Promise<ToolCallResult> {
    if (!context.runId || !context.callId || !context.inputVersion || !context.progressVersion) throw new TypeError('Tool calls require stable run/call/input/progress identities');
    const registered = this.tools.get(toolName);
    let argsText: string;
    try { argsText = canonicalJson(rawArgs); }
    catch {
      const argsHash = jsonHash(['invalid-json']);
      return { runId: context.runId, callId: context.callId, toolName, argsHash,
        inputHash: jsonHash([argsHash, context.inputVersion]), requestHash: jsonHash([toolName, argsHash, context.inputVersion]),
        location: registered?.definition.location ?? 'host', ok: false,
        error: { code: 'INVALID_ARGUMENT', message: 'Tool arguments must be lossless JSON', retryable: false },
        feedbackKey: jsonHash([context.runId, context.callId, 'INVALID_ARGUMENT']) };
    }
    const argsHash = jsonHash(rawArgs);
    const inputHash = jsonHash([argsHash, context.inputVersion]);
    const receipt: ToolCallReceipt = {
      callId: context.callId, runId: context.runId, toolName, argsHash, inputHash,
      requestHash: jsonHash([toolName, inputHash]), location: registered?.definition.location ?? 'host',
    };
    const failure = (code: ToolErrorCode, message: string, retryable = false): ToolCallResult => ({
      ...receipt, ok: false, error: { code, message, retryable }, feedbackKey: jsonHash([context.runId, context.callId, code]),
    });
    const claim = await this.store.claim(receipt);
    if (claim.kind === 'conflict') return failure('CALL_CONFLICT', 'This tool call ID already belongs to different arguments or input version');
    const executorOwned = registered?.definition.executionOwner === 'executor';
    if (claim.kind === 'pending' && !executorOwned) return failure('EXECUTION_UNKNOWN', 'This call may already have executed; reconcile before retrying');
    if (claim.kind === 'result' && (!executorOwned || !claim.result.ok)) return claim.result;
    const finish = async (result: ToolCallResult) => {
      if (claim.kind === 'result') return result;
      try {
        await this.store.complete(receipt, result);
      } catch (error) {
        if (!executorOwned) throw error;
        const current = await this.store.claim(receipt);
        if (current.kind !== 'result' || canonicalJson(current.result) !== canonicalJson(result)) throw error;
        return current.result;
      }
      return result;
    };
    if (!registered) return finish(failure('UNKNOWN_TOOL', 'Tool is not registered'));
    const { definition, input, output } = registered;
    const args = JSON.parse(argsText) as JsonValue;
    if (!input(args)) return finish(failure('INVALID_ARGUMENT', this.ajv.errorsText(input.errors)));
    if (definition.permissions.some(permission => !context.grantedPermissions.includes(permission))) return finish(failure('PERMISSION_DENIED', 'Required tool permissions were not granted'));
    if (context.signal?.aborted) {
      if (executorOwned) context.signal.throwIfAborted();
      return finish(failure('TOOL_CANCELLED', 'Caller cancelled before dispatch'));
    }
    if (context.authorize) {
      const decision = await context.authorize({ ...definition, permissions: [...definition.permissions],
        inputSchema: structuredClone(definition.inputSchema), outputSchema: structuredClone(definition.outputSchema),
        retry: { ...definition.retry, retryableCodes: [...definition.retry.retryableCodes] } }, argsHash);
      if (!decision.allowed) return finish(failure('POLICY_TOOL_BLOCKED', decision.reason ?? 'Tool policy rejected this call'));
    }
    const finishValue = async (value: JsonValue): Promise<ToolCallResult> => {
      let text: string;
      try { text = canonicalJson(value); } catch { return finish(failure('INVALID_OUTPUT', 'Tool output must be lossless JSON')); }
      if (!output(value)) return finish(failure('INVALID_OUTPUT', this.ajv.errorsText(output.errors)));
      if (Buffer.byteLength(text, 'utf8') > definition.maxOutputBytes) return finish(failure('OUTPUT_TOO_LARGE', 'Tool output exceeds the declared byte limit'));
      return finish({ ...receipt, ok: true, value: JSON.parse(text) as JsonValue });
    };
    if (executorOwned) {
      // Re-enter the durable owner for both pending calls and committed replays.
      // Its original claims and artifact checks decide whether any dispatch is safe.
      // A pause/approval/budget error leaves this outer receipt pending.
      const value = await definition.execute(deepFreeze(args), {
        runId: context.runId, callId: context.callId, inputVersion: context.inputVersion, progressVersion: context.progressVersion,
        signal: context.signal ?? new AbortController().signal,
      });
      return finishValue(value);
    }
    const timeout = new AbortController();
    const signal = context.signal ? AbortSignal.any([context.signal, timeout.signal]) : timeout.signal;
    const timer = setTimeout(() => timeout.abort(new Error('Tool deadline elapsed')), definition.timeoutMs);
    timer.unref();
    try {
      signal.throwIfAborted();
      // Await quiescence: a timer alone cannot hard-kill arbitrary host code.
      const value = await definition.execute(deepFreeze(args), {
        runId: context.runId, callId: context.callId, inputVersion: context.inputVersion, progressVersion: context.progressVersion, signal,
      });
      if (timeout.signal.aborted) return finish(failure('TOOL_TIMEOUT', 'Tool deadline elapsed; execution has now settled', definition.idempotency !== 'non-idempotent' && definition.retry.retryableCodes.includes('TOOL_TIMEOUT')));
      if (context.signal?.aborted) return finish(failure('TOOL_CANCELLED', 'Caller cancelled; execution has now settled'));
      return finishValue(value);
    } catch (error) {
      const candidate = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'TOOL_FAILED';
      const known: ToolErrorCode[] = ['TOOL_TIMEOUT', 'TOOL_CANCELLED', 'EXECUTION_UNKNOWN'];
      const code: ToolErrorCode = timeout.signal.aborted ? 'TOOL_TIMEOUT' : context.signal?.aborted ? 'TOOL_CANCELLED' : known.includes(candidate as ToolErrorCode) ? candidate as ToolErrorCode : 'TOOL_FAILED';
      return finish(failure(code, error instanceof Error ? error.message : 'Tool execution failed', definition.idempotency !== 'non-idempotent' && definition.retry.retryableCodes.includes(code)));
    } finally { clearTimeout(timer); }
  }
}
