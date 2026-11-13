import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { LeaseLost } from '../src/domain.js';
import { restoreCheckpoint, saveCheckpoint } from '../src/runtime.js';
import { docker } from '../src/sandbox.js';
import { Worker } from '../src/worker.js';
import { agentConfig, fixture, modelFixture, tokenA, tokenB } from './fixture.js';

async function until(check: () => Promise<boolean>, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(25); }
  assert.fail('Condition did not become true before the deadline');
}

test('concurrent idempotent admission, validation, immutable versions, and tenant isolation', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { session, agent, environment } = await f.createSession();
  const path = `/v1/sessions/${session.id}/runs`;
  const body = { input: 'hello', when_busy: 'queue' };
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.request('POST', path, body, 'same-key')));
  assert(responses.every(response => response.statusCode === 202), responses.map(r => r.body).join('\n'));
  assert.equal(new Set(responses.map(response => response.json().id)).size, 1);
  assert.equal((await f.pool.query('SELECT count(*) FROM runs')).rows[0].count, '1');
  assert.equal((await f.request('POST', path, { ...body, input: 'different' }, 'same-key')).statusCode, 409);
  assert.equal((await f.request('POST', path, { ...body, when_busy: 'reject' })).statusCode, 409);
  assert.equal((await f.request('POST', path, { ...body, unexpected: true })).statusCode, 400);
  assert.equal((await f.app.inject({ method: 'POST', url: path, headers: { authorization: 'Bearer ' + tokenA }, payload: body })).statusCode, 400);
  const v2 = await f.request('POST', `/v1/agents/${agent.id}/versions`, { ...agentConfig, instructions: 'New revision' });
  assert.equal(v2.statusCode, 201);
  assert.equal(v2.json().version, 2);
  const runId = responses[0]!.json().id;
  for (const url of [`/v1/agents/${agent.id}`, `/v1/environment-templates/${environment.id}`, `/v1/sessions/${session.id}`,
    path + '/' + runId, `/v1/sessions/${session.id}/events`, `/v1/sessions/${session.id}/artifacts`]) {
    assert.equal((await f.request('GET', url, undefined, undefined, tokenB)).statusCode, 404, url);
  }
  assert.equal((await f.request('POST', path, body, 'same-key', tokenB)).statusCode, 404);
  assert.equal((await f.request('POST', `/v1/sessions/${session.id}/runs/${runId}/cancel`, {}, undefined, tokenB)).statusCode, 404);
  assert.equal((await f.request('POST', '/v1/sessions', { agent_version_id: agent.latest_version.id, environment_template_id: environment.id }, undefined, tokenB)).statusCode, 404);
  assert.equal((await f.request('GET', '/v1/agents', undefined, undefined, tokenB)).json().data.length, 0);
  assert.equal((await f.app.inject({ method: 'GET', url: '/v1/sessions' })).statusCode, 401);
  const job = await f.store.claim('worker', 30_000);
  assert.equal(job!.config.instructions, agentConfig.instructions);
  assert.equal(job!.id, runId);
  const snapshot = (await f.request('GET', `/v1/sessions/${session.id}`)).json();
  assert.equal(snapshot.active_run.id, runId);
  const events = (await f.request('GET', `/v1/sessions/${session.id}/events`)).json().data;
  assert.equal(events.at(-1).seq, snapshot.event_seq);
  assert.deepEqual(events.map((event: any) => event.type), ['session.created', 'input.accepted', 'run.started']);
  assert.equal((await f.request('GET', `/v1/sessions/${session.id}/events?after=9223372036854775808`)).statusCode, 400);
});

test('one owner, expired lease fencing, explicit recovery, and queue ordering', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { session } = await f.createSession();
  const path = `/v1/sessions/${session.id}/runs`;
  const first = (await f.request('POST', path, { input: 'first', when_busy: 'queue' })).json();
  const second = (await f.request('POST', path, { input: 'second', when_busy: 'queue' })).json();
  const claims = await Promise.all([f.store.claim('a', 30_000), f.store.claim('b', 30_000)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const job = claims.find(Boolean)!;
  assert.equal(job.id, first.id);
  await f.pool.query("UPDATE sessions SET lease_expires=now()-interval '1 second' WHERE id=$1", [session.id]);
  await assert.rejects(f.store.finish(job, 'completed', null, 'stale', null, null), LeaseLost);
  assert.equal(await f.store.recoverExpired((id, epoch) => f.sandboxes.stopGeneration(id, epoch)), 1);
  assert.equal((await f.store.getRun('tenant-a', session.id, first.id)).status, 'waiting');
  assert.equal(await f.store.claim('c', 30_000), null);
  const resumed = await f.request('POST', path + '/' + first.id + '/resume', {});
  assert.equal(resumed.statusCode, 202, resumed.body);
  const retry = (await f.store.claim('c', 30_000))!;
  assert.equal(retry.id, first.id);
  assert.equal(retry.attempt, 2);
  await assert.rejects(f.store.startTool(job, 'old', 'bash', {}, saveCheckpoint(SessionManager.inMemory())), LeaseLost);
  await f.store.finish(retry, 'completed', null, 'okay', null, null);
  assert.equal((await f.store.claim('d', 30_000))!.id, second.id);
});

test('checkpoint roundtrip preserves compaction and a non-latest active branch', () => {
  const manager = SessionManager.inMemory('/workspace');
  manager.appendMessage({ role: 'user', content: 'older context', timestamp: 1 });
  const keep = manager.appendMessage({ role: 'user', content: 'keep me', timestamp: 2 });
  const compact = manager.appendCompaction('summary of older context', keep, 200);
  manager.appendMessage({ role: 'user', content: 'abandoned branch', timestamp: 3 });
  manager.branch(compact);
  const checkpoint = saveCheckpoint(manager);
  const restored = restoreCheckpoint(checkpoint, '/another-worker');
  assert.equal(restored.getLeafId(), compact);
  assert.deepEqual(restored.getEntries(), checkpoint.entries);
  assert.deepEqual(restored.buildSessionProjection().messages, manager.buildSessionProjection().messages);
  assert(!JSON.stringify(restored.buildSessionProjection().messages).includes('abandoned branch'));
  assert(JSON.stringify(restored.buildSessionProjection().messages).includes('summary of older context'));
  assert.throws(() => restoreCheckpoint({ ...checkpoint, sdk_version: 'incompatible' }, '/workspace'), /different runtime/);
});

test('real Pi SDK, Docker tools, event replay, artifacts, and session restoration', { timeout: 60_000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const model = await modelFixture(); t.after(() => model.close());
  const { session } = await f.createSession(true);
  const base = `/v1/sessions/${session.id}`;
  const run = (await f.request('POST', base + '/runs', { input: 'make a greeting', when_busy: 'queue' })).json();
  const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
  const stream = await fetch(address + base + '/events?stream=true', { headers: { authorization: 'Bearer ' + tokenA } });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const initial = await reader.read();
  assert(initial.value);
  await reader.cancel(); // Disconnect must leave the run admitted and runnable.
  const worker = new Worker(f.store, model.runtime, f.sandboxes, f.artifacts);
  assert.equal(await worker.processOne(), true);
  const result = (await f.request('GET', base + '/runs/' + run.id)).json();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.output_text, 'Saved greeting.txt.');
  assert.equal(result.usage.tokens.total, 120);
  assert.equal(model.requests.length, 4);
  assert.deepEqual(model.requests[0].tools.map((tool: any) => tool.function.name).sort(), ['bash', 'read_file', 'write_file']);
  const calls = (await f.pool.query('SELECT * FROM tool_calls WHERE run_id=$1 ORDER BY created_at', [run.id])).rows;
  assert.equal(calls.length, 3);
  assert(calls.every(call => call.status === 'completed'));
  const data = (await f.request('GET', base + '/artifacts')).json().data;
  assert.equal(data.length, 1);
  const download = await f.request('GET', data[0].download_url);
  assert.equal(download.statusCode, 200);
  assert.equal(download.body, 'Hello from the Pi SDK!\n');
  assert.equal((await f.request('GET', data[0].download_url, undefined, undefined, tokenB)).statusCode, 404);
  const events = (await f.request('GET', base + '/events?after=2')).json().data;
  assert.equal(events[0].seq, '3');
  assert.equal(events.at(-1).type, 'run.completed');
  assert.equal(events.at(-2).type, 'message.completed');
  assert.equal(events.at(-3).type, 'artifact.published');
  for (let i = 1; i < events.length; i++) assert.equal(BigInt(events[i].seq), BigInt(events[i - 1].seq) + 1n);
  const replay = await fetch(address + base + '/events?stream=true', { headers: { authorization: 'Bearer ' + tokenA, 'Last-Event-ID': '2' } });
  const replayReader = replay.body!.getReader();
  let replayText = '';
  while (!replayText.includes('event: run.completed')) replayText += new TextDecoder().decode((await replayReader.read()).value);
  await replayReader.cancel();
  assert(replayText.includes('id: 3\n'));
  assert(!replayText.includes('event: input.accepted'));
  const next = (await f.request('POST', base + '/runs', { input: 'what did we create', when_busy: 'queue' })).json();
  // A new Worker and Pi session must reconstruct the prior model/tool transcript.
  await new Worker(f.store, model.runtime, f.sandboxes, f.artifacts).processOne();
  const continued = (await f.request('GET', base + '/runs/' + next.id)).json();
  assert.equal(continued.status, 'completed', JSON.stringify(continued));
  assert.match(continued.output_text, /We created greeting.txt/);
  assert.equal(continued.usage.tokens.total, 30);
  assert.equal((await docker(['ps', '-aq', '--filter', 'label=pi-managed.session=' + session.id])).trim(), '');
  assert.equal((await f.request('POST', base + '/archive', {})).statusCode, 200);
  await f.store.cleanupArchived(id => f.sandboxes.destroySession(id));
  assert.equal((await f.request('POST', base + '/runs', { input: 'late', when_busy: 'queue' })).statusCode, 409);
  assert.equal((await f.request('GET', data[0].download_url)).body, 'Hello from the Pi SDK!\n');
});

test('queued and running cancellation, plus provider errors cannot become completed runs', { timeout: 30_000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const model = await modelFixture(); t.after(() => model.close());
  const { session } = await f.createSession();
  const base = `/v1/sessions/${session.id}/runs`;
  const queued = (await f.request('POST', base, { input: 'queued', when_busy: 'queue' })).json();
  assert.equal((await f.request('POST', base + '/' + queued.id + '/cancel', {})).json().status, 'cancelled');
  assert.equal(await f.store.claim('worker', 30_000), null);
  const run = (await f.request('POST', base, { input: 'wait for cancellation', when_busy: 'queue' })).json();
  const worker = new Worker(f.store, model.runtime, f.sandboxes, f.artifacts, { heartbeatMs: 100 });
  const processing = worker.processOne();
  await until(async () => model.requests.length > 0);
  const cancel = await f.request('POST', base + '/' + run.id + '/cancel', {});
  assert.equal(cancel.json().status, 'cancelling');
  await processing;
  assert.equal((await f.request('GET', base + '/' + run.id)).json().status, 'cancelled');
  const failed = (await f.request('POST', base, { input: 'provider error', when_busy: 'queue' })).json();
  await worker.processOne();
  assert.equal((await f.request('GET', base + '/' + failed.id)).json().status, 'failed');
  assert.equal((await f.store.events('tenant-a', session.id, '0')).filter(event => event.type === 'run.completed').length, 0);
});

test('failure after a tool effect records uncertainty and refuses automatic replay', { timeout: 30_000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const model = await modelFixture(); t.after(() => model.close());
  const { session } = await f.createSession(true);
  const base = `/v1/sessions/${session.id}/runs`;
  const run = (await f.request('POST', base, { input: 'make a greeting', when_busy: 'queue' })).json();
  const original = f.store.endTool.bind(f.store);
  f.store.endTool = async () => { throw new Error('Injected database failure after effect'); };
  await new Worker(f.store, model.runtime, f.sandboxes, f.artifacts).processOne();
  f.store.endTool = original;
  const result = (await f.request('GET', base + '/' + run.id)).json();
  assert.equal(result.status, 'waiting', JSON.stringify(result));
  assert.equal(result.error.code, 'recovery_required');
  assert.equal(model.requests.length, 1);
  assert.equal((await f.pool.query('SELECT status FROM tool_calls WHERE run_id=$1', [run.id])).rows[0].status, 'unknown');
  const cp = (await f.pool.query('SELECT checkpoint FROM sessions WHERE id=$1', [session.id])).rows[0].checkpoint;
  assert(JSON.stringify(cp.entries).includes('write_file'), 'Checkpoint must include assistant tool intent before dispatch');
  assert.equal((await f.request('POST', base + '/' + run.id + '/resume', {})).json().error.code, 'reconciliation_required');
  await f.request('POST', base, { input: 'later', when_busy: 'queue' });
  assert.equal(await f.store.claim('other', 30_000), null);
  assert.equal((await f.request('POST', base + '/' + run.id + '/cancel', {})).json().status, 'cancelled');
});

test('ordinary tool errors are recoverable by Pi and do not run host tools', { timeout: 30_000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const model = await modelFixture(); t.after(() => model.close());
  const { session } = await f.createSession(true);
  const base = `/v1/sessions/${session.id}/runs`;
  const run = (await f.request('POST', base, { input: 'correct a command error', when_busy: 'queue' })).json();
  await new Worker(f.store, model.runtime, f.sandboxes, f.artifacts).processOne();
  const result = (await f.request('GET', base + '/' + run.id)).json();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.output_text, 'Corrected the command.');
  const calls = (await f.pool.query('SELECT result FROM tool_calls WHERE run_id=$1 ORDER BY created_at', [run.id])).rows;
  assert.equal(calls[0].result.isError, true);
  assert.match(calls[0].result.text, /expected failure/);
  assert.equal(calls[1].result.isError, false);
  assert(model.requests[1].messages.some((message: any) => message.role === 'tool' && JSON.stringify(message.content).includes('exit code 2')));
});

test('cancelling an active shell kills its container before reporting cancellation', { timeout: 30_000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const model = await modelFixture(); t.after(() => model.close());
  const { session } = await f.createSession(true);
  const base = `/v1/sessions/${session.id}/runs`;
  const run = (await f.request('POST', base, { input: 'run a slow command', when_busy: 'queue' })).json();
  const processing = new Worker(f.store, model.runtime, f.sandboxes, f.artifacts, { heartbeatMs: 100 }).processOne();
  await until(async () => !!(await f.pool.query('SELECT 1 FROM tool_calls WHERE run_id=$1', [run.id])).rowCount);
  assert.equal((await f.request('POST', base + '/' + run.id + '/cancel', {})).json().status, 'cancelling');
  await processing;
  assert.equal((await f.request('GET', base + '/' + run.id)).json().status, 'cancelled');
  assert.equal((await docker(['ps', '-aq', '--filter', 'label=pi-managed.session=' + session.id])).trim(), '');
});

test('lease recovery stops stale processes, fences writes, and preserves the workspace', { timeout: 30_000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const { session } = await f.createSession(true);
  const base = `/v1/sessions/${session.id}/runs`;
  const run = (await f.request('POST', base, { input: 'first', when_busy: 'queue' })).json();
  const job = (await f.store.claim('old-owner', 30_000))!;
  const controller = new AbortController();
  const box = await f.sandboxes.open(job, controller.signal);
  t.after(() => box.close());
  await f.store.workspaceReady(job);
  assert.equal((await box.execute('read_file', { path: '/etc/passwd' }, controller.signal)).isError, true);
  assert.equal((await box.execute('write_file', { path: 'outputs/saved.txt', content: 'keep this workspace' }, controller.signal)).isError, undefined);
  await f.store.startTool(job, 'pending', 'bash', { command: 'sleep' }, saveCheckpoint(SessionManager.inMemory()));
  // Install the rejection handler immediately; recovery kills this in-flight exec.
  const command = box.execute('bash', { command: 'sleep 25; echo late > outputs/late.txt' }, controller.signal).then(() => false, () => true);
  await f.pool.query("UPDATE sessions SET lease_expires=now()-interval '1 second' WHERE id=$1", [session.id]);
  await f.store.recoverExpired((id, epoch) => f.sandboxes.stopGeneration(id, epoch));
  assert.equal(await command, true);
  await assert.rejects(f.store.endTool(job, 'pending', { text: 'stale' }), LeaseLost);
  assert.equal((await f.request('GET', base + '/' + run.id)).json().status, 'waiting');
  assert.equal((await docker(['ps', '-aq', '--filter', 'label=pi-managed.session=' + session.id])).trim(), '');
  assert.equal((await f.request('POST', base + '/' + run.id + '/resume', {})).statusCode, 409);
  await f.request('POST', base + '/' + run.id + '/cancel', {});
  await f.request('POST', base, { input: 'inspect workspace', when_busy: 'queue' });
  const next = (await f.store.claim('new-owner', 30_000))!;
  const restored = await f.sandboxes.open(next, new AbortController().signal);
  t.after(() => restored.close());
  const file = await restored.execute('read_file', { path: 'outputs/saved.txt' }, new AbortController().signal);
  assert.equal(file.text, 'keep this workspace');
  await restored.close();
});

test('a missing workspace or failed artifact publication never reports success', { timeout: 30_000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const model = await modelFixture(); t.after(() => model.close());
  const { session } = await f.createSession(true);
  const base = `/v1/sessions/${session.id}/runs`;
  const run = (await f.request('POST', base, { input: 'make a greeting', when_busy: 'queue' })).json();
  const publish = f.artifacts.publish.bind(f.artifacts);
  f.artifacts.publish = async () => { throw new Error('Injected object store failure'); };
  await new Worker(f.store, model.runtime, f.sandboxes, f.artifacts).processOne();
  f.artifacts.publish = publish;
  assert.equal((await f.request('GET', base + '/' + run.id)).json().status, 'waiting');
  assert.equal((await f.store.artifacts('tenant-a', session.id)).length, 0);
  await f.request('POST', base + '/' + run.id + '/cancel', {});
  await f.sandboxes.destroySession(session.id);
  const next = (await f.request('POST', base, { input: 'try again', when_busy: 'queue' })).json();
  await new Worker(f.store, model.runtime, f.sandboxes, f.artifacts).processOne();
  const result = (await f.request('GET', base + '/' + next.id)).json();
  assert.equal(result.status, 'waiting');
  assert.match(result.error.message, /workspace is missing/);
  assert.equal((await f.store.events('tenant-a', session.id, '0')).filter(event => event.type === 'run.completed').length, 0);
});

test('the runnable example completes through HTTP and the background worker loop', { timeout: 30_000 }, async t => {
  const f = await fixture();
  const model = await modelFixture();
  const worker = new Worker(f.store, model.runtime, f.sandboxes, f.artifacts, { pollMs: 50 });
  t.after(async () => { await worker.stop(); await model.close(); await f.close(); });
  const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
  worker.start();
  const { stdout } = await promisify(execFile)(process.execPath, ['examples/run.mjs'], {
    env: { ...process.env, API_URL: address, API_TOKEN: tokenA, PROMPT: 'make a greeting', MODEL_PROVIDER: 'openai', MODEL: 'gpt-4.1-mini' },
    timeout: 20_000,
  });
  assert.match(stdout, /run.completed/);
  assert.match(stdout, /"status": "completed"/);
  assert.match(stdout, /"path": "greeting.txt"/);
});
