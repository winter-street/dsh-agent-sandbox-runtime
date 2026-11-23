import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { createUserMessage, type ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session';
import SessionProjection from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as ToolExecutorNative from '@deepseek-ai/dsh-tool-executor-native';
import { ArtifactStore } from '../../src/artifacts/index.js';
import type { BudgetBridge } from '../../src/adapters/budget/index.js';
import { Config, createPluginRuntime, type Config as PluginConfig } from '../../src/plugin/index.js';
import { RuntimeStore } from '../../src/storage/index.js';
import { FakeBudget, FakeSandbox } from '../support/fakes.js';

export interface PluginTestHost {
  ctx: Context;
  store: RuntimeStore;
  artifacts: ArtifactStore;
  sandbox: FakeSandbox;
  budget: FakeBudget;
  config: PluginConfig;
  service: Awaited<ReturnType<typeof createPluginRuntime>>['service'];
  directory: string;
  root: Awaited<ReturnType<Context['agents']['create']>>;
  say(text: string): UserMessage;
  sayContent(content: UserMessage['content']): UserMessage;
  sayChild(text: string): UserMessage;
  child(): Promise<Awaited<ReturnType<Context['agents']['create']>>>;
  call(code?: string, agent?: Awaited<ReturnType<Context['agents']['create']>>, signal?: AbortSignal): Promise<{ isError: boolean; value?: unknown }>;
  dispose(): Promise<void>;
}

/** Mounts the real plugin host with fake sandbox/budget and a temporary durable store. */
export async function createPluginTestHost(options: {
  config?: Record<string, unknown>;
  sandbox?: FakeSandbox;
  budget?: FakeBudget;
  attachments?: unknown;
  approval?: unknown;
  directory?: string;
} = {}): Promise<PluginTestHost> {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'plugin-host-'));
  const ctx = new Context();
  await ctx.plugin(LlmRuntime).await();
  await ctx.plugin(SessionStore).await();
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(SessionProjection).await();
  await ctx.plugin(ToolRuntime).await();
  await ctx.plugin(ToolExecutorNative).await();
  await ctx.plugin(AgentRegistry).await();
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }).await();
  const sandbox = options.sandbox ?? new FakeSandbox();
  const budget = options.budget ?? new FakeBudget({ scopeKey: 'scope-root', sessionIds: ['root-session'] });
  const store = new RuntimeStore(join(directory, 'database'));
  const artifacts = new ArtifactStore(join(directory, 'artifacts'));
  const bridge: BudgetBridge = { port: budget, control: budget, operator: budget, reader: budget };
  const config = { ...(Config({ dataDir: directory } as never) as PluginConfig), ...options.config } as PluginConfig;
  if (options.attachments !== undefined) ctx.provide('attachments', options.attachments);
  if (options.approval !== undefined) ctx.provide('approval', options.approval);
  const runtime = await createPluginRuntime(ctx, config, { sandbox, store, artifacts, budget: bridge, dataDir: directory });
  const root = await ctx.agents.create({ sessionId: SessionId('root-session'), agentOptions: { provider: 'unused', model: 'unused' } });
  let childHandle: Awaited<ReturnType<Context['agents']['create']>> | undefined;
  let childSession: Session | undefined;
  function say(text: string): UserMessage {
    return sayContent([{ type: 'text', text }]);
  }
  function sayContent(content: UserMessage['content']): UserMessage {
    const message = createUserMessage({ source: { kind: 'user' }, content });
    root.agent.session.append('user/message', message, { surfaceOp: 'append' });
    return message;
  }
  function sayChild(text: string): UserMessage {
    if (!childSession) throw new Error('Create the child agent first');
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
    childSession.append('user/message', message, { surfaceOp: 'append' });
    return message;
  }
  async function child() {
    if (!childHandle) {
      childHandle = await root.agent.ctx.agents.create({
        sessionId: SessionId('child-session'),
        meta: { parentSession: root.agent.session.id, origin: 'subagent', delegationDepth: 1 },
        agentOptions: { provider: 'unused', model: 'unused' },
      });
      childSession = childHandle.agent.session;
      childHandle.agent.session.append('user/message', createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: 'child task' }],
      }), { surfaceOp: 'append' });
    }
    return childHandle;
  }
  async function call(code = 'print(1)', agent = root, signal = new AbortController().signal) {
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: `call-${Math.random().toString(16).slice(2)}` as ToolCallId, name: 'runtime_python', arguments: JSON.stringify({ code }) }],
      agent: agent.agent, signal,
    });
    return batch.results[0]!.result as { isError: boolean; value?: unknown };
  }
  async function dispose() {
    await ctx.fiber.dispose();
    try { store.close(); } catch { /* the plugin effect already closed it */ }
  }
  return { ctx, store, artifacts, sandbox, budget, config, service: runtime.service, directory, root, say, sayContent, sayChild, child, call, dispose };
}
