import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.js';
import { Worker } from '../src/worker.js';
import { fixture, modelFixture, tokenA } from './fixture.js';

test('OpenRouter configuration and API admission preserve the provider and model', async t => {
  const config = loadConfig({ DATABASE_URL: 'postgres://unused', API_KEYS: JSON.stringify({ [tokenA]: 'test' }), OPENROUTER_API_KEY: 'test-provider-key' });
  assert.equal(config.providerKeys.openrouter, 'test-provider-key');
  const f = await fixture(); t.after(() => f.close());
  const agent = await f.request('POST', '/v1/agents', { name: 'OpenRouter agent', config: {
    provider: 'openrouter', model: 'openai/gpt-4.1-mini', instructions: 'Test', tools: [],
  } });
  assert.equal(agent.statusCode, 201, agent.body);
  const env = await f.request('POST', '/v1/environment-templates', { name: 'None', type: 'none' });
  const session = await f.request('POST', '/v1/sessions', { agent_version_id: agent.json().latest_version.id, environment_template_id: env.json().id });
  assert.equal(session.statusCode, 201, session.body);
  await f.request('POST', `/v1/sessions/${session.json().id}/runs`, { input: 'test', when_busy: 'queue' });
  const job = await f.store.claim('test', 30_000);
  assert.equal(job!.config.provider, 'openrouter');
  assert.equal(job!.config.model, 'openai/gpt-4.1-mini');
});

test('model-request and output-token budgets are enforced before another provider request', { timeout: 30_000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  let admitted = 0;
  const model = await modelFixture({ maxTurns: 1, maxOutputTokens: 64, beforeModelRequest: () => { admitted++; } });
  t.after(() => model.close());
  const { session } = await f.createSession(true);
  const run = (await f.request('POST', `/v1/sessions/${session.id}/runs`, { input: 'make a greeting', when_busy: 'queue' })).json();
  await new Worker(f.store, model.runtime, f.sandboxes, f.artifacts).processOne();
  assert.equal(model.requests.length, 1, 'A second paid request must not reach the provider');
  assert.equal(admitted, 1);
  assert.equal(model.requests[0].max_tokens ?? model.requests[0].max_completion_tokens, 64);
  assert.equal((await f.store.getRun('tenant-a', session.id, run.id)).status, 'waiting', 'A tool effect before the budget stop requires reconciliation');
});

test('suite-level admission hook can refuse the first model request', async t => {
  const f = await fixture(); t.after(() => f.close());
  const model = await modelFixture({ beforeModelRequest: () => { throw new Error('Suite budget exhausted'); } });
  t.after(() => model.close());
  const { session } = await f.createSession();
  const run = (await f.request('POST', `/v1/sessions/${session.id}/runs`, { input: 'hello', when_busy: 'queue' })).json();
  await new Worker(f.store, model.runtime, f.sandboxes, f.artifacts).processOne();
  assert.equal(model.requests.length, 0);
  assert.equal((await f.store.getRun('tenant-a', session.id, run.id)).status, 'failed');
});

test('live harness fails without a key and never falls back to fixtures', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', 'harness/live.ts'], {
    env: { ...process.env, OPENROUTER_API_KEY: '' }, timeout: 10_000,
  }), (error: any) => error.code === 1 && /Live tests require OPENROUTER_API_KEY/.test(error.stderr));
});
