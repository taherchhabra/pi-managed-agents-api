import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Explicitly opt-in: this talks to a running API and uses real provider credits.
// There is no fixture fallback. Keep the session for inspection in the console.
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
assert(caps.desktop?.configured, 'Configure a desktop host before running this suite');
const provider = process.env.LIVE_PROVIDER ?? 'openrouter';
const model = process.env.DESKTOP_LIVE_MODEL ?? 'deepseek/deepseek-v4.1-flash-1017';
assert(caps.providers.find((item: any) => item.id === provider)?.configured, 'The live provider is not configured');
const marker = 'HCU-' + randomUUID().slice(0, 8);
const agent = await request('/v1/agents', { name: 'Desktop assistant · live test', config: { provider, model, tools: ['AX','GUI'],
  instructions: 'You operate a private Linux desktop through HCU. Follow the task precisely. Take a screenshot before acting. Prefer accessibility for named controls, use screenshots for visual checks, and verify the saved result. Keep the final reply brief.' } });
const environment = await request('/v1/environment-templates', { name: 'Linux desktop · HCU', type: 'desktop' });
const session = await request('/v1/sessions', { agent_version_id: agent.latest_version.id, environment_template_id: environment.id });
console.log('Live desktop session: ' + origin + '/#/sessions/' + session.id);
const run = async (input: string) => {
  const created = await request(`/v1/sessions/${session.id}/runs`, { input, when_busy: 'reject' });
  console.log('Run started:', created.id);
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const value = await request(`/v1/sessions/${session.id}/runs/${created.id}`);
    if (['completed','failed','cancelled','waiting'].includes(value.status)) {
      assert.equal(value.status, 'completed', JSON.stringify(value.error));
      console.log('Completed:', value.output_text);
      return value;
    }
    await delay(1000);
  }
  await request(`/v1/sessions/${session.id}/runs/${created.id}/cancel`, {});
  throw new Error('Desktop run timed out and cancellation was requested');
};
const first = await run(`Use HCU only. Take a GUI screenshot and list applications with AX. Open Mousepad (the text editor) using Alt+F2, type mousepad, and press Enter. Write exactly "${marker}: created with HCU" in the document. Save it as /workspace/outputs/desktop-note.txt using the application's Save dialog. Take a final screenshot and verify that the file is saved. Do not use a terminal or code to write the file.`);
const status = await request(`/v1/sessions/${session.id}/desktop`);
assert.equal(status.state, 'paused', 'The desktop must pause between runs');
const second = await run(`Continue in the same desktop. Inspect the still-open Mousepad document. Append a new line reading exactly "${marker}: resumed successfully" and save the existing document. Take a screenshot of the result. Do not create a second document.`);
const artifacts = (await request(`/v1/sessions/${session.id}/artifacts`)).data;
const file = artifacts.find((item: any) => item.run_id === second.id && item.path === 'desktop-note.txt');
assert(file, 'The GUI-created file must be published as an artifact');
const response = await fetch(origin + file.download_url, { headers: { authorization: 'Bearer ' + token } });
const content = await response.text();
assert(content.includes(marker + ': created with HCU'));
assert(content.includes(marker + ': resumed successfully'));
const events = (await request(`/v1/sessions/${session.id}/events`)).data;
const screenshots = events.filter((event: any) => event.data.images?.length);
assert(screenshots.length >= 2, 'Real screenshots must be saved in the event log');
const tools = events.filter((event: any) => event.type === 'tool.requested');
assert(tools.some((event: any) => event.data.name === 'AX'));
assert(tools.some((event: any) => event.data.name === 'GUI'));
assert(tools.every((event: any) => ['AX','GUI'].includes(event.data.name)));
const report = { verified_at: new Date().toISOString(), provider, model, session: session.id, runs: [first.id, second.id],
  screenshots: screenshots.length, tool_calls: tools.length, artifact: content,
  usage: [first.usage, second.usage], url: origin + '/#/sessions/' + session.id };
await mkdir('.data', { recursive: true });
await writeFile('.data/live-desktop-report.json', JSON.stringify(report, null, 2));
console.log('PASS: real model + KVM + HCU AX/GUI + screenshots + GUI artifact + persistent desktop follow-up.');
console.log('Session kept for inspection: ' + report.url);
