import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const base = (process.env.API_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const token = process.env.API_TOKEN;
if (!token) throw new Error('Set API_TOKEN to a workspace token from the server');
const headers = { Authorization: `Bearer ${token}` };

// For a retry, pass the original requestId and the unchanged body.
async function request(path, body, requestId = randomUUID()) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? headers : {
      ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': requestId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function waitForRun(sessionPath, runId) {
  const runPath = `${sessionPath}/runs/${runId}`;
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline) {
    const run = await request(runPath);
    if (run.status === 'completed') return run;
    if (['failed', 'cancelled', 'waiting'].includes(run.status)) {
      throw new Error(`${runPath}: ${run.status}; ${run.error?.message ?? 'inspect the run in the console'}`);
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for ${runPath}; the server may still be working`);
}

// 1. Create an agent and its first immutable version.
const agent = await request('/v1/agents', {
  name: 'Python assistant',
  config: {
    provider: process.env.MODEL_PROVIDER ?? 'openrouter',
    model: process.env.MODEL ?? 'deepseek/deepseek-v4.1-flash-1017',
    instructions: 'Use Python to verify calculations. Save deliverables under outputs/. Keep replies concise.',
    tools: ['bash', 'read_file', 'write_file'],
  },
});

// 2. Give sessions a managed Docker workspace.
const environment = await request('/v1/environment-templates', {
  name: 'Python workspace', type: 'managed',
});

// 3. Start a conversation pinned to this agent version.
const session = await request('/v1/sessions', {
  agent_version_id: agent.latest_version.id,
  environment_template_id: environment.id,
});
const sessionPath = `/v1/sessions/${session.id}`;
console.log('Session:', session.id); // Store this ID with the conversation in your app.

// 4. Send the user's first message. Persist this key/body to retry safely.
const firstRequestId = randomUUID();
const firstMessage = {
  input: process.env.PROMPT ?? 'Use Python to calculate the first ten Fibonacci numbers starting with 0, 1. Save the code to outputs/fibonacci.py and the numbers to outputs/fibonacci.txt.',
  when_busy: 'queue',
};
console.log('User:', firstMessage.input);
const firstRun = await request(`${sessionPath}/runs`, firstMessage, firstRequestId);
console.log('Run:', firstRun.id); // HTTP 202 means accepted; model work is asynchronous.

// 5. Wait for completion and return the assistant's response to your user.
const firstResult = await waitForRun(sessionPath, firstRun.id);
console.log('Assistant:', firstResult.output_text);

// 6. The user replies. Reuse the session to keep its conversation and files.
const replyRequestId = randomUUID();
const replyMessage = {
  input: process.env.FOLLOWUP_PROMPT ?? 'Read outputs/fibonacci.txt and tell me the sum of those numbers.',
  when_busy: 'queue',
};
console.log('User:', replyMessage.input);
const nextRun = await request(`${sessionPath}/runs`, replyMessage, replyRequestId);
console.log('Run:', nextRun.id);
const nextResult = await waitForRun(sessionPath, nextRun.id);
console.log('Assistant:', nextResult.output_text);

// 7. Retrieve the latest run's output snapshots using the same authentication.
const { data: files } = await request(`${sessionPath}/artifacts`);
for (const file of files.filter(file => file.run_id === nextRun.id)) {
  const response = await fetch(base + file.download_url, {
    headers, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Artifact download failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  console.log(`Downloaded ${file.path} (${bytes.length} bytes)`);
  // Store these bytes, or return them to the authorized user from your backend.
}
