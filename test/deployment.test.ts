import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApi } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { fixture, tokenA } from './fixture.js';

test('remote bearer clients are independent of console origin; API needs no provider secret', async t => {
  const f = await fixture(); t.after(() => f.close());
  const app = buildApi(f.store, f.artifacts, {
    apiKeys: { [tokenA]: 'tenant-a' }, sandboxImage: 'test',
    consoleOrigin: 'https://agents.example.com', providerConfigured: { openrouter: true },
  });
  t.after(() => app.close());
  const headers = { authorization: 'Bearer ' + tokenA, origin: 'https://my-app.example.net', 'idempotency-key': 'remote-app-agent' };
  const response = await app.inject({ method: 'POST', url: '/v1/agents', headers, payload: {
    name: 'Remote app', config: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017', instructions: 'Test', tools: [] },
  } });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.headers['access-control-allow-origin'], undefined, 'Server API tokens are not browser credentials');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/agents', headers, payload: {
    name: 'Remote app', config: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017', instructions: 'Test', tools: [] },
  } })).json().id, response.json().id);
  const caps = await app.inject({ url: '/v1/capabilities', headers });
  assert(caps.json().providers.find((p: any) => p.id === 'openrouter').configured);
  const denied = await app.inject({ url: '/v1/agents', headers: { origin: headers.origin } });
  assert.equal(denied.statusCode, 401);
});

test('IP rate limits cover unauthenticated requests and ignore untrusted forwarding headers', async t => {
  const f = await fixture(); t.after(() => f.close());
  const app = buildApi(f.store, f.artifacts, { apiKeys: { [tokenA]: 'tenant-a' }, sandboxImage: 'test', rateLimitMax: 2, loginRateLimitMax: 1 });
  t.after(() => app.close());
  for (const forwarded of ['192.0.2.1', '192.0.2.2']) {
    assert.equal((await app.inject({ url: '/v1/agents', headers: { 'x-forwarded-for': forwarded } })).statusCode, 401);
  }
  const blocked = await app.inject({ url: '/v1/agents', headers: { 'x-forwarded-for': '192.0.2.3' } });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.code, 'rate_limit_exceeded');
  assert(Number(blocked.headers['retry-after']) > 0);
  assert.equal((await app.inject({ url: '/healthz' })).statusCode, 200);
  const login = { method: 'POST' as const, url: '/console/login', headers: { origin: 'http://localhost:80', 'x-pi-console': '1' }, payload: { token: tokenA } };
  assert.equal((await app.inject(login)).statusCode, 200);
  assert.equal((await app.inject(login)).statusCode, 429);
});

test('worker configuration has no workspace keys and proxy trust requires explicit configuration', () => {
  const worker = loadConfig({ ROLE: 'worker', DATABASE_URL: 'postgres://unused', OPENROUTER_API_KEY: 'worker-secret' });
  assert.deepEqual(worker.apiKeys, {});
  assert.equal(worker.trustProxyHops, 0);
  const api = loadConfig({ ROLE: 'api', DATABASE_URL: 'postgres://unused', API_KEYS: JSON.stringify({ [tokenA]: 'test' }), OPENROUTER_CONFIGURED: 'true', TRUST_PROXY_HOPS: '1' });
  assert.equal(api.providerKeys.openrouter, undefined);
  assert.equal(api.providerConfigured.openrouter, true);
  assert.equal(api.trustProxyHops, 1);
  for (const settings of [{ TRUST_PROXY_HOPS: '-1' }, { RATE_LIMIT_MAX: '0' }, { LOGIN_RATE_LIMIT_MAX: 'invalid' }])
    assert.throws(() => loadConfig({ ROLE: 'worker', DATABASE_URL: 'postgres://unused', ...settings }), /out of range/);
  assert.throws(() => loadConfig({ ROLE: 'api', DATABASE_URL: 'postgres://unused' }), /API_KEYS/);
});

test('one trusted proxy hop rate limits clients independently and ignores deeper spoofed addresses', async t => {
  const f = await fixture(); t.after(() => f.close());
  const app = buildApi(f.store, f.artifacts, { apiKeys: { [tokenA]: 'tenant-a' }, sandboxImage: 'test', rateLimitMax: 1, trustProxyHops: 1 });
  t.after(() => app.close());
  const headers = { authorization: 'Bearer ' + tokenA };
  assert.equal((await app.inject({ url: '/v1/agents', headers: { ...headers, 'x-forwarded-for': '198.51.100.1, 192.0.2.1' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/v1/agents', headers: { ...headers, 'x-forwarded-for': '198.51.100.2, 192.0.2.1' } })).statusCode, 429);
  assert.equal((await app.inject({ url: '/v1/agents', headers: { ...headers, 'x-forwarded-for': '192.0.2.2' } })).statusCode, 200);
});
