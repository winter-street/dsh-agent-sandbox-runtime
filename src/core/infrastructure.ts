import { RuntimeError, type FailureEvidence } from '../contracts/runtime.js';

export interface InfrastructureCircuitOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

export interface InfrastructureCircuitSnapshot {
  state: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  openedAt: number | null;
  retryAt: number | null;
  lastFailure?: FailureEvidence;
}

/** Host-local breaker. It prevents an unavailable sandbox from causing a model retry storm. */
export class InfrastructureCircuit {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private lastFailure: FailureEvidence | undefined;

  constructor(options: InfrastructureCircuitOptions = {}) {
    this.threshold = options.failureThreshold ?? 1;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.threshold) || this.threshold < 1) throw new TypeError('failureThreshold must be a positive safe integer');
    if (!Number.isSafeInteger(this.cooldownMs) || this.cooldownMs < 1) throw new TypeError('cooldownMs must be a positive safe integer');
  }

  snapshot(): InfrastructureCircuitSnapshot {
    const state = this.state();
    return {
      state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      retryAt: this.openedAt === null ? null : this.openedAt + this.cooldownMs,
      ...(this.lastFailure ? { lastFailure: structuredClone(this.lastFailure) } : {}),
    };
  }

  private state(): InfrastructureCircuitSnapshot['state'] {
    if (this.openedAt === null) return 'closed';
    return this.now() >= this.openedAt + this.cooldownMs ? 'half-open' : 'open';
  }

  assertAvailable(): void {
    if (this.state() === 'open') {
      const failure = this.lastFailure;
      throw new RuntimeError('SANDBOX_UNAVAILABLE', failure?.message ?? 'Sandbox infrastructure circuit is open', {
        phase: failure?.phase ?? 'sandbox.preflight', retryable: true, ...(failure?.causeRef ? { causeRef: failure.causeRef } : {}),
      });
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.lastFailure = undefined;
  }

  recordFailure(failure: FailureEvidence): InfrastructureCircuitSnapshot {
    this.consecutiveFailures += 1;
    this.lastFailure = structuredClone(failure);
    if (this.consecutiveFailures >= this.threshold) this.openedAt = this.now();
    return this.snapshot();
  }
}

interface ErrorSignals { codes: string[]; messages: string[] }

/** OpenSandbox wraps service errors under `error`/`cause`; inspect only bounded diagnostic fields. */
function errorSignals(error: unknown): ErrorSignals {
  const codes: string[] = []; const messages: string[] = [];
  const queue: unknown[] = [error]; const seen = new Set<object>();
  while (queue.length && seen.size < 16) {
    const current = queue.shift();
    if (current instanceof Error && current.message) messages.push(current.message);
    if (!current || typeof current !== 'object') { if (typeof current === 'string') messages.push(current); continue; }
    if (seen.has(current)) continue; seen.add(current);
    const value = current as Record<string, unknown>;
    for (const key of ['code', 'message']) {
      const item = value[key];
      if (typeof item === 'string' && item) (key === 'code' ? codes : messages).push(item);
    }
    for (const key of ['error', 'cause', 'details']) if (value[key] && typeof value[key] === 'object') queue.push(value[key]);
  }
  return { codes, messages };
}

export function failureEvidence(error: unknown, phase: string, observedAt = Date.now()): FailureEvidence {
  const signals = errorSignals(error);
  const explicitCode = signals.codes.find(code => /^(?:DOCKER::|SANDBOX_|ECONN|ENOTFOUND|EAI_AGAIN)/i.test(code))
    ?? signals.codes.find(code => code.trim()) ?? '';
  const searchable = [...signals.codes, ...signals.messages].join(' ');
  const rawCode = explicitCode || /DOCKER::[A-Z0-9_-]+/i.exec(searchable)?.[0] || 'INFRASTRUCTURE_UNAVAILABLE';
  const message = (signals.messages.find(value => value.trim()) ?? String(error)).replace(/[\r\n\t]+/g, ' ').slice(0, 512) || 'Sandbox infrastructure failure';
  return { code: rawCode.slice(0, 128), phase, retryable: true, message, observedAt };
}

/** Classify only failures that indicate the host or sandbox service is unavailable. */
export function isInfrastructureFailure(error: unknown): boolean {
  const signals = errorSignals(error);
  return /SANDBOX_(?:CREATE_FAILED|UNAVAILABLE)|DOCKER::|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|sidecar container failed|fetch failed|service unavailable/i.test([...signals.codes, ...signals.messages].join(' '));
}
