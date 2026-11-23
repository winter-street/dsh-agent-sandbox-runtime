import type { ResourceSample } from '../resources/index.js';

/** Only throw when the adapter can prove no creation request was sent. */
export class SandboxCreateUnsentError extends Error {
  override readonly name = 'SandboxCreateUnsentError';
}

export interface ExecutionPolicy {
  image: string;
  cpu: number;
  memoryMiB: number;
  ttlSeconds: number;
  commandTimeoutMs: number;
  maxLogBytes: number;
  maxOutputBytes: number;
  maxOutputFiles: number;
  network: { defaultAction: 'deny'; allowHosts: string[] };
}

export interface SandboxRef { sandboxId: string; runId: string }
export interface ExecutionRef extends SandboxRef {
  executionId: string;
  attemptId: string;
  workDir: string;
}
export interface SandboxInput { path: string; content: Uint8Array }
export interface ExecutionRequest {
  sandbox: SandboxRef;
  runId: string;
  stepId: string;
  attemptId: string;
  code: string;
  inputs: SandboxInput[];
  policy: ExecutionPolicy;
}
export type ExecutionStatus =
  | { state: 'RUNNING' }
  | { state: 'SUCCEEDED'; exitCode: 0 }
  | { state: 'FAILED'; exitCode: number; error?: string }
  | { state: 'CANCELLED' }
  | { state: 'UNKNOWN'; reason: string };

export interface CancelResult { confirmed: boolean; reason?: string }
export interface SandboxOutput { path: string; content: Uint8Array }
export interface CollectedExecution {
  execution: ExecutionRef;
  stdout: string;
  stderr: string;
  exitCode: number;
  outputs: SandboxOutput[];
  logsTruncated: boolean;
  resources?: ResourceSample;
}

/** Real adapters must never fall back to executing untrusted code on the host. */
export interface SandboxPort {
  create(runId: string, policy: ExecutionPolicy): Promise<SandboxRef>;
  execute(request: ExecutionRequest): Promise<ExecutionRef>;
  inspect(ref: ExecutionRef): Promise<ExecutionStatus>;
  cancel(ref: ExecutionRef): Promise<CancelResult>;
  collect(ref: ExecutionRef, policy: ExecutionPolicy): Promise<CollectedExecution>;
  destroy(ref: SandboxRef): Promise<void>;
  /** Run a bounded create/execute/collect/destroy probe before a batch starts. */
  preflight?(policy: ExecutionPolicy): Promise<{ checkedAt: number; sandboxId?: string }>;
  /** Optional observed resource sample; unsupported values must stay unknown. */
  sampleResources?(ref: ExecutionRef, policy: ExecutionPolicy): Promise<ResourceSample>;
}
