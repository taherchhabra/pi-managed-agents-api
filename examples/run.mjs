import { randomUUID } from 'node:crypto';

const base = process.env.API_URL ?? 'http://127.0.0.1:8080';
const token = process.env.API_TOKEN;
if (!token) throw new Error('Set API_TOKEN to a bearer token from the server API_KEYS configuration');
const headers = { authorization: 'Bearer ' + token };
async function request(path, body) {
  const response = await fetch(base + path, body === undefined ? { headers } : {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(json));
  return json;
}

const agent = await request('/v1/agents', { name: 'Artifact assistant', config: {
  provider: process.env.MODEL_PROVIDER ?? 'openai', model: process.env.MODEL ?? 'gpt-4.1-mini',
  instructions: 'Complete the task using the sandbox. Save all deliverables under /workspace/outputs.',
  tools: ['bash', 'read_file', 'write_file'],
} });
const environment = await request('/v1/environment-templates', { name: 'Python sandbox', type: 'managed' });
const session = await request('/v1/sessions', { agent_version_id: agent.latest_version.id, environment_template_id: environment.id });
const sessionPath = `/v1/sessions/${session.id}`;
const run = await request(sessionPath + '/runs', {
  input: process.env.PROMPT ?? 'Write a Python program that generates the first ten Fibonacci numbers. Run it and save the program and its output in outputs/.',
  when_busy: 'queue',
});
console.log({ session: session.id, run: run.id });

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error('Example timed out; inspect the run status through the API')), 360_000);
try {
  const response = await fetch(base + sessionPath + '/events?stream=true', { headers, signal: controller.signal });
  if (!response.ok) throw new Error(await response.text());
  const decoder = new TextDecoder();
  let buffer = '';
  events: for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split('\n').find(line => line.startsWith('data: '));
      if (!data) continue;
      const event = JSON.parse(data.slice(6));
      console.log(event.seq, event.type);
      if (event.run_id === run.id && ['run.completed', 'run.failed', 'run.cancelled', 'run.waiting'].includes(event.type)) break events;
    }
  }
  const result = await request(sessionPath + '/runs/' + run.id);
  console.log(JSON.stringify(result, null, 2));
  const artifacts = await request(sessionPath + '/artifacts');
  console.log(JSON.stringify(artifacts, null, 2));
  if (result.status !== 'completed') process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  controller.abort();
}
