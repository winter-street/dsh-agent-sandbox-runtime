import { describe, expect, it, vi } from 'vitest';
import type { EvaluationRuntimeHost } from '../../src/app/index.js';
import { waitAfterApproval, waitForControllerIdle } from '../../spikes/n04/wait-approved.js';

describe('N04 approval wait', () => {
  it('waits through an approved but not yet scheduled pause', async () => {
    const paused = { status: 'PAUSED_APPROVAL', host: { active: false, recoveryRequired: false } };
    const done = { status: 'SUCCEEDED', host: { active: false, recoveryRequired: false } };
    const wait = vi.fn().mockResolvedValueOnce(paused).mockResolvedValueOnce(done);
    const host = { wait, service: { approvals: { list: () => [{ approvalId: 'approval', status: 'approved' }] } } } as unknown as EvaluationRuntimeHost;
    expect(await waitAfterApproval(host, 'run', 'approval', Date.now() + 1000)).toEqual(done);
    expect(wait).toHaveBeenCalledTimes(2);
  });
  it('returns a recovery block without waiting for the deadline', async () => {
    const blocked = { status: 'RECOVERY_REQUIRED', host: { active: false, recoveryRequired: true } };
    const host = { wait: vi.fn().mockResolvedValue(blocked) } as unknown as EvaluationRuntimeHost;
    expect(await waitAfterApproval(host, 'run', 'approval', Date.now() + 1000)).toEqual(blocked);
  });
  it('waits for the controller rather than unresolved remote work', async () => {
    const blocked = { status: 'RECOVERY_REQUIRED', host: { active: true, recoveryRequired: true } };
    const host = { isExecuting: vi.fn().mockReturnValueOnce(true).mockReturnValue(false), get: vi.fn().mockResolvedValue(blocked) } as unknown as EvaluationRuntimeHost;
    expect(await waitForControllerIdle(host, 'run', Date.now() + 1000)).toEqual(blocked);
    expect(host.get).toHaveBeenCalledOnce();
  });
  it('fails when the controller remains active at the deadline', async () => {
    const host = { isExecuting: () => true } as unknown as EvaluationRuntimeHost;
    await expect(waitForControllerIdle(host, 'run', Date.now())).rejects.toThrow('Local controller did not stop');
  });
});
