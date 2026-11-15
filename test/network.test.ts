import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { normalizeNetwork, permitsDomain } from '../src/network-policy.js';
import { addressFilter, EgressProxy } from '../src/desktop/egress.js';
import { DesktopClient } from '../src/desktop/client.js';
import { fixture, tokenB } from './fixture.js';

test('network policies normalize hostnames and constrain domain matching', () => {
  const policy = normalizeNetwork({ mode: 'allowlist', allowed_domains: ['Example.COM.', '*.example.com', 'example.com'] });
  assert.deepEqual(policy, { mode: 'allowlist', allowed_domains: ['*.example.com', 'example.com'] });
  for (const name of ['example.com', 'www.example.com', 'nested.www.example.com']) assert(permitsDomain(policy, name));
  for (const name of ['evilexample.com', 'example.com.evil.com', 'elsewhere.org']) assert(!permitsDomain(policy, name));
  assert(!permitsDomain(normalizeNetwork({ mode: 'allowlist', allowed_domains: ['*.example.com'] }), 'example.com'));
  for (const value of [null, {}, { mode: 'open' }, { mode: 'allowlist' }, { mode: 'internet', allowed_domains: ['example.com'] },
    ...['*', 'localhost', '127.0.0.1', 'https://example.com', 'example.com/path', 'example.com:443', 'example.com@evil.com', 'a..example.com'].map(domain => ({ mode: 'allowlist', allowed_domains: [domain] }))]) {
    assert.throws(() => normalizeNetwork(value));
  }
});

test('egress blocks private, special, IPv6, host, mixed DNS and late DNS answers', async t => {
  const allowed = addressFilter(['8.8.8.0/24']);
  for (const address of ['0.0.0.0', '127.0.0.1', '10.0.2.2', '100.100.100.200', '169.254.169.254', '172.16.0.1', '192.168.0.1',
    '192.0.2.1', '198.19.0.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1', '8.8.8.8']) assert(!allowed(address), address);
  assert(allowed('1.1.1.1'));
  const directory = await mkdtemp(join(tmpdir(), 'pi-proxy-test-'));
  const proxy = new EgressProxy(join(directory, 'p.sock'), normalizeNetwork({ mode: 'internet' }), {
    resolve: async host => host === 'mixed.example' ? ['1.1.1.1','10.0.0.1'] : ['1.1.1.1'],
  });
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });
  await proxy.start();
  assert.equal(await proxy.destination('public.example', 443), '1.1.1.1');
  for (const host of ['mixed.example', '127.0.0.1', '[::1]', 'localhost', 'foo.localhost']) await assert.rejects(proxy.destination(host, 443));
  await assert.rejects(proxy.destination('public.example', 22));
  await proxy.close();
  await assert.rejects(proxy.destination('public.example', 443), /not allowed/);

  let resolveDNS!: (addresses: string[]) => void;
  const late = new EgressProxy(join(directory, 'late.sock'), normalizeNetwork({ mode: 'internet' }), { resolve: () => new Promise(resolve => { resolveDNS = resolve; }) });
  await late.start();
  const pending = late.destination('delayed.example', 443);
  await late.close(); resolveDNS(['1.1.1.1']);
  await assert.rejects(pending, /stopped/);
});

test('HTTP and CONNECT requests cannot bypass a proxy policy with alternate address syntax', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-proxy-http-'));
  let lookups = 0;
  const proxy = new EgressProxy(join(directory, 'p.sock'), normalizeNetwork({ mode: 'allowlist', allowed_domains: ['example.com'] }), {
    resolve: async () => { lookups++; return ['127.0.0.1']; },
  });
  t.after(async () => { await proxy.close(); await rm(directory, { recursive: true, force: true }); });
  await proxy.start();
  const send = (path: string, method = 'GET') => new Promise<number>((resolve, reject) => {
    const req = request({ socketPath: proxy.path, path, method }, res => { res.resume(); resolve(res.statusCode!); });
    req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode!); });
    req.on('error', reject); req.end();
  });
  for (const url of ['http://blocked.example/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::ffff:127.0.0.1]/',
    'http://example.com:8090/', 'http://user:password@example.com/', 'http://example.com/']) assert.equal(await send(url), 403, url);
  for (const target of ['example.com:22', 'example.com@127.0.0.1:443', '127.0.0.1:443', 'example.com:443']) assert.equal(await send(target, 'CONNECT'), 403, target);
  assert.equal(lookups, 2, 'only allowlisted destinations reach DNS, and their private answers are rejected');
  assert.equal(proxy.activity.blocked, 11);
});

test('environment network policies survive session admission and stay tenant scoped', async t => {
  const f = await fixture({ desktop: new DesktopClient('http://unused.invalid', 'test-only') }); t.after(() => f.close());
  const network = { mode: 'allowlist', allowed_domains: ['example.com'] };
  const create = await f.request('POST', '/v1/environment-templates', { name: 'Web research', type: 'desktop', network });
  assert.equal(create.statusCode, 201);
  assert.deepEqual(create.json().network, network);
  const id = create.json().id;
  assert.equal((await f.request('GET', `/v1/environment-templates/${id}`, undefined, undefined, tokenB)).statusCode, 404);
  for (const type of ['managed','none']) assert.equal((await f.request('POST','/v1/environment-templates',{ name: 'Invalid', type, network })).statusCode,400);
  assert.equal((await f.request('POST','/v1/environment-templates',{ name: 'Empty', type: 'desktop', network: { mode: 'allowlist' } })).statusCode,400);
  const agent = (await f.request('POST','/v1/agents',{ name: 'Browser', config: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017', instructions: '', tools: ['AX','GUI'] } })).json();
  const session = (await f.request('POST','/v1/sessions',{ agent_version_id: agent.latest_version.id, environment_template_id: id })).json();
  assert.deepEqual((await f.request('GET', `/v1/sessions/${session.id}`)).json().environment_network, network);
  await f.request('POST', `/v1/sessions/${session.id}/runs`, { input: 'Inspect the browser', when_busy: 'reject' });
  assert.deepEqual((await f.store.claim('network-test', 30_000))?.environment.network, network);
});
