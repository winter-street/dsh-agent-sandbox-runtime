import { randomUUID } from 'node:crypto';
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { BudgetControlPort } from '../contracts/budget.js';
import { normalizeUsage } from '../contracts/budget.js';
import type { MeteredSummaryPort, SummaryRequest } from './summarizer.js';

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    /** Runtime context summaries reuse the host's declared compaction purpose. */
    compaction: true;
  }
}

/** Shared by dispatch and full translated-request token counting. */
export function harnessSummaryRequest(provider: string, model: string, request: Pick<SummaryRequest, 'sessionId' | 'system' | 'sourceJson' | 'maxOutputTokens' | 'signal'>): GenerateOptions {
  return {
    provider, model, sessionId: SessionId(request.sessionId), purpose: 'compaction', system: request.system,
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: request.sourceJson }] })],
    maxTokens: request.maxOutputTokens, ...(request.signal ? { signal: request.signal } : {}),
  };
}

/** Uses the installed budget plugin's stream hook; it never writes a second reservation. */
export function createHarnessSummaryPort(input: {
  ctx: Context;
  budget: BudgetControlPort;
  provider: string;
  model: string;
}): MeteredSummaryPort {
  return {
    async summarize(request: SummaryRequest) {
      if (await input.budget.scopeForSession(request.sessionId, { create: false }) !== request.scopeKey) throw new Error('Summary budget binding mismatch');
      const before = await input.budget.snapshot(request.scopeKey);
      let text = '';
      let usage: Extract<StreamChunk, { type: 'usage' }>['usage'] | undefined;
      let stopped = false;
      const modelCallId = randomUUID();
      await input.budget.withPurpose(request.sessionId, 'work', () => input.budget.withCallIdentity(request.sessionId, modelCallId, async () => {
        for await (const chunk of input.ctx.llm.stream(harnessSummaryRequest(input.provider, input.model, request))) {
          if (chunk.type === 'text-delta') text += chunk.text;
          if (chunk.type === 'usage') usage = chunk.usage;
          if (chunk.type === 'finish') stopped = chunk.reason.kind === 'stop';
        }
      }));
      if (!stopped || !usage) throw new Error('Summary did not finish with verified usage');
      const receipts = await input.budget.eventsAfter(before.ledgerSeq);
      const candidates = receipts.filter(event => event.scopeKey === request.scopeKey && event.type === 'reserve'
        && typeof event.payload.request === 'object' && event.payload.request !== null
        && (event.payload.request as Record<string, unknown>).sessionId === request.sessionId
        && (event.payload.request as Record<string, unknown>).modelCallId === modelCallId);
      // Ambiguous concurrency cannot be silently attributed to this summary.
      if (candidates.length !== 1) throw new Error('Cannot uniquely correlate summary reservation');
      const reservationId = candidates[0]!.payload.reservationId;
      if (typeof reservationId !== 'string') throw new Error('Missing summary reservation identity');
      const receipt = receipts.find(event => event.scopeKey === request.scopeKey && event.type === 'settle' && event.payload.reservationId === reservationId);
      if (!receipt) throw new Error('Summary has no settled ledger event');
      return { text, usage: normalizeUsage(usage), receipt: { eventId: receipt.eventId, reservationId, scopeKey: request.scopeKey } };
    },
  };
}
