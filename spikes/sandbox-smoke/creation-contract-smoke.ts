import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Sandbox, SandboxApiException, SandboxManager } from '@alibaba-group/opensandbox';

type Check = { name: string; passed: boolean; detail?: unknown };
type Report = {
  checkedAt: string;
  sdk: string;
  realServiceInvoked: boolean;
  contract: {
    createIdempotency: 'not-supported-by-client-contract' | 'observed-deduplicated' | 'observed-duplicates';
    createTermination: 'not-supported-by-server-contract';
    discovery: 'observed';
  };
  checks: Check[];
  limitations: string[];
};

const apiKey = process.env.OPEN_SANDBOX_API_KEY;
const domain = process.env.OPEN_SANDBOX_DOMAIN;
const image = process.env.OPEN_SANDBOX_IMAGE;
const outputPath = resolve(process.env.CREATION_CONTRACT_SMOKE_OUTPUT ?? '../../.runtime/sandbox-smoke/creation-contract-smoke.json');
if (!domain || !image) {
  console.error('BLOCKED: set OPEN_SANDBOX_DOMAIN and OPEN_SANDBOX_IMAGE. No sandbox was created.');
  process.exit(2);
}

const safeError = (error: unknown) => {
  const value = error instanceof Error ? error.message : String(error);
  const statusCode = error instanceof SandboxApiException ? error.statusCode : undefined;
  return { ...(statusCode === undefined ? {} : { statusCode }), message: value.replaceAll(apiKey ?? '\0', '[redacted]').slice(0, 500) };
};
const delay = (ms: number) => new Promise<void>(resolveDelay => setTimeout(resolveDelay, ms));
const connectionConfig = { domain, ...(apiKey ? { apiKey } : {}), requestTimeoutSeconds: 30, disableMetrics: true };
const metadata = { project: 'agent-runtime-contract-smoke', contractRun: `contract-${Date.now()}-${Math.random().toString(16).slice(2, 10)}` };
const createOptions = { connectionConfig, image, timeoutSeconds: 120, resource: { cpu: '1', memory: '512Mi' },
  networkPolicy: { defaultAction: 'deny' as const, egress: [] }, metadata, entrypoint: ['tail', '-f', '/dev/null'], skipHealthCheck: true };

async function listAll(manager: SandboxManager): Promise<Array<{ id: string; metadata?: Record<string, string>; status?: unknown }>> {
  const items: Array<{ id: string; metadata?: Record<string, string>; status?: unknown }> = [];
  for (let page = 1; page <= 5; page += 1) {
    const response = await manager.listSandboxInfos({ metadata, page, pageSize: 100 });
    items.push(...response.items.map(item => ({ id: item.id, metadata: item.metadata, status: item.status })));
    if (!response.pagination?.hasNextPage) break;
  }
  return items;
}

async function waitGone(manager: SandboxManager, sandboxId: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await manager.getSandboxInfo(sandboxId); }
    catch (error) {
      if (error instanceof SandboxApiException && error.statusCode === 404) return true;
      throw error;
    }
    await delay(250);
  }
  return false;
}

const checks: Check[] = [];
const createdIds = new Set<string>();
const manager = SandboxManager.create({ connectionConfig });
try {
  const first = await Sandbox.create(createOptions);
  createdIds.add(first.id);
  const second = await Sandbox.create(createOptions);
  createdIds.add(second.id);
  checks.push({ name: 'create-same-metadata', passed: first.id !== second.id, detail: {
    creationMetadata: metadata,
    firstSandboxId: first.id,
    secondSandboxId: second.id,
    observed: first.id === second.id ? 'deduplicated' : 'two distinct sandboxes',
    contractConclusion: first.id === second.id ? 'This deployment deduplicated this repeated request shape; a provider guarantee still requires documentation.' : 'Repeated metadata did not deduplicate creation.',
  } });
  await first.close();
  await second.close();

  const discovered = await listAll(manager);
  const discoveredIds = discovered.filter(item => createdIds.has(item.id)).map(item => item.id);
  checks.push({ name: 'metadata-discovery-and-pagination', passed: discoveredIds.length === createdIds.size, detail: {
    requestedMetadata: metadata,
    discoveredIds,
    expectedIds: [...createdIds],
    pagesBound: 5,
  } });

  let deleteAccepted = 0;
  let deleteSecondOutcome: unknown;
  for (const id of createdIds) {
    try { await manager.killSandbox(id); deleteAccepted += 1; } catch (error) { checks.push({ name: `delete-request-${id}`, passed: false, detail: safeError(error) }); continue; }
    try { await manager.killSandbox(id); deleteSecondOutcome = 'accepted'; }
    catch (error) { deleteSecondOutcome = safeError(error); }
    const gone = await waitGone(manager, id);
    checks.push({ name: `delete-confirmed-${id}`, passed: gone, detail: { firstDeleteAccepted: true, repeatedDelete: deleteSecondOutcome, lookupAfterDelete: gone ? 404 : 'still-visible' } });
  }
  checks.push({ name: 'delete-idempotency-observed', passed: deleteAccepted === createdIds.size, detail: { deleteAccepted, expected: createdIds.size, repeatedDelete: deleteSecondOutcome } });

  const abortMetadata = { ...metadata, contractRun: `${metadata.contractRun}-abort` };
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(new Error('client-aborted-create')), 5);
  let abortOutcome: unknown;
  let abortedSandboxId: string | undefined;
  try {
    const aborted = await Sandbox.create({ ...createOptions, metadata: abortMetadata, signal: controller.signal });
    abortedSandboxId = aborted.id;
    createdIds.add(aborted.id);
    abortOutcome = { outcome: 'create-returned-before-abort', sandboxId: aborted.id };
    await aborted.close();
  } catch (error) { abortOutcome = { outcome: 'client-aborted-or-failed', error: safeError(error) }; }
  finally { clearTimeout(abortTimer); }
  const abortMatches = (await listAll(manager)).filter(item => item.metadata?.contractRun === abortMetadata.contractRun);
  for (const item of abortMatches) createdIds.add(item.id);
  const abortFound = abortMatches.length > 0 || Boolean(abortedSandboxId);
  checks.push({ name: 'client-abort-discovery', passed: true, detail: {
    abortOutcome,
    matchingSandboxIdsAfterAbort: abortMatches.map(item => item.id),
    serverTerminationConfirmed: false,
    interpretation: abortFound ? 'A resource was observable after client cancellation and required cleanup.' : 'No matching resource was observed within the bounded list query; this does not prove server-side termination.',
  } });
  for (const item of abortMatches) {
    try { await manager.killSandbox(item.id); await waitGone(manager, item.id); } catch (error) { checks.push({ name: `abort-cleanup-${item.id}`, passed: false, detail: safeError(error) }); }
  }
} catch (error) {
  checks.push({ name: 'contract-probe', passed: false, detail: safeError(error) });
} finally {
  for (const id of createdIds) {
    try { await manager.killSandbox(id); } catch { /* cleanup is recorded by the per-resource checks */ }
    try { await waitGone(manager, id); } catch { /* preserve the primary report */ }
  }
  await manager.close();
}

const report: Report = {
  checkedAt: new Date().toISOString(),
  sdk: '1.2.1',
  realServiceInvoked: true,
  contract: {
    createIdempotency: checks.find(check => check.name === 'create-same-metadata')?.detail && (checks.find(check => check.name === 'create-same-metadata')?.detail as { observed?: string }).observed === 'deduplicated' ? 'observed-deduplicated' : 'observed-duplicates',
    createTermination: 'not-supported-by-server-contract',
    discovery: 'observed',
  },
  checks,
  limitations: [
    'Repeated metadata is not an idempotency key. A provider guarantee requires a documented creation identity and server-side behavior.',
    'Sandbox.create AbortSignal cancels the client request. The SDK exposes no server-side create-termination operation or terminal receipt.',
    'Metadata listing is bounded to five pages and is not a snapshot-consistent proof across concurrent changes.',
    'All resources found by this probe are deleted by ID and deletion is confirmed only by a subsequent 404 lookup.',
  ],
};
await mkdir(resolve(outputPath, '..'), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (checks.some(check => !check.passed)) process.exitCode = 1;
