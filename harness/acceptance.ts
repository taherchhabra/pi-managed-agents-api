import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

interface Event { id: string; seq: string; type: string; run_id: string | null; data: any }
export interface CheckResult { name: string; status: 'passed' | 'failed'; elapsed_ms: number; details?: unknown; error?: string }
export interface AcceptanceOptions {
  baseUrl: string;
  token: string;
  otherTenantToken: string;
  model: string;
  signal: AbortSignal;
  evidenceDir: string;
  restartWorker(): Promise<void>;
  onCheck(result: CheckResult): Promise<void>;
}

export async function runAcceptance(options: AcceptanceOptions) {
  const { signal } = options;
  const headers = { authorization: 'Bearer ' + options.token };
  const raw = (path: string, init: RequestInit = {}) => fetch(options.baseUrl + path, {
    ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  const get = async (path: string) => {
    const response = await raw(path);
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`);
    return response.json();
  };
  const post = async (path: string, body: unknown, key = randomUUID()) => {
    const response = await raw(path, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`POST ${path}: HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`);
    return { status: response.status, body: await response.json() };
  };
  const check = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      const details = await fn();
      await options.onCheck({ name, status: 'passed', elapsed_ms: Math.round(performance.now() - start), details });
      return details;
    } catch (error) {
      await options.onCheck({ name, status: 'failed', elapsed_ms: Math.round(performance.now() - start), error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
  const createSession = async (managed: boolean) => {
    const agent = await post('/v1/agents', { name: 'Live acceptance agent', config: {
      provider: 'openrouter', model: options.model,
      instructions: 'Follow the task exactly. Use the requested tools in order. When an intentional command fails, continue with the remaining steps. Keep final responses short.',
      tools: managed ? ['bash', 'read_file', 'write_file'] : [],
    } });
    const environment = await post('/v1/environment-templates', { name: 'Live acceptance environment', type: managed ? 'managed' : 'none' });
    const { body } = await post('/v1/sessions', { agent_version_id: agent.body.latest_version.id, environment_template_id: environment.body.id });
    return body.id as string;
  };
  const waitRun = async (session: string, run: string) => {
    const end = Date.now() + 135_000;
    while (Date.now() < end) {
      signal.throwIfAborted();
      const result = await get(`/v1/sessions/${session}/runs/${run}`);
      if (['completed', 'failed', 'cancelled', 'waiting'].includes(result.status)) return result;
      await delay(150, undefined, { signal });
    }
    throw new Error('Run did not settle within the acceptance deadline');
  };
  const complete = async (session: string, run: string) => {
    const result = await waitRun(session, run);
    assert.equal(result.status, 'completed', JSON.stringify({ run: result.id, status: result.status, error: result.error }));
    assert(result.usage?.tokens?.total > 0, 'Real provider usage must be present');
    return result;
  };
  const readEvents = async (session: string) => {
    let cursor = '0';
    const result: Event[] = [];
    while (true) {
      const page = await get(`/v1/sessions/${session}/events?after=${cursor}`);
      result.push(...page.data);
      if (page.data.length < 100) return result;
      cursor = page.next_cursor;
    }
  };
  const streamUntil = async (session: string, after: string, predicate: (event: Event) => boolean, timeout = 90_000) => {
    const response = await fetch(`${options.baseUrl}/v1/sessions/${session}/events?stream=true`, {
      headers: { ...headers, 'last-event-id': after }, signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });
    assert.equal(response.status, 200, 'SSE subscription must succeed');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events: Event[] = [];
    let buffer = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE closed before the expected event');
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (!data) continue;
          const event = JSON.parse(data.slice(6)) as Event;
          events.push(event);
          if (predicate(event)) return events;
          if (['run.failed', 'run.waiting', 'run.cancelled'].includes(event.type)) throw new Error(`Run stopped before expected SSE event: ${event.type}`);
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  };
  const download = async (session: string, run: string, path: string) => {
    const artifacts = (await get(`/v1/sessions/${session}/artifacts`)).data;
    const artifact = artifacts.find((item: any) => item.run_id === run && item.path === path);
    assert(artifact, `Artifact ${path} was not published`);
    const response = await raw(artifact.download_url);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    await mkdir(join(options.evidenceDir, run), { recursive: true });
    // All paths passed by this harness are fixed filenames, not model-selected paths.
    await writeFile(join(options.evidenceDir, run, path), bytes, { mode: 0o600 });
    return { artifact, bytes };
  };

  const marker = 'live-' + randomBytes(12).toString('hex');
  const noTools = await createSession(false);
  await check('live inference and idempotent admission', async () => {
    const key = randomUUID();
    const payload = { input: `Remember this marker for later: ${marker}. For this reply output only the marker, with no quotes or formatting.`, when_busy: 'queue' };
    const [first, duplicate] = await Promise.all([post(`/v1/sessions/${noTools}/runs`, payload, key), post(`/v1/sessions/${noTools}/runs`, payload, key)]);
    assert.equal(first.status, 202);
    assert.equal(first.body.id, duplicate.body.id);
    const result = await complete(noTools, first.body.id);
    assert.equal(result.output_text.trim(), marker);
    const events = await readEvents(noTools);
    assert.equal(events.filter(event => event.type === 'input.accepted').length, 1);
    return { session_id: noTools, run_id: result.id, tokens: result.usage.tokens.total };
  });
  await check('conversation restoration after worker replacement', async () => {
    await options.restartWorker();
    const { body: run } = await post(`/v1/sessions/${noTools}/runs`, { input: 'What marker did I give you in my previous message? Output only that marker, with no formatting.', when_busy: 'queue' });
    const result = await complete(noTools, run.id);
    assert.equal(result.output_text.trim(), marker);
    return { session_id: noTools, run_id: run.id };
  });

  const managed = await createSession(true);
  const values = Array.from({ length: 6 }, () => randomInt(2, 40));
  const expected = { marker, sorted: [...values].sort((a, b) => a - b), total: values.reduce((a, b) => a + b, 0) };
  let artifactUrl = '';
  let artifactText = '';
  let firstManagedRun = '';
  await check('real tool error recovery, Python execution, and artifact contents', async () => {
    const { body: run } = await post(`/v1/sessions/${managed}/runs`, { when_busy: 'queue', input:
      `Complete these steps in order using separate tool calls. First use bash to run exactly "exit 7"; this is an intentional diagnostic failure, so continue afterward. ` +
      `Use write_file to create outputs/compute.py. This Python program must compute, rather than hardcode, the sorted list and sum of ${JSON.stringify(values)}, then write outputs/result.json with exactly the keys marker, sorted, total. Set marker to ${JSON.stringify(marker)}. ` +
      `Use bash to execute "python3 outputs/compute.py". Finally use read_file to read outputs/result.json and verify its contents. Reply briefly when done. Do not use bash to create files; use write_file for the Python source.` });
    firstManagedRun = run.id;
    const observed = await streamUntil(managed, '0', event => event.type === 'tool.requested' && event.run_id === run.id);
    // The reader has disconnected here, while the real model/tool loop continues.
    const cursor = observed.at(-1)!.seq;
    await complete(managed, run.id);
    const events = (await readEvents(managed)).filter(event => event.run_id === run.id);
    const toolNames = new Set(events.filter(event => event.type === 'tool.requested').map(event => event.data.name));
    for (const name of ['bash', 'read_file', 'write_file']) assert(toolNames.has(name), `Model did not exercise ${name}`);
    assert(events.some(event => event.type === 'tool.completed' && event.data.isError === true && /exit code 7/.test(event.data.text)), 'Intentional tool failure must be recorded before recovery');
    const { artifact, bytes } = await download(managed, run.id, 'result.json');
    assert.deepEqual(JSON.parse(bytes.toString()), expected);
    artifactUrl = artifact.download_url;
    artifactText = bytes.toString();
    await download(managed, run.id, 'compute.py');
    const replay = await streamUntil(managed, cursor, event => event.type === 'run.completed' && event.run_id === run.id, 15_000);
    const expectedReplay = (await readEvents(managed)).filter(event => BigInt(event.seq) > BigInt(cursor));
    assert.deepEqual(replay.map(event => event.id), expectedReplay.map(event => event.id));
    assert.equal(events.at(-1)!.type, 'run.completed');
    assert(events.findIndex(event => event.type === 'artifact.published') < events.findIndex(event => event.type === 'run.completed'));
    return { session_id: managed, run_id: run.id, tools: [...toolNames], artifact_sha256: artifact.sha256, replayed_events: replay.length };
  });
  await check('workspace restoration and follow-up artifact after worker replacement', async () => {
    await options.restartWorker();
    const { body: run } = await post(`/v1/sessions/${managed}/runs`, { when_busy: 'queue', input:
      'Use read_file to read outputs/result.json from the existing workspace. Then use write_file to save that exact content to outputs/copy.json, with no changes to the JSON data. Do not rerun the computation. Reply briefly.' });
    await complete(managed, run.id);
    const { artifact, bytes } = await download(managed, run.id, 'copy.json');
    assert.deepEqual(JSON.parse(bytes.toString()), expected);
    const events = (await readEvents(managed)).filter(event => event.run_id === run.id);
    assert(events.some(event => event.type === 'tool.requested' && event.data.name === 'read_file'));
    return { session_id: managed, run_id: run.id, artifact_sha256: artifact.sha256 };
  });
  await check('tenant isolation and artifact retention after archive', async () => {
    for (const path of [`/v1/sessions/${managed}`, `/v1/sessions/${managed}/runs/${firstManagedRun}`, `/v1/sessions/${managed}/events`, artifactUrl]) {
      const denied = await raw(path, { headers: { authorization: 'Bearer ' + options.otherTenantToken } });
      assert.equal(denied.status, 404, path);
      await denied.body?.cancel();
    }
    await post(`/v1/sessions/${managed}/archive`, {});
    const retained = await raw(artifactUrl);
    assert.equal(retained.status, 200);
    assert.equal(await retained.text(), artifactText);
    return { session_id: managed, retained_artifact: true };
  });

  const cancellable = await createSession(true);
  await check('cancelling a real model-dispatched shell operation', async () => {
    const command = `python3 -c "import time; time.sleep(20); print('unexpected completion')"`;
    const { body: run } = await post(`/v1/sessions/${cancellable}/runs`, { when_busy: 'queue', input:
      `Your first action must be one bash tool call with this exact command: ${command}. Do not modify it or run it in the background. After it finishes, reply done.` });
    const events = await streamUntil(cancellable, '0', event => event.type === 'tool.requested' && event.run_id === run.id && event.data.name === 'bash');
    assert.equal(events.at(-1)!.data.args.command, command, 'Cancellation must exercise the intended long-running command');
    // Allow dispatch to enter the executor, then cancel through the public API.
    await delay(400, undefined, { signal });
    const start = performance.now();
    await post(`/v1/sessions/${cancellable}/runs/${run.id}/cancel`, {});
    const result = await waitRun(cancellable, run.id);
    assert.equal(result.status, 'cancelled', JSON.stringify(result.error));
    const elapsed = Math.round(performance.now() - start);
    assert(elapsed < 10_000, 'Cancellation did not stop the 20-second command promptly');
    assert(!(await readEvents(cancellable)).some(event => event.type === 'run.completed'));
    return { session_id: cancellable, run_id: run.id, cancellation_ms: elapsed };
  });
  return { sessions: [noTools, managed, cancellable] };
}
