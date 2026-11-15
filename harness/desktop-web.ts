import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Opt-in real model + graphical browser test. No fixture fallback.
const origin = process.env.API_URL ?? 'http://127.0.0.1:8080';
const token = process.env.API_TOKEN ?? Object.keys(JSON.parse(process.env.API_KEYS ?? '{}'))[0];
if (!token) throw new Error('Set API_TOKEN or configure API_KEYS in .env');
const request = async (path: string, body?: unknown) => {
  const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': randomUUID() }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
};
const caps = await request('/v1/capabilities');
assert(caps.desktop?.configured && caps.desktop.network_modes.includes('allowlist'), 'Configure the updated desktop host and API first');
const provider = process.env.LIVE_PROVIDER ?? 'openrouter';
const model = process.env.DESKTOP_LIVE_MODEL ?? 'deepseek/deepseek-v4.1-flash-1017';
assert(caps.providers.find((item: any) => item.id === provider)?.configured, 'The live provider is not configured');
const agent = await request('/v1/agents', { name: 'Desktop browser · network test', config: { provider, model, tools: ['AX', 'GUI'],
  instructions: 'Operate the Linux desktop using HCU only. Observe before acting. Prefer AX for named controls, and GUI screenshots for visual checks. Do not open a terminal or execute code. Report only what you can verify on screen. Be concise.' } });
const network = { mode: 'allowlist', allowed_domains: ['example.com'] };
const environment = await request('/v1/environment-templates', { name: 'Browser · example.com only', type: 'desktop', network });
const session = await request('/v1/sessions', { agent_version_id: agent.latest_version.id, environment_template_id: environment.id });
console.log('Live browser session: ' + origin + '/#/sessions/' + session.id);
async function run(input: string) {
  const created = await request(`/v1/sessions/${session.id}/runs`, { input, when_busy: 'reject' });
  console.log('Run started:', created.id);
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const value = await request(`/v1/sessions/${session.id}/runs/${created.id}`);
    if (['completed', 'failed', 'cancelled', 'waiting'].includes(value.status)) {
      assert.equal(value.status, 'completed', JSON.stringify(value.error));
      console.log('Completed:', value.output_text);
      return value;
    }
    await delay(1000);
  }
  await request(`/v1/sessions/${session.id}/runs/${created.id}/cancel`, {});
  throw new Error('Browser run timed out; cancellation requested');
}
const first = await run('Take a screenshot, open the Web browser using Alt+F2 and the command epiphany https://example.com, then inspect the loaded page with AX. Report its heading and first paragraph exactly as visible. Take a screenshot of the loaded page.');
assert.match(first.output_text, /Example Domain/i);
assert.equal((await request(`/v1/sessions/${session.id}/desktop`)).state, 'paused');
const second = await run('In the same browser, navigate to http://example.org. This domain is outside the session allowlist. Inspect the visible result and report whether it was blocked, with the error text. Take a screenshot as evidence, then return to https://example.com and leave that page open.');
const status = await request(`/v1/sessions/${session.id}/desktop`);
assert.equal(status.state, 'paused');
assert.deepEqual(status.network, network);
assert(status.network_activity?.blocked >= 1, 'The proxy must record a real denied request');
assert.equal(status.network_activity.last_denied, 'example.org');
assert(status.network_activity.allowed >= 1, 'The resumed browser must reconnect to the allowed page');
const events = (await request(`/v1/sessions/${session.id}/events`)).data;
const screenshots = events.filter((event: any) => event.data.images?.length);
const tools = events.filter((event: any) => event.type === 'tool.requested');
assert(screenshots.length >= 2);
assert(tools.some((event: any) => event.data.name === 'AX'));
assert(tools.some((event: any) => event.data.name === 'GUI'));
assert(tools.every((event: any) => ['AX', 'GUI'].includes(event.data.name)));
const report = { verified_at: new Date().toISOString(), provider, model, session: session.id, network,
  runs: [first.id, second.id], screenshots: screenshots.length, tool_calls: tools.length,
  network_activity: status.network_activity, usage: [first.usage, second.usage],
  url: origin + '/#/sessions/' + session.id };
await mkdir('.data', { recursive: true });
await writeFile('.data/live-desktop-web-report.json', JSON.stringify(report, null, 2));
console.log('PASS: real model + HCU browser + public HTTPS + blocked domain + persistent desktop.');
console.log('Session kept for inspection: ' + report.url);
