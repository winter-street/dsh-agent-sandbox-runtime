import { createServer, type Server } from 'node:net';
import { OpenSandboxAdapter } from '../../src/adapters/opensandbox/index.js';
import type { ExecutionRef, SandboxPort } from '../../src/contracts/sandbox.js';

/** Disconnect only one test-owned status query; all other operations use the real service. */
export async function disconnectedStatusOnce(domain: string, apiKey: string): Promise<{
  sandbox: SandboxPort;
  observations: { injected: number; disconnectedConnections: number; state?: string };
  close: () => Promise<void>;
}> {
  const observations: { injected: number; disconnectedConnections: number; state?: string } = { injected: 0, disconnectedConnections: 0 };
  const server: Server = createServer(socket => { observations.disconnectedConnections++; socket.destroy(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fault endpoint has no TCP address');
  const connection = { apiKey, disableMetrics: true, useServerProxy: true };
  const real = new OpenSandboxAdapter({ connection: { ...connection, domain, requestTimeoutSeconds: 60 }, pollIntervalMs: 150, cancelTimeoutMs: 10000 });
  const disconnected = new OpenSandboxAdapter({ connection: { ...connection, domain: 'http://127.0.0.1:' + address.port, requestTimeoutSeconds: 2 }, pollIntervalMs: 150, cancelTimeoutMs: 10000 });
  const sandbox: SandboxPort = {
    create: real.create.bind(real), execute: real.execute.bind(real), cancel: real.cancel.bind(real),
    collect: real.collect.bind(real), destroy: real.destroy.bind(real), sampleResources: real.sampleResources.bind(real),
    async inspect(ref: ExecutionRef) {
      if (observations.injected === 0) {
        observations.injected++;
        const status = await disconnected.inspect(ref);
        observations.state = status.state;
        return status;
      }
      return real.inspect(ref);
    },
  };
  return { sandbox, observations, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
