import { z } from 'zod';
import type { SandboxInput, ExecutionPolicy } from '../contracts/sandbox.js';
import { IdSchema, RuntimeError } from '../contracts/runtime.js';
import { ToolDiagnosticsSchema, type ToolDiagnostics } from '../contracts/tool-feedback.js';
import { jsonHash, ToolRegistry, type JsonValue } from './registry.js';

export const RUNTIME_PYTHON_TOOL = 'runtime_python';

export interface RuntimeCodeResult {
  attemptId: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  artifacts: Array<{ artifactId: string; path: string; size: number; sha256: string }>;
  diagnostics?: ToolDiagnostics | undefined;
}

export const runtimeCodeResultSchema = z.strictObject({
  attemptId: z.string().min(1), stdout: z.string(), stderr: z.string(), exitCode: z.int(),
  // Stored records also contain runId/attemptId. Project only the public reference
  // fields before the strict Harness output check, retaining semantic validation.
  artifacts: z.array(z.object({
    artifactId: z.string().min(1), path: z.string().min(1), size: z.int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  })),
  diagnostics: ToolDiagnosticsSchema.optional(),
});

/** The composition root supplies this service; it owns scheduling and cancellation. */
export interface RuntimeCodeExecutor {
  executeCode(input: {
    runId: string;
    stepId: string;
    code: string;
    inputs: SandboxInput[];
    required?: boolean;
    obligationId?: string;
    repairOf?: string[];
  }, signal?: AbortSignal): Promise<RuntimeCodeResult>;
}


export interface PythonToolLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  maxCodeBytes?: number;
}

/** JSON-escaped logs and bounded artifact references comprise the tool result. */
export function pythonToolLimits(policy: ExecutionPolicy): PythonToolLimits {
  return {
    timeoutMs: policy.commandTimeoutMs,
    maxOutputBytes: policy.maxLogBytes * 12 + policy.maxOutputFiles * 8192 + 262144,
  };
}

/** The existing executor retains its run/step claims, recovery and lifecycle errors. */
export class RegisteredPythonExecutor implements RuntimeCodeExecutor {
  private readonly unregister: () => void;

  constructor(private readonly executor: RuntimeCodeExecutor, private readonly registry: ToolRegistry,
    limits: PythonToolLimits = { timeoutMs: 60000, maxOutputBytes: 16777216 }) {
    const maxCodeBytes = limits.maxCodeBytes ?? 256 * 1024;
    const input = z.strictObject({
      stepId: IdSchema,
      code: z.string().min(1).max(maxCodeBytes),
      inputs: z.array(z.strictObject({ path: z.string().min(1), content: z.string() })),
      required: z.boolean().optional(),
      obligationId: IdSchema.optional(),
      repairOf: z.array(IdSchema).min(1).max(8).optional(),
    });
    this.unregister = registry.register({
      name: RUNTIME_PYTHON_TOOL,
      description: 'Execute Python with trusted attached inputs, returning verified artifact references and bounded logs.',
      inputSchema: z.toJSONSchema(input, { target: 'draft-7' }),
      outputSchema: z.toJSONSchema(runtimeCodeResultSchema, { target: 'draft-7' }),
      location: 'sandbox', permissions: ['sandbox:execute'], timeoutMs: limits.timeoutMs,
      maxOutputBytes: limits.maxOutputBytes,
      idempotency: 'idempotent', executionOwner: 'executor',
      retry: { maxAttempts: 1, retryableCodes: [] },
      execute: async (args, context) => {
        const value = input.parse(args);
        if (value.stepId !== context.callId) throw new RuntimeError('CONFLICT', 'Python tool identity changed');
        if (Buffer.byteLength(value.code, 'utf8') > maxCodeBytes) throw new RuntimeError('INVALID_INPUT', 'Python code exceeds its byte limit');
        if (value.repairOf && new Set(value.repairOf).size !== value.repairOf.length) throw new RuntimeError('INVALID_INPUT', 'Repair step identities must be unique');
        const result = await this.executor.executeCode({ runId: context.runId, stepId: value.stepId, code: value.code,
          inputs: value.inputs.map(item => ({ path: item.path, content: Uint8Array.from(Buffer.from(item.content, 'base64')) })),
          ...(value.required === undefined ? {} : { required: value.required }),
          ...(value.obligationId === undefined ? {} : { obligationId: value.obligationId }),
          ...(value.repairOf === undefined ? {} : { repairOf: value.repairOf }),
        }, context.signal);
        return JSON.parse(JSON.stringify(runtimeCodeResultSchema.parse(result))) as JsonValue;
      },
    });
  }

  async executeCode(input: Parameters<RuntimeCodeExecutor['executeCode']>[0], signal?: AbortSignal): Promise<RuntimeCodeResult> {
    const args = {
      stepId: input.stepId, code: input.code,
      inputs: input.inputs.map(item => ({ path: item.path, content: Buffer.from(item.content).toString('base64') })),
      ...(input.required === undefined ? {} : { required: input.required }),
      ...(input.obligationId ? { obligationId: input.obligationId } : {}),
      ...(input.repairOf ? { repairOf: [...input.repairOf] } : {}),
    };
    const inputVersion = jsonHash(args.inputs);
    const result = await this.registry.execute({ runId: input.runId, callId: input.stepId,
      inputVersion, progressVersion: inputVersion, grantedPermissions: ['sandbox:execute'],
      ...(signal ? { signal } : {}),
    }, RUNTIME_PYTHON_TOOL, args);
    if (!result.ok) {
      const code = result.error.code === 'EXECUTION_UNKNOWN' ? 'EXECUTION_UNKNOWN'
        : result.error.code === 'CALL_CONFLICT' ? 'CONFLICT'
        : result.error.code === 'POLICY_TOOL_BLOCKED' ? 'POLICY_TOOL_BLOCKED' : 'INVALID_INPUT';
      throw new RuntimeError(code, result.error.message, { phase: 'tool.registry', retryable: false });
    }
    return runtimeCodeResultSchema.parse(result.value);
  }

  dispose(): void { this.unregister(); }
}
