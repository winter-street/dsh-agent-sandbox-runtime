import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxInput } from '../../src/contracts/sandbox.js';
import { createPluginTestHost, type PluginTestHost } from './helpers.js';

const hosts: PluginTestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0).reverse()) await host.dispose(); });
async function host(options: Parameters<typeof createPluginTestHost>[0] = {}): Promise<PluginTestHost> {
  const created = await createPluginTestHost(options);
  hosts.push(created);
  return created;
}
function fileRef(id: string, name: string, bytes: number): FileAttachmentRef {
  return { attachmentId: id, name, bytes } as FileAttachmentRef;
}
function imageRef(id: string, bytes: number): ImageAttachmentRef {
  return { attachmentId: id, mediaType: 'image/png', bytes, width: 1, height: 1 } as ImageAttachmentRef;
}
function attachments(files: Record<string, string | Uint8Array>, images: Record<string, Uint8Array> = {}) {
  return {
    readFileStream(ref: FileAttachmentRef) {
      const value = files[ref.attachmentId];
      if (value === undefined) throw new Error('missing fake file');
      const bytes = typeof value === 'string' ? Buffer.from(value) : value;
      return (async function* () { yield bytes; })();
    },
    async readImage(ref: ImageAttachmentRef) {
      const value = images[ref.attachmentId];
      if (value === undefined) throw new Error('missing fake image');
      return { data: value };
    },
  };
}
function executedInputs(h: PluginTestHost): SandboxInput[] {
  const call = h.sandbox.calls.find(entry => entry.method === 'execute');
  expect(call).toBeDefined();
  return (call!.args[0] as { inputs: SandboxInput[] }).inputs;
}

describe('plugin session attachments', () => {
  it('passes a file attachment into the sandbox input directory', async () => {
    const h = await host({ attachments: attachments({ f1: 'alert_id,device_id\nA01,D01\n' }) });
    h.sayContent([
      { type: 'text', text: 'use the attached csv' },
      { type: 'file', attachment: fileRef('f1', 'input.csv', 24) },
    ]);
    await h.call('print(1)');
    const inputs = executedInputs(h);
    const input = inputs.find(item => item.path === 'input.csv');
    expect(input).toBeDefined();
    expect(Buffer.from(input!.content).toString('utf8')).toContain('A01,D01');
    const run = h.store.listRuns()[0]!;
    const stored = h.store.getComponentState<{ files: Array<{ path: string }> }>(run.runId, 'plugin', 'inputs');
    expect(stored?.files.map(file => file.path)).toEqual(['input.csv']);
  });

  it('uses a sanitized image name and the image bytes', async () => {
    const h = await host({ attachments: attachments({}, { i1: Uint8Array.from([1, 2, 3]) }) });
    h.sayContent([{ type: 'image', attachment: imageRef('i1', 3) }]);
    await h.call('print(1)');
    const input = executedInputs(h).find(item => item.path === 'image-1.png');
    expect(input).toBeDefined();
    expect([...input!.content]).toEqual([1, 2, 3]);
  });

  it('renames duplicate attachment names', async () => {
    const h = await host({ attachments: attachments({ a: 'one', b: 'two' }) });
    h.sayContent([
      { type: 'file', attachment: fileRef('a', 'same.csv', 3) },
      { type: 'file', attachment: fileRef('b', 'same.csv', 3) },
    ]);
    await h.call('print(1)');
    expect(executedInputs(h).map(input => input.path)).toEqual(['same.csv', 'same-2.csv']);
  });

  it('fails before creating a run when an attachment exceeds the byte limit', async () => {
    const h = await host({
      attachments: attachments({ f1: '12345' }),
      config: { inputLimits: { maxFiles: 4, maxBytesPerFile: 4, maxTotalBytes: 8 } },
    });
    h.sayContent([{ type: 'file', attachment: fileRef('f1', 'input.csv', 5) }]);
    const outcome = await h.call('print(1)');
    expect(outcome.isError).toBe(true);
    expect(h.store.listRuns()).toHaveLength(0);
    expect(h.sandbox.calls.some(call => call.method === 'create')).toBe(false);
  });

  it('fails when a session attachment exists but the attachments service is absent', async () => {
    const h = await host();
    h.sayContent([{ type: 'file', attachment: fileRef('f1', 'input.csv', 3) }]);
    const outcome = await h.call('print(1)');
    expect(outcome.isError).toBe(true);
    expect(h.store.listRuns()).toHaveLength(0);
  });

  it('rejects a collision with a configured input', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'plugin-input-'));
    const file = join(directory, 'input.csv');
    writeFileSync(file, 'static');
    const h = await host({
      attachments: attachments({ f1: 'dynamic' }),
      config: { inputs: [{ path: 'input.csv', file }] },
    });
    h.sayContent([{ type: 'file', attachment: fileRef('f1', 'input.csv', 7) }]);
    const outcome = await h.call('print(1)');
    expect(outcome.isError).toBe(true);
    expect(h.store.listRuns()).toHaveLength(0);
  });
});
