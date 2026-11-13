import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import pg from 'pg';
import { buildApi } from '../src/api.js';
import { ArtifactStore } from '../src/artifacts.js';
import { piRuntime, type PiOptions } from '../src/runtime.js';
import { DockerSandboxProvider } from '../src/sandbox.js';
import { Store } from '../src/store.js';

export const tokenA = 'tenant-a-test-token-with-32-characters';
export const tokenB = 'tenant-b-test-token-with-32-characters';
export const agentConfig = { provider: 'openai', model: 'gpt-4.1-mini', instructions: 'Follow the requested task.', tools: [] };

export async function fixture() {
  const database = process.env.TEST_DATABASE_URL ?? 'postgres://pi:pi@127.0.0.1:55432/pi_agents';
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: database, connectionTimeoutMillis: 5000 });
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new pg.Pool({ connectionString: database, options: '-c search_path=' + schema, max: 10,
    connectionTimeoutMillis: 5000, statement_timeout: 10_000 });
  const store = new Store(pool);
  await store.migrate();
  const directory = await mkdtemp(join(tmpdir(), 'pi-api-test-'));
  const artifacts = new ArtifactStore(directory);
  const sandboxes = new DockerSandboxProvider();
  const app = buildApi(store, artifacts, { apiKeys: { [tokenA]: 'tenant-a', [tokenB]: 'tenant-b' }, sandboxImage: process.env.SANDBOX_IMAGE ?? 'pi-managed-sandbox:dev' });
  await app.ready();
  const request = async (method: 'POST' | 'GET', url: string, body?: unknown, key: string = randomUUID(), token = tokenA) => {
    return app.inject({ method, url, headers: { authorization: 'Bearer ' + token, 'idempotency-key': key },
      ...(body === undefined ? {} : { payload: JSON.stringify(body), headers: { authorization: 'Bearer ' + token, 'idempotency-key': key, 'content-type': 'application/json' } }) });
  };
  const createSession = async (managed = false) => {
    const agent = await request('POST', '/v1/agents', { name: 'Test agent', config: { ...agentConfig, tools: managed ? ['write_file', 'read_file', 'bash'] : [] } });
    if (agent.statusCode !== 201) throw new Error(agent.body);
    const env = await request('POST', '/v1/environment-templates', { name: 'Test environment', type: managed ? 'managed' : 'none' });
    if (env.statusCode !== 201) throw new Error(env.body);
    const session = await request('POST', '/v1/sessions', { agent_version_id: agent.json().latest_version.id, environment_template_id: env.json().id });
    if (session.statusCode !== 201) throw new Error(session.body);
    return { session: session.json(), agent: agent.json(), environment: env.json() };
  };
  return { app, pool, store, artifacts, sandboxes, request, createSession,
    async close() {
      await app.close();
      const sessions = (await pool.query('SELECT id FROM sessions WHERE workspace_initialized=true')).rows;
      for (const session of sessions) await sandboxes.destroySession(session.id);
      await pool.end();
      await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// A real HTTP/SSE provider fixture: Pi still parses the model stream, validates
// tool arguments, invokes tools, updates SessionManager and settles its loop.
export async function modelFixture(options: Pick<PiOptions, 'maxTurns' | 'maxOutputTokens' | 'beforeModelRequest'> = {}) {
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const messages = body.messages as any[];
      const lastUser = messages.findLastIndex(message => message.role === 'user');
      const prompt = JSON.stringify(messages[lastUser]?.content);
      if (prompt.includes('provider error')) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Deliberate provider failure', type: 'server_error' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      if (prompt.includes('wait for cancellation')) return;
      const toolResults = messages.slice(lastUser + 1).filter(message => message.role === 'tool');
      let delta: any = { role: 'assistant', content: 'Done.' };
      let finish = 'stop';
      if (prompt.includes('make a greeting')) {
        const steps = [
          { name: 'write_file', arguments: { path: 'outputs/greeting.txt', content: 'Hello from the Pi SDK!\n' } },
          { name: 'read_file', arguments: { path: 'outputs/greeting.txt' } },
          { name: 'bash', arguments: { command: 'test "$(id -u)" = 10001 && test -z "$OPENAI_API_KEY" && test ! -S /var/run/docker.sock && cat outputs/greeting.txt' } },
        ];
        const step = steps[toolResults.length];
        if (step) {
          delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + toolResults.length, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] };
          finish = 'tool_calls';
        } else delta.content = 'Saved greeting.txt.';
      } else if (prompt.includes('correct a command error')) {
        const steps = [
          { name: 'bash', arguments: { command: "printf 'expected failure'; exit 2" } },
          { name: 'bash', arguments: { command: "printf 'corrected command'" } },
        ];
        const step = steps[toolResults.length];
        if (step) {
          delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'error_' + toolResults.length, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] };
          finish = 'tool_calls';
        } else delta.content = 'Corrected the command.';
      } else if (prompt.includes('run a slow command') && !toolResults.length) {
        delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'slow_command', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 25; echo SHOULD_NOT_FINISH > outputs/late.txt' }) } }] };
        finish = 'tool_calls';
      } else if (prompt.includes('what did we create')) {
        delta.content = messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('Hello from the Pi SDK'))
          ? 'We created greeting.txt with Hello from the Pi SDK!'
          : 'Missing prior context.';
      }
      const chunk = (data: any) => response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1-mini', ...data }) + '\n\n');
      chunk({ choices: [{ index: 0, delta, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
      response.end('data: [DONE]\n\n');
    } catch (error) { response.destroy(error as Error); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const runtime = piRuntime({ ...options, keys: { openai: 'fixture-only-key' }, configureModelRuntime: async modelRuntime => {
    modelRuntime.registerProvider('openai', { api: 'openai-completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-only-key',
      models: [{ id: 'gpt-4.1-mini', name: 'Test model', api: 'openai-completions', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1024 }] });
  } });
  return { runtime, requests, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
