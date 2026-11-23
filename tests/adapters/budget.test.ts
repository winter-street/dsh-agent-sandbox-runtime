import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { connectBudgetService } from '../../src/adapters/budget/index.js';
import type { BudgetControlPort, BudgetSnapshot, ReservationRequest } from '../../src/contracts/budget.js';

function service(): BudgetControlPort {
  return {
    scopeForSession: vi.fn(() => 'root'), snapshot: vi.fn(() => ({ scopeKey: 'root' }) as BudgetSnapshot),
    reserve: vi.fn(() => { throw new Error('automatic hook owns reservations'); }),
    markDispatched: vi.fn(), settle: vi.fn(), releaseUnsent: vi.fn(), markUnknown: vi.fn(),
    eventsAfter: vi.fn(() => []), allocate: vi.fn(), withPurpose: (_session, _purpose, callback) => callback(), withCallIdentity: (_session, _id, callback) => callback(),
  };
}

describe('budget service bridge', () => {
  it('resolves the real Cordis service registry and keeps readonly lookup from opening credit', async () => {
    const ctx = new Context();
    const budget = service();
    ctx.provide('agentBudget', budget);
    try {
      const bridge = connectBudgetService(ctx);
      expect(await bridge.reader.scopeForSession('child')).toBe('root');
      expect(budget.scopeForSession).toHaveBeenCalledWith('child', { create: false });
      expect(Object.keys(bridge.reader).sort()).toEqual(['eventsAfter', 'scopeForSession', 'snapshot']);
      expect('allocate' in bridge.port).toBe(false);
      expect('reset' in bridge.control).toBe(false);
      expect(budget.reserve).not.toHaveBeenCalled();
    } finally { await ctx.fiber.dispose(); }
  });

  it('binds methods to their service and preserves async trusted purpose context results', async () => {
    const ctx = new Context();
    const budget = service();
    budget.allocate = function (scope, amount) { expect(this).toBe(budget); expect([scope, amount]).toEqual(['root', 20]); };
    ctx.provide('agentBudget', budget);
    try {
      const bridge = connectBudgetService(ctx);
      bridge.operator.allocate('root', 20, 'operator selected report allocation');
      const result = await bridge.operator.withPurpose('root', 'finalize', async () => { await Promise.resolve(); return 42; });
      expect(result).toBe(42);
      const request = { modelCallId: 'call' } as ReservationRequest;
      expect(() => bridge.port.reserve(request)).toThrow('automatic hook owns reservations');
      expect(budget.reserve).toHaveBeenCalledExactlyOnceWith(request);
    } finally { await ctx.fiber.dispose(); }
  });

  it('fails clearly for absent or old plugin services', async () => {
    const ctx = new Context();
    try {
      expect(() => connectBudgetService(ctx)).toThrow('unavailable');
      ctx.provide('agentBudget', { snapshot() {} });
      expect(() => connectBudgetService(ctx)).toThrow('missing scopeForSession');
    } finally { await ctx.fiber.dispose(); }
  });
});
