import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopHost, buildDesktopHost } from '../src/desktop/host.js';
import { guestExec } from '../src/desktop/qemu.js';

// Opt-in real KVM test, independent of model credits and the running service.
// Only the random session/data directory created here is removed.
await mkdir('.data/desktop-tests', { recursive: true });
const root = await mkdtemp(resolve('.data/desktop-tests/contract-'));
const runtime = await mkdtemp(join(tmpdir(), 'pi-hcu-test-'));
const id = 'ses_' + randomUUID();
const token = randomUUID();
const host = new DesktopHost({ root, runtime, token, maxVMs: 1,
  base: resolve(process.env.DESKTOP_BASE_IMAGE ?? '.data/desktop/ubuntu-hcu.qcow2') });
let app: ReturnType<typeof buildDesktopHost> | undefined;
let initialized = false;
const started = Date.now();
try {
  await host.init(); initialized = true;
  app = buildDesktopHost(host);
  assert.equal((await app.inject({ url: '/healthz' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/healthz', headers: { authorization: 'Bearer ' + token } })).statusCode, 200);
  await host.close(id, 1);
  await assert.rejects(host.open(id, 'contract', 1, false), /fenced/);
  await host.open(id, 'contract', 2, false);
  await assert.rejects(host.status(id, 'other-workspace'), /not found/);
  const shot = await host.tool(id, 'contract', 2, 'GUI', { actions: [{ type: 'screenshot' }] });
  assert(!shot.isError, shot.text);
  assert.equal(shot.images?.length, 1);
  assert(Buffer.from(shot.images![0]!.data, 'base64').length > 1000);
  const apps = await host.tool(id, 'contract', 2, 'AX', { mode: 'apps' });
  assert(!apps.isError, apps.text);
  await host.tool(id, 'contract', 2, 'write_file', { path: 'retained.txt', content: 'persistent desktop' });

  const pending = host.tool(id, 'contract', 2, 'bash', {
    command: 'touch /workspace/started; sleep 15; echo late > /workspace/outputs/late.txt',
  }).then(value => ({ value }), error => ({ error }));
  // Establish that the process actually started before exercising cancellation.
  const qga = join(runtime, id.slice(4), 'qga.sock');
  const deadline = Date.now() + 10_000;
  while (true) {
    try { await guestExec(qga, '/usr/bin/test', ['-f', '/workspace/started']); break; }
    catch (error) { if (Date.now() > deadline) throw error; await delay(100); }
  }
  const cancelledAt = Date.now();
  await host.close(id, 2);
  const cancellationMs = Date.now() - cancelledAt;
  assert('error' in await pending, 'Cancelled input must not be reported successful');
  assert.equal((await host.status(id, 'contract')).state, 'paused');
  assert((await host.frame(id, 'contract')).length > 1000, 'A final preview survives pause');
  await assert.rejects(host.open(id, 'contract', 2, true), /fenced|closed/);
  await host.open(id, 'contract', 3, true);
  await assert.rejects(host.tool(id, 'contract', 2, 'GUI', { actions: [{ type: 'screenshot' }] }), /ownership changed/);
  await host.close(id, 2); // A delayed old cancellation must not stop the new run.
  assert.equal((await host.status(id, 'contract')).state, 'running');
  const retained = await host.tool(id, 'contract', 3, 'read_file', { path: 'retained.txt' });
  assert.equal(retained.text, 'persistent desktop');
  const noLateWrite = await host.tool(id, 'contract', 3, 'bash', { command: 'test ! -e /workspace/outputs/late.txt' });
  assert(!noLateWrite.isError, 'Cancelled process must not keep running after resume');
  await host.close(id, 3);
  await host.destroy(id);
  assert.equal((await host.status(id, 'contract')).state, 'not_started');
  await writeFile('.data/desktop-tests/latest.json', JSON.stringify({ verified_at: new Date().toISOString(),
    elapsed_ms: Date.now() - started, cancellation_ms: cancellationMs,
    checks: ['host authentication', 'tenant isolation', 'pre-open fencing', 'real HCU screenshots and accessibility',
      'in-flight cancellation', 'paused preview', 'persistent workspace', 'stale input rejection', 'old-fence isolation', 'VM deletion'] }, null, 2));
  console.log(`PASS: real KVM/HCU lifecycle and fencing; cancellation settled in ${cancellationMs} ms.`);
} finally {
  if (initialized) {
    await host.destroy(id);
    await host.shutdown();
  }
  await app?.close();
  await rm(root, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
}
