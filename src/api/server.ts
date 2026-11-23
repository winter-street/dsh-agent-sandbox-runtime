import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { RuntimeError, RunInputSchema } from '../contracts/runtime.js';
import type { RuntimeService } from '../core/service.js';
import { readFile } from 'node:fs/promises';
import {
  eventFrame,
  MAX_EVENT_BYTES_PER_FLUSH,
  MAX_EVENT_FRAME_BYTES,
  DEFAULT_EVENT_RATE_LIMIT_BYTES,
  DEFAULT_EVENT_RATE_LIMIT_WINDOW_MS,
} from './events.js';

export interface RuntimeServerOptions {
  token: string;
  allowedOrigin?: string;
  eventPollMs?: number;
  eventRateLimitBytesPerWindow?: number;
  eventRateLimitWindowMs?: number;
  maxBodyBytes?: number;
  client?: boolean;
  createTask?: (task: string) => Promise<unknown>;
  control?: {
    pause?: (runId: string, commandId: string, reason: string) => Promise<unknown>;
    resume?: (runId: string, commandId: string, expectedRevision: number) => Promise<unknown>;
    cancel?: (runId: string, commandId: string, reason: string) => Promise<unknown>;
    decideApproval?: (runId: string, approvalId: string, decisionId: string, approved: boolean) => Promise<unknown>;
  };
}
function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7)); const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new RuntimeError('INVALID_INPUT', 'Request body exceeds limit');
    parts.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown; }
  catch { throw new RuntimeError('INVALID_INPUT', 'Request body must be JSON'); }
}
const cancelSchema = z.strictObject({ commandId: z.string().min(1).max(128), reason: z.string().min(1).max(1024) });
const resumeSchema = z.strictObject({ commandId: z.string().min(1).max(128), expectedRevision: z.int().nonnegative() });
const pauseSchema = z.strictObject({ commandId: z.string().min(1).max(128), reason: z.string().min(1).max(1024) });
const approvalSchema = z.strictObject({ decisionId: z.string().min(1).max(96), approved: z.boolean() });

/** Local control surface; caller must bind to loopback, not a public interface. */
export function createRuntimeServer(service: RuntimeService, options: RuntimeServerOptions): Server {
  if (options.token.length < 24) throw new TypeError('API bearer token must contain at least 24 characters');
  if (options.allowedOrigin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(options.allowedOrigin)) throw new TypeError('Only a local UI origin is supported');
  const eventRateLimitBytesPerWindow = options.eventRateLimitBytesPerWindow ?? DEFAULT_EVENT_RATE_LIMIT_BYTES;
  const eventRateLimitWindowMs = options.eventRateLimitWindowMs ?? DEFAULT_EVENT_RATE_LIMIT_WINDOW_MS;
  if (!Number.isSafeInteger(eventRateLimitBytesPerWindow) || eventRateLimitBytesPerWindow < MAX_EVENT_FRAME_BYTES) {
    throw new TypeError(`eventRateLimitBytesPerWindow must be a safe integer >= ${MAX_EVENT_FRAME_BYTES}`);
  }
  if (!Number.isSafeInteger(eventRateLimitWindowMs) || eventRateLimitWindowMs <= 0) {
    throw new TypeError('eventRateLimitWindowMs must be a positive safe integer');
  }
  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof z.ZodError) { send(response, 400, { code: 'INVALID_INPUT', message: 'Request does not match schema' }); return; }
      if (error instanceof RuntimeError) {
        const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_INPUT' ? 400 : 409;
        send(response, status, { code: error.code, message: error.message, ...error.details }); return;
      }
      send(response, 500, { code: 'INTERNAL_ERROR', message: 'Operation failed; inspect the local runtime trace' });
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const localAddress = request.socket.localAddress;
    const localHost = localAddress === '::1' ? '[::1]' : localAddress?.replace(/^::ffff:/, '');
    const sameOrigin = request.headers.origin === `http://${localHost}:${request.socket.localPort}`;
    if (request.headers.origin && request.headers.origin !== options.allowedOrigin && !sameOrigin) { send(response, 403, { code: 'ORIGIN_DENIED' }); return; }
    if (request.headers.origin && options.allowedOrigin) {
      response.setHeader('Access-Control-Allow-Origin', options.allowedOrigin);
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,Last-Event-ID' }); response.end(); return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.search) throw new RuntimeError('INVALID_INPUT', 'Query parameters are not accepted');
    if (options.client && request.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
      const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const content = await readFile(new URL(`../client/${filename}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'", 'Cache-Control': 'no-store' });
      response.end(content); return;
    }
    if (!authorized(request, options.token)) { send(response, 401, { code: 'UNAUTHORIZED' }); return; }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'tasks' && parts.length === 1 && request.method === 'POST' && options.createTask) {
      const input = z.strictObject({ task: z.string().min(1).max(100000) }).parse(await body(request, options.maxBodyBytes ?? 256000));
      send(response, 202, await options.createTask(input.task)); return;
    }
    if (parts[0] !== 'runs') { send(response, 404, { code: 'NOT_FOUND' }); return; }
    if (request.method === 'GET' && parts.length === 1) { send(response, 200, service.store.listRuns()); return; }
    if (request.method === 'POST' && parts.length === 1) {
      send(response, 201, await service.createRun(RunInputSchema.parse(await body(request, options.maxBodyBytes ?? 256_000)))); return;
    }
    const runId = parts[1];
    if (!runId) { send(response, 404, { code: 'NOT_FOUND' }); return; }
    service.store.getRun(runId);
    if (request.method === 'GET' && parts.length === 2) { send(response, 200, await service.getRun(runId)); return; }
    if (request.method === 'POST' && parts.length === 3 && parts[2] === 'cancel') {
      const input = cancelSchema.parse(await body(request, options.maxBodyBytes ?? 256_000));
      send(response, 200, await (options.control?.cancel
        ? options.control.cancel(runId, input.commandId, input.reason)
        : service.cancelRun(runId, input.commandId, { reason: input.reason }))); return;
    }
    if (request.method === 'POST' && parts.length === 3 && parts[2] === 'pause') {
      const input = pauseSchema.parse(await body(request, options.maxBodyBytes ?? 256_000));
      send(response, 200, await (options.control?.pause
        ? options.control.pause(runId, input.commandId, input.reason)
        : service.pauseRun(runId, input.commandId, { reason: input.reason }))); return;
    }
    if (request.method === 'POST' && parts.length === 3 && parts[2] === 'resume') {
      const input = resumeSchema.parse(await body(request, options.maxBodyBytes ?? 256_000));
      send(response, 200, await (options.control?.resume
        ? options.control.resume(runId, input.commandId, input.expectedRevision)
        : service.resumeRun(runId, input.commandId, input.expectedRevision))); return;
    }
    if (request.method === 'POST' && parts.length === 4 && parts[2] === 'approvals') {
      const input = approvalSchema.parse(await body(request, options.maxBodyBytes ?? 256000));
      send(response, 200, await (options.control?.decideApproval
        ? options.control.decideApproval(runId, parts[3]!, input.decisionId, input.approved)
        : service.approvals.decide(runId, parts[3]!, input.decisionId, input.approved))); return;
    }
    if (request.method === 'GET' && parts.length === 4 && parts[2] === 'artifacts') {
      const record = service.store.listArtifacts(runId).find(a => a.artifactId === parts[3]);
      if (!record) throw new RuntimeError('NOT_FOUND', 'Committed artifact not found in this run');
      const content = await service.artifacts.read(record);
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': content.byteLength,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.path.split('/').at(-1)!)}`, 'Cache-Control': 'no-store' });
      response.end(content); return;
    }
    if (request.method === 'GET' && parts.length === 3 && parts[2] === 'events') {
      const value = request.headers['last-event-id'];
      if (value !== undefined && (Array.isArray(value) || !/^\d+$/.test(value))) throw new RuntimeError('INVALID_INPUT', 'Last-Event-ID must be a nonnegative integer');
      let cursor = Number(value ?? 0);
      if (!Number.isSafeInteger(cursor)) throw new RuntimeError('INVALID_INPUT', 'Event cursor is too large');
      const latest = service.store.latestEventSeq(runId);
      if (cursor > latest) { send(response, 409, { code: 'RESYNC_REQUIRED', lastEventSeq: latest }); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', 'Connection': 'keep-alive' });
      let stopped = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      let windowStart = Date.now();
      let windowBytes = 0;
      let rateLimitedUntil = 0;
      const stop = () => { stopped = true; if (timer) { clearInterval(timer); timer = undefined; } };
      const writable = () => !stopped && !response.destroyed && !response.writableEnded;
      // Register cleanup before the first write: even initial replay may end the stream.
      response.once('close', stop);
      response.once('finish', stop);
      response.once('error', stop);
      const write = (frame: string): boolean => {
        if (!writable()) { stop(); return false; }
        if (response.write(frame)) return true;
        // write(false) accepted this frame. End only this observer; reconnect uses
        // the last fully parsed event ID, so an incomplete frame is replayed.
        stop(); response.end(); return false;
      };
      const flush = (): boolean => {
        if (!writable()) { stop(); return false; }
        const now = Date.now();
        if (now < rateLimitedUntil) return true;
        if (now >= windowStart + eventRateLimitWindowMs) {
          windowStart = now;
          windowBytes = 0;
          rateLimitedUntil = 0;
        }
        let bytes = 0;
        for (const event of service.store.eventsAfter(runId, cursor, 64)) {
          const encoded = eventFrame(event);
          if (windowBytes + encoded.bytes > eventRateLimitBytesPerWindow) {
            rateLimitedUntil = windowStart + eventRateLimitWindowMs;
            break;
          }
          if (bytes + encoded.bytes > MAX_EVENT_BYTES_PER_FLUSH) break;
          if (!write(encoded.frame)) return false;
          bytes += encoded.bytes;
          windowBytes += encoded.bytes;
          cursor = event.eventSeq;
        }
        return writable();
      };
      if (!write(': connected\n\n') || !flush()) return;
      timer = setInterval(() => { try { flush(); } catch { stop(); response.destroy(); } }, options.eventPollMs ?? 250);
      timer.unref();
      return;
    }
    send(response, 404, { code: 'NOT_FOUND' });
  }
  return server;
}
