// Runs in a separate container, with only a workspace token and a trusted test CA.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const base = process.env.API_URL;
const token = process.env.API_TOKEN;
const phase = process.argv[2];
const live = process.env.LIVE_MODE === '1';
const auth = { authorization: 'Bearer ' + token };
async function request(path, body, key = randomUUID()) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': key }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const value = await response.json();
  assert(response.ok, 'API request failed: ' + JSON.stringify(value));
  return value;
}
async function waitForRun(session, run) {
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    const result = await request('/v1/sessions/' + session + '/runs/' + run);
    if (result.status === 'completed') return result;
    assert(['running', 'queued'].includes(result.status), 'Run ended: ' + JSON.stringify({ status: result.status, error: result.error }));
    await delay(500);
  }
  throw new Error('Run did not complete before the test deadline');
}
async function artifact(session, marker) {
  const files = await request('/v1/sessions/' + session + '/artifacts');
  const file = files.data.find(file => file.path === 'vps-check.txt');
  assert(file, 'Expected published artifact');
  const response = await fetch(base + file.download_url, { headers: auth, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), marker + '\n');
  return file;
}
async function main() {
  if (phase === 'setup') {
    const redirect = await fetch(base.replace('https:', 'http:') + '/healthz', { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), base + '/healthz');
    const health = await fetch(base + '/healthz', { signal: AbortSignal.timeout(10_000) });
    assert.equal(health.status, 200);
    assert(health.headers.get('strict-transport-security'));
    assert.equal((await fetch(base + '/v1/agents')).status, 401);
    assert.equal((await fetch(base + '/')).status, 200);
    const login = await fetch(base + '/console/login', {
      method: 'POST', headers: { origin: base, 'x-pi-console': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    const badLogin = await fetch(base + '/console/login', {
      method: 'POST', headers: { origin: 'https://unrelated-app.example', 'x-pi-console': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    assert.equal(badLogin.status, 403);
    const capabilities = await request('/v1/capabilities');
    assert.equal(capabilities.providers.find(provider => provider.id === 'openrouter').configured, live);
    const agent = await request('/v1/agents', { name: 'Deployment smoke agent', config: {
      provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017',
      instructions: 'Complete the task exactly. Use the requested tools. Save deliverables under outputs/.', tools: ['bash', 'read_file', 'write_file'],
    } });
    const environment = await request('/v1/environment-templates', { name: 'Deployment sandbox', type: 'managed' });
    const session = await request('/v1/sessions', { agent_version_id: agent.latest_version.id, environment_template_id: environment.id });
    const path = '/v1/sessions/' + session.id;
    assert.equal((await fetch(base + path, { headers: { authorization: 'Bearer ' + process.env.API_OTHER_TOKEN } })).status, 404);
    const marker = 'vps-' + randomUUID();
    const body = { input: 'Use write_file to save the exact text ' + marker + ' followed by one newline in outputs/vps-check.txt. Use read_file to verify it. Then use bash to run python3 -c "print(6*7)". Briefly report the result.', when_busy: 'queue' };
    const key = randomUUID();
    const run = await request(path + '/runs', body, key);
    assert.equal((await request(path + '/runs', body, key)).id, run.id);
    const stream = new AbortController();
    const timer = setTimeout(() => stream.abort(), 10_000);
    let found = false;
    try {
      const response = await fetch(base + path + '/events?stream=true', { headers: auth, signal: stream.signal });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += new TextDecoder().decode(chunk);
        if (buffer.includes('"input.accepted"')) { found = true; break; }
      }
    } finally { clearTimeout(timer); stream.abort(); }
    assert(found, 'SSE must flush events through HTTPS');
    if (!live) {
      await request(path + '/runs/' + run.id + '/cancel', {});
      assert.equal((await request(path + '/runs/' + run.id)).status, 'cancelled');
    }
    return { session: session.id, run: run.id, marker, checks: ['https', 'http-redirect', 'auth', 'secure-console-cookie', 'origin-check', 'provider-flags', 'tenant-isolation', 'idempotency', 'sse'] };
  }
  const state = JSON.parse(await readFile('/check/state.json', 'utf8'));
  if (phase === 'complete') {
    const run = await waitForRun(state.session, state.run);
    await artifact(state.session, state.marker);
    const events = await request('/v1/sessions/' + state.session + '/events');
    const tools = new Set(events.data.filter(event => event.type === 'tool.requested').map(event => event.data.name));
    for (const name of ['write_file', 'read_file', 'bash']) assert(tools.has(name), 'Expected real tool call: ' + name);
    assert.match(run.output_text, /42/);
    return { status: run.status, usage: run.usage };
  }
  if (phase === 'verify') {
    const saved = await request('/v1/sessions/' + state.session + '/runs/' + state.run);
    assert.equal(saved.status, live ? 'completed' : 'cancelled');
    if (live) {
      await artifact(state.session, state.marker);
      const followup = await request('/v1/sessions/' + state.session + '/runs', {
        input: 'What marker did I ask you to save earlier? Read outputs/vps-check.txt and include that exact marker in your answer.', when_busy: 'queue',
      });
      const result = await waitForRun(state.session, followup.id);
      assert(result.output_text.includes(state.marker), 'Session/workspace state must survive API, worker, and database restarts');
      return { status: 'passed', usage: result.usage };
    }
    return { status: 'passed' };
  }
  throw new Error('Unknown test phase');
}
console.log(JSON.stringify(await main()));
