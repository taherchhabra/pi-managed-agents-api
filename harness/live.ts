import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import pg from 'pg';
import { buildApi } from '../src/api.js';
import { ArtifactStore } from '../src/artifacts.js';
import { SDK_VERSION } from '../src/domain.js';
import { piRuntime } from '../src/runtime.js';
import { docker, DockerSandboxProvider } from '../src/sandbox.js';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import { runAcceptance, type CheckResult } from './acceptance.js';

const key = process.env.OPENROUTER_API_KEY?.trim();
if (!key || /replace|your.key|example/i.test(key)) {
  console.error('Live tests require OPENROUTER_API_KEY in .env or the environment. No fixture fallback is used.');
  process.exitCode = 1;
} else {
  await runLive(key);
}

async function runLive(key: string) {
  const model = process.env.LIVE_MODEL ?? 'openai/gpt-4.1-mini';
  const selected = getBuiltinModel('openrouter', model as any);
  if (!selected) throw new Error('LIVE_MODEL is not available in the pinned Pi OpenRouter catalog');
  const started = new Date();
  const reportDir = resolve('.data/live-tests', started.toISOString().replaceAll(':', '-') + '-' + randomBytes(3).toString('hex'));
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  const limits = { per_run_model_requests: 8, total_model_requests: 24, output_tokens_per_request: 2048, run_timeout_ms: 120_000, suite_timeout_ms: 480_000 };
  const report: {
    schema_version: number; mode: string; status: string; provider: string; model: string; sdk_version: string;
    started_at: string; finished_at?: string; limits: typeof limits; checks: CheckResult[];
    model_requests: { run_id: string; provider: string; model: string; timestamp: string }[];
    usage?: unknown; error?: string; cleanup_errors: string[]; report_dir: string;
  } = { schema_version: 1, mode: 'live', status: 'running', provider: 'openrouter', model, sdk_version: SDK_VERSION,
    started_at: started.toISOString(), limits, checks: [], model_requests: [], cleanup_errors: [], report_dir: reportDir };
  const secrets = [key, process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY].filter((value): value is string => !!value);
  const redact = (value: string) => {
    for (const secret of secrets) value = value.replaceAll(secret, '[REDACTED]');
    return value.replace(/sk-or-v1-[a-zA-Z0-9]+/g, '[REDACTED]');
  };
  const persist = async (file: string, value: unknown) => writeFile(join(reportDir, file), redact(JSON.stringify(value, null, 2)) + '\n', { mode: 0o600 });
  await persist('report.json', report);
  console.log(`LIVE OpenRouter acceptance: ${model}`);
  console.log(`Limits: ${limits.total_model_requests} model requests total, ${limits.output_tokens_per_request} output tokens per request, no automatic retries.`);
  console.log('Report: ' + join(reportDir, 'report.json'));

  const schema = 'live_' + randomUUID().replaceAll('-', '');
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://pi:pi@127.0.0.1:55432/pi_agents';
  const admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 15_000 });
  let pool: pg.Pool | undefined;
  let app: ReturnType<typeof buildApi> | undefined;
  let worker: Worker | undefined;
  let store: Store | undefined;
  let createdSchema = false;
  const sandboxes = new DockerSandboxProvider();
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Live acceptance interrupted'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const timer = setTimeout(() => controller.abort(new Error('Live acceptance exceeded its deadline')), limits.suite_timeout_ms);
  try {
    const image = process.env.SANDBOX_IMAGE ?? 'pi-managed-sandbox:dev';
    await docker(['image', 'inspect', '--format', '{{.Id}}', image]);
    await admin.query('CREATE SCHEMA ' + schema);
    createdSchema = true;
    pool = new pg.Pool({ connectionString, options: '-c search_path=' + schema, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 15_000 });
    store = new Store(pool);
    await store.migrate();
    const artifacts = new ArtifactStore(join(reportDir, 'objects'));
    const token = randomBytes(32).toString('hex');
    const otherTenantToken = randomBytes(32).toString('hex');
    secrets.push(token, otherTenantToken);
    app = buildApi(store, artifacts, { apiKeys: { [token]: 'live-acceptance', [otherTenantToken]: 'other-tenant' }, sandboxImage: image });
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const runtime = piRuntime({ keys: { openrouter: key }, maxTurns: limits.per_run_model_requests, maxOutputTokens: limits.output_tokens_per_request,
      beforeModelRequest: request => {
        controller.signal.throwIfAborted();
        if (report.model_requests.length >= limits.total_model_requests) throw new Error('Live suite exhausted its total model-request budget');
        report.model_requests.push({ run_id: request.runId, provider: request.provider, model: request.model, timestamp: new Date().toISOString() });
      } });
    const startWorker = () => {
      const instance = new Worker(store!, runtime, sandboxes, artifacts, { heartbeatMs: 250, pollMs: 100, runTimeoutMs: limits.run_timeout_ms,
        onError: () => console.error('Worker operation failed; the run journal will report recovery status.') });
      instance.start();
      return instance;
    };
    worker = startWorker();
    await runAcceptance({ baseUrl, token, otherTenantToken, model, signal: controller.signal, evidenceDir: join(reportDir, 'artifacts'),
      restartWorker: async () => { await worker!.stop(); worker = startWorker(); },
      onCheck: async result => {
        report.checks.push(result);
        await persist('report.json', report);
        console.log(`${result.status.toUpperCase()} ${result.name} (${result.elapsed_ms}ms)`);
      },
    });
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = redact(error instanceof Error ? error.message : String(error));
    console.error('FAILED ' + report.error);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    const cleanup = async (name: string, fn: () => Promise<unknown>) => {
      try { await fn(); } catch (error) {
        report.cleanup_errors.push(redact(`${name}: ${error instanceof Error ? error.message : error}`));
        report.status = 'failed'; process.exitCode = 1;
      }
    };
    await cleanup('worker shutdown', async () => worker?.stop());
    await cleanup('API shutdown', async () => app?.close());
    if (store && pool) {
      const db = pool;
      await cleanup('evidence snapshot', async () => {
        const runs = (await db.query('SELECT id,session_id,status,input,attempt,output_text,error,usage,created_at,started_at,ended_at FROM runs ORDER BY created_at,id')).rows;
        const events = (await db.query('SELECT id,session_id,seq,type,run_id,data,created_at FROM events ORDER BY session_id,seq')).rows;
        const calls = (await db.query('SELECT run_id,call_id,attempt,name,status,args,result FROM tool_calls ORDER BY created_at')).rows;
        await persist('runs.json', runs); await persist('events.json', events); await persist('tool-calls.json', calls);
        const known = runs.filter(run => run.usage);
        report.usage = { completed_runs_with_usage: known.length, runs_with_unknown_usage: runs.length - known.length,
          tokens: known.reduce((sum, run) => sum + run.usage.tokens.total, 0),
          cost_estimate_usd: known.reduce((sum, run) => sum + run.usage.cost_usd, 0),
          source: 'pi_session_stats; excludes unknown usage from cancelled or interrupted requests' };
      });
      await cleanup('sandbox cleanup', async () => {
        const sessions = (await db.query('SELECT id FROM sessions')).rows;
        for (const session of sessions) await sandboxes.destroySession(session.id);
      });
    }
    await cleanup('pool shutdown', async () => pool?.end());
    if (createdSchema) await cleanup('schema cleanup', () => admin.query('DROP SCHEMA ' + schema + ' CASCADE'));
    await cleanup('admin pool shutdown', () => admin.end());
    report.finished_at = new Date().toISOString();
    await persist('report.json', report);
    await writeFile(resolve('.data/live-tests/latest.json'), redact(JSON.stringify(report, null, 2)) + '\n', { mode: 0o600 });
    console.log(`${report.status.toUpperCase()}: ${report.checks.filter(check => check.status === 'passed').length}/${report.checks.length} checks; ${report.model_requests.length} model requests.`);
    console.log('Report: ' + join(reportDir, 'report.json'));
  }
}
