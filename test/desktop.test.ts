import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DesktopClient } from '../src/desktop/client.js';
import { Worker } from '../src/worker.js';
import { fixture, modelFixture, tokenB } from './fixture.js';

class PreviewHost extends DesktopClient {
  calls = 0;
  constructor() { super('http://unused.invalid', 'test-only'); }
  override async status() { this.calls++; return { state: 'paused' as const, platform: 'linux' as const, network: { mode: 'off' as const, allowed_domains: [] }, width: 1280, height: 800 }; }
  override async frame() { this.calls++; return Buffer.from([255,216,255,217]); }
}

test('desktop admission requires configuration, vision and the right environment', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.equal((await f.request('POST', '/v1/environment-templates', { name: 'Desktop', type: 'desktop' })).statusCode, 503);
  const invalid = await f.request('POST', '/v1/agents', { name: 'Unsupported model', config: {
    provider: 'openrouter', model: 'no-such-model', tools: ['GUI'], instructions: '' } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'vision_model_required');
  const agent = (await f.request('POST', '/v1/agents', { name: 'Desktop', config: {
    provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017', tools: ['AX','GUI'], instructions: '' } })).json();
  const env = (await f.request('POST', '/v1/environment-templates', { name: 'Docker', type: 'managed' })).json();
  const mismatch = await f.request('POST', '/v1/sessions', { agent_version_id: agent.latest_version.id, environment_template_id: env.id });
  assert.equal(mismatch.statusCode, 400);
  assert.equal(mismatch.json().error.code, 'desktop_required');
});

test('desktop previews and screenshots enforce tenant and archive boundaries', async t => {
  const desktop = new PreviewHost();
  const f = await fixture({ desktop }); t.after(() => f.close());
  const agent = (await f.request('POST', '/v1/agents', { name: 'Desktop', config: {
    provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017', tools: ['AX','GUI'], instructions: '' } })).json();
  const environment = (await f.request('POST', '/v1/environment-templates', { name: 'Desktop', type: 'desktop' })).json();
  const session = (await f.request('POST', '/v1/sessions', { agent_version_id: agent.latest_version.id, environment_template_id: environment.id })).json();
  const path = `/v1/sessions/${session.id}`;
  assert.equal((await f.request('GET', path + '/desktop')).json().state, 'paused');
  assert.equal((await f.request('GET', path + '/desktop/frame')).headers['content-type'], 'image/jpeg');
  const before = desktop.calls;
  for (const suffix of ['/desktop','/desktop/frame']) assert.equal((await f.request('GET', path + suffix, undefined, undefined, tokenB)).statusCode, 404);
  assert.equal(desktop.calls, before, 'unauthorized callers must never contact the host');
  await f.request('POST', path + '/archive', {});
  assert.equal((await f.request('GET', path + '/desktop')).statusCode, 410);
});

test('Pi delivers screenshot bytes to a vision model and events retain authorized references', async t => {
  const f = await fixture({ desktop: new PreviewHost() }); t.after(() => f.close());
  const model = await modelFixture({ vision: true }); t.after(() => model.close());
  const agent = (await f.request('POST', '/v1/agents', { name: 'Vision', config: {
    provider: 'openai', model: 'gpt-4.1-mini', tools: ['GUI'], instructions: '' } })).json();
  const env = (await f.request('POST', '/v1/environment-templates', { name: 'Desktop', type: 'desktop' })).json();
  const session = (await f.request('POST', '/v1/sessions', { agent_version_id: agent.latest_version.id, environment_template_id: env.id })).json();
  const path = `/v1/sessions/${session.id}`;
  const run = (await f.request('POST', path + '/runs', { input: 'inspect the desktop', when_busy: 'queue' })).json();
  const data = Buffer.from([255,216,255,217]).toString('base64');
  let closed = false;
  const worker = new Worker(f.store, model.runtime, { async open() { return {
    async execute(name, args) { assert.equal(name, 'GUI'); assert.deepEqual(args, { actions: [{ type: 'screenshot' }] });
      return { text: 'Screenshot: 1 x 1', images: [{ data, mimeType: 'image/jpeg' as const, width: 1, height: 1 }] }; },
    async artifacts() { return []; }, async close() { closed = true; },
  }; }, async stopGeneration() {}, async destroySession() {} }, f.artifacts);
  await worker.processOne();
  assert.equal((await f.store.getRun('tenant-a', session.id, run.id)).status, 'completed');
  assert(closed);
  assert.match(JSON.stringify(model.requests.at(-1)), /data:image\/jpeg;base64,/);
  const events = (await f.request('GET', path + '/events')).json().data;
  const result = events.find((event: any) => event.type === 'tool.completed');
  assert.equal(result.data.images.length, 1);
  assert(!JSON.stringify(events).includes('base64'), 'event history must not duplicate base64 payloads');
  const capture = result.data.images[0].url;
  assert.equal((await f.request('GET', capture)).statusCode, 200);
  assert.equal((await f.request('GET', capture, undefined, undefined, tokenB)).statusCode, 404);
  await f.request('POST', path + '/archive', {});
  assert.equal((await f.request('GET', capture)).statusCode, 200, 'archiving retains screenshot evidence');
});
