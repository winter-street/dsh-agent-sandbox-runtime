import { createHash } from 'node:crypto';
import type { Context, Plugin } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import type { SandboxInput } from '../../contracts/sandbox.js';
import { IdSchema, RuntimeError } from '../../contracts/runtime.js';
import { ToolDiagnosticsSchema, type ToolDiagnostics } from '../../contracts/tool-feedback.js';
import type { DurableToolRules } from '../../tools/durable.js';

import { RegisteredPythonExecutor, RUNTIME_PYTHON_TOOL, runtimeCodeResultSchema, type RuntimeCodeExecutor, type RuntimeCodeResult, type PythonToolLimits } from '../../tools/python.js';
import { MemoryToolCallStore, ToolRegistry } from '../../tools/registry.js';
export { RUNTIME_PYTHON_TOOL };
export type { RuntimeCodeExecutor, RuntimeCodeResult };

export interface HarnessRunBinding {
  runId: string;
  inputs: SandboxInput[];
  required?: boolean;
  progressVersion?: string;
  obligationId?: string;
}

export interface HarnessRuntimeOptions {
  executor: RuntimeCodeExecutor;
  /** Resolve trusted session state. Undefined denies execution; never mint a new budget. */
  resolveRun(sessionId: string, parentSession?: string, signal?: AbortSignal):
    HarnessRunBinding | undefined | Promise<HarnessRunBinding | undefined>;
  maxCodeBytes?: number;
  registry?: ToolRegistry;
  pythonLimits?: PythonToolLimits;
  /** Optional durable policy gate supplied by the trusted composition root. */
  toolRules?: DurableToolRules;
  /** Trusted independent acceptance. Model text and exit codes cannot conclude a task. */
  acceptResult?: (runId: string, result: Readonly<RuntimeCodeResult>, signal: AbortSignal) => Promise<boolean>;
  /** Diagnose failed as well as successful executions; diagnosis never implies successful completion. */
  describeResult?: (runId: string, result: Readonly<RuntimeCodeResult>, signal: AbortSignal) => Promise<ToolDiagnostics>;
  /** Trusted pre-dispatch gate. Rejection aborts before any sandbox attempt is created. */
  authorize?: (input: {
    runId: string; code: string; args: unknown;
    exec: ToolRunContext; signal: AbortSignal;
  }) => Promise<void>;
}

/** Stable for replay of one recorded call, distinct for child/nested calls. */
export function runtimeStepId(sessionId: string, callId: string): string {
  return `tool-${createHash('sha256').update(JSON.stringify([sessionId, callId])).digest('hex')}`;
}

function readCode(args: unknown, maxBytes: number): { code: string; repairOf?: string[] } {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError('runtime_python expects an object containing code');
  }
  const value = args as Record<string, unknown>;
  if (Object.keys(value).some(key => !['code', 'repairOf'].includes(key)) || typeof value.code !== 'string' || value.code.length === 0) {
    throw new TypeError('runtime_python accepts code and an optional explicit repairOf list');
  }
  if (Buffer.byteLength(value.code, 'utf8') > maxBytes) {
    throw new TypeError(`Python code exceeds the ${maxBytes} byte limit`);
  }
  const repairOf = value.repairOf === undefined ? undefined : z.array(IdSchema).min(1).max(8).parse(value.repairOf);
  if (repairOf && new Set(repairOf).size !== repairOf.length) throw new TypeError('repairOf must contain unique failed step identifiers');
  return { code: value.code, ...(repairOf ? { repairOf } : {}) };
}

/** Thin Cordis plugin. Model arguments cannot select run, input paths, budget or permissions. */
export function createHarnessRuntimePlugin(options: HarnessRuntimeOptions): Plugin.Object<void> {
  const maxCodeBytes = options.maxCodeBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(maxCodeBytes) || maxCodeBytes < 1) {
    throw new TypeError('maxCodeBytes must be a positive safe integer');
  }
  return {
    name: 'agent-sandbox-runtime',
    inject: ['tools'],
    apply(ctx: Context) {
      const registeredExecutor = new RegisteredPythonExecutor(options.executor, options.registry ?? new ToolRegistry(new MemoryToolCallStore()),
        { timeoutMs: 60000, maxOutputBytes: 16777216, ...options.pythonLimits, maxCodeBytes });
      const shutdown = new AbortController();
      const pending = new Set<Promise<RuntimeCodeResult>>();
      let closing = false;

      async function execute(args: unknown, exec: ToolRunContext): Promise<RuntimeCodeResult> {
        if (closing) throw new Error('Runtime tool plugin is unloading');
        const request = readCode(args, maxCodeBytes); const { code, repairOf } = request;
        const agent = exec.agent;
        if (!agent) throw new Error('Runtime tool requires an associated Harness agent');
        const signal = AbortSignal.any([exec.signal, shutdown.signal]);
        signal.throwIfAborted();
        const sessionId = agent.session.id;
        const binding = await options.resolveRun(sessionId, agent.session.header.parentSession, signal);
        signal.throwIfAborted();
        if (!binding || !binding.runId) throw new Error('Harness session has no runtime run binding');
        const inputs = binding.inputs.map(input => ({ path: input.path, content: Uint8Array.from(input.content) }));
        const progressVersion = binding.progressVersion ?? createHash('sha256').update(JSON.stringify(inputs.map(input => [input.path, createHash('sha256').update(input.content).digest('hex')]))).digest('hex');
        const action = { callId: exec.callId, toolName: RUNTIME_PYTHON_TOOL, arguments: request, inputVersion: progressVersion, progressVersion };
        const admission = options.toolRules?.admit(binding.runId, action);
        if (admission && !admission.allowed) throw new RuntimeError('POLICY_TOOL_BLOCKED', admission.reason ?? 'Tool call rejected by durable tool policy', { phase: 'tool.admission', retryable: false, userAction: 'Change the approach or provide new input' });
        if (options.authorize) await options.authorize({ runId: binding.runId, code, args: request, exec, signal });
        try {
          const result = runtimeCodeResultSchema.parse(await registeredExecutor.executeCode({
            runId: binding.runId, stepId: runtimeStepId(sessionId, exec.callId), code, inputs,
            ...(binding.required === undefined ? {} : { required: binding.required }),
            ...(binding.obligationId ? { obligationId: binding.obligationId } : {}), ...(repairOf ? { repairOf } : {}),
          }, signal));
          if (options.describeResult) result.diagnostics = ToolDiagnosticsSchema.parse(await options.describeResult(binding.runId, result, signal));
          signal.throwIfAborted();
          if (result.exitCode === 0 && result.artifacts.length > 0 && options.acceptResult) {
            const accepted = await options.acceptResult(binding.runId, result, signal);
            signal.throwIfAborted();
            // The successful result commits normally before the loop ends;
            // cancellation must never masquerade as successful completion.
            if (accepted) exec.concludeTurn();
          }
          options.toolRules?.record(binding.runId, action, { ok: result.exitCode === 0, ...(result.exitCode === 0 ? {} : { errorSignature: createHash('sha256').update(`${result.exitCode}:${result.stderr}:${result.stdout}`).digest('hex') }), progressVersion });
          return result;
        } catch (error) {
          options.toolRules?.record(binding.runId, action, { ok: false, errorSignature: createHash('sha256').update(error instanceof Error ? error.message : String(error)).digest('hex'), progressVersion });
          throw error;
        }
      }

      const definition: ToolDefinition = {
        name: RUNTIME_PYTHON_TOOL,
        description: 'Execute Python using attached input files. Each call has fresh AGENT_INPUT_DIR and AGENT_OUTPUT_DIR directories. Earlier committed artifacts are inputs at artifacts/<artifactId>/<path>, never in the new output directory. Return logs, artifact references and trusted diagnostics. To repair a failed delivery, explicitly include only the matching repairableStepIds from diagnostics in repairOf. The host verifies the obligation and independent acceptance; a nonzero exit remains a failure.',
        parameters: {
          type: 'object',
          properties: { code: { type: 'string', description: `Nonempty Python source, at most ${maxCodeBytes} UTF-8 bytes.` },
            repairOf: { type: 'array', items: { type: 'string' }, description: 'One to eight unique failed step identifiers from this delivery diagnostics; checked by the host.' } },
          required: ['code'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              attemptId: { type: 'string' },
              stdout: { type: 'string' },
              stderr: { type: 'string' },
              exitCode: { type: 'integer' },
              // Harness enforces a small JSON Schema subset. Zod applies the
              // identifier, count and byte limits before this wire check.
              diagnostics: { type: 'object', additionalProperties: false,
                properties: {
                  schemaVersion: { type: 'integer', const: 1 }, stepId: { type: 'string' },
                  execution: { type: 'string', enum: ['succeeded', 'failed'] }, validation: { type: 'string', enum: ['passed', 'failed', 'unavailable'] },
                  problems: { type: 'array', items: { type: 'string' } },
                  priorArtifacts: { type: 'array', items: { type: 'object', additionalProperties: false,
                    properties: { artifactId: { type: 'string' }, inputPath: { type: 'string' } }, required: ['artifactId', 'inputPath'] } },
                  omittedArtifactCount: { type: 'integer' }, repairableStepIds: { type: 'array', items: { type: 'string' } },
                  omittedRepairCount: { type: 'integer' }, repairedStepIds: { type: 'array', items: { type: 'string' } }, guidance: { type: 'string' },
                }, required: ['schemaVersion', 'stepId', 'execution', 'validation', 'problems', 'priorArtifacts', 'omittedArtifactCount', 'repairableStepIds', 'omittedRepairCount', 'repairedStepIds', 'guidance'] },
              artifacts: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    artifactId: { type: 'string' }, path: { type: 'string' },
                    size: { type: 'integer' }, sha256: { type: 'string' },
                  },
                  required: ['artifactId', 'path', 'size', 'sha256'],
                  additionalProperties: false,
                },
              },
            },
            required: ['attemptId', 'stdout', 'stderr', 'exitCode', 'artifacts'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute(args, exec) {
          const task = execute(args, exec);
          pending.add(task);
          return task.finally(() => pending.delete(task));
        },
      };
      const unregister = ctx.tools.register(definition);
      ctx.effect(() => async () => {
        closing = true;
        unregister();
        shutdown.abort(new Error('Runtime tool plugin disposed'));
        // The executor must resolve/reject only after its remote cancellation is accounted for.
        await Promise.allSettled([...pending]);
        registeredExecutor.dispose();
      });
    },
  };
}
