import type { Context } from '@deepseek-ai/cordis';
import type { BudgetControlPort, BudgetPort } from '../../contracts/budget.js';

export type BudgetReader = Pick<BudgetPort, 'snapshot' | 'eventsAfter'> & {
  scopeForSession(sessionId: string): ReturnType<BudgetPort['scopeForSession']>;
};
export type BudgetOperator = Pick<BudgetControlPort, 'allocate' | 'withPurpose' | 'withCallIdentity'>;
export interface BudgetBridge {
  /** Runtime integration; automatic stream hooks already own reservation writes. */
  port: BudgetPort;
  /** Trusted composition/operations only. Never register it as model tools. */
  operator: BudgetOperator;
  control: BudgetControlPort;
  /** Lookup never opens a new scope or grants fresh credit. */
  reader: BudgetReader;
}

const requiredMethods: Array<keyof BudgetControlPort> = [
  'scopeForSession', 'snapshot', 'reserve', 'markDispatched', 'settle',
  'releaseUnsent', 'markUnknown', 'eventsAfter', 'allocate', 'withPurpose', 'withCallIdentity',
];

/** Resolve the plugin service; no import from its checkout and no duplicate ledger. */
export function connectBudgetService(ctx: Pick<Context, 'get'>): BudgetBridge {
  const candidate: unknown = ctx.get('agentBudget');
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('Budget plugin service is unavailable; install the pinned reservation patch and await plugin activation');
  }
  const object = candidate as Record<string, unknown>;
  for (const method of requiredMethods) {
    if (typeof object[method] !== 'function') throw new Error(`Budget plugin service is incompatible: missing ${method}`);
  }
  const service = candidate as BudgetControlPort;
  const port: BudgetPort = Object.freeze({
    scopeForSession: service.scopeForSession.bind(service),
    snapshot: service.snapshot.bind(service),
    reserve: service.reserve.bind(service),
    markDispatched: service.markDispatched.bind(service),
    settle: service.settle.bind(service),
    releaseUnsent: service.releaseUnsent.bind(service),
    markUnknown: service.markUnknown.bind(service),
    eventsAfter: service.eventsAfter.bind(service),
  });
  const operator: BudgetOperator = Object.freeze({
    allocate: service.allocate.bind(service), withPurpose: service.withPurpose.bind(service),
    withCallIdentity: service.withCallIdentity.bind(service),
  });
  const reader: BudgetReader = Object.freeze({
    scopeForSession: (sessionId: string) => port.scopeForSession(sessionId, { create: false }),
    snapshot: port.snapshot, eventsAfter: port.eventsAfter,
  });
  return { port, operator, control: Object.freeze({ ...port, ...operator }), reader };
}
