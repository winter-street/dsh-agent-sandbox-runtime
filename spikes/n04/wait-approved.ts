import { setTimeout as delay } from 'node:timers/promises';
import { TERMINAL_RUN_STATES } from '../../src/contracts/runtime.js';
import type { EvaluationRuntimeHost } from '../../src/app/index.js';

/** Approval scheduling is asynchronous, so an inactive paused snapshot is not yet completion. */
export async function waitAfterApproval(host: EvaluationRuntimeHost, runId: string, approvalId: string, deadline: number) {
  while (Date.now() < deadline) {
    const snapshot = await host.wait(runId, { timeoutMs: Math.max(1, deadline - Date.now()) });
    if (TERMINAL_RUN_STATES.has(snapshot.status) || snapshot.host.recoveryRequired) return snapshot;
    const approval = host.service.approvals.list(runId).find(item => item.approvalId === approvalId);
    if (snapshot.status !== 'PAUSED_APPROVAL' || approval?.status !== 'approved') return snapshot;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  return host.get(runId);
}

/** Unknown remote work remains active even after the local controller has unwound. */
export async function waitForControllerIdle(host: EvaluationRuntimeHost, runId: string, deadline: number) {
  while (host.isExecuting(runId) && Date.now() < deadline) {
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  if (host.isExecuting(runId)) throw new Error('Local controller did not stop before the deadline');
  return host.get(runId);
}
