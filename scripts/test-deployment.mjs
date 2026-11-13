// An isolated copy of the VPS stack. Host ports bind only to loopback; the
// separate client verifies HTTPS with a test CA, never by disabling TLS checks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { composeEnvironment, initialize } from './vps.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv.includes('--live');
if (live && !process.env.OPENROUTER_API_KEY?.trim()) throw new Error('Live deployment testing requires OPENROUTER_API_KEY; there is no fixture fallback');
const project = 'pi-test-' + randomBytes(6).toString('hex');
const directory = resolve(root, '.data/deployment-tests', project);
const envFile = resolve(directory, '.env');
const clientEnv = resolve(directory, 'client.env');
const override = resolve(directory, 'override.json');
const stateFile = resolve(directory, 'state.json');
const caFile = resolve(directory, 'root.crt');
const image = 'pi-managed-api:deployment-test';
const secrets = [process.env.OPENROUTER_API_KEY].filter(Boolean);
const redact = text => secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text);
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown.abort());
const report = { project, live, started_at: new Date().toISOString(), checks: [], status: 'running' };
const compose = ['compose', '--project-name', project, '--env-file', envFile, '-f', resolve(root, 'compose.vps.yaml'), '-f', override];

function docker(args, cleanup = false) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: root, env: composeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
      ...(cleanup ? {} : { signal: shutdown.signal }) });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000);
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-2_000_000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2_000_000); });
    child.on('error', error => { clearTimeout(timer); reject(new Error(redact(error.message))); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error('Docker command failed: ' + redact((stderr || stdout).slice(-8_000))));
    });
  });
}
const stack = (...args) => docker([...compose, ...args]);
const stage = message => console.log('[deployment] ' + message);
async function client(phase) {
  const mounts = [
    [resolve(root, 'test/deployment-client.mjs'), '/check/client.mjs'], [caFile, '/check/root.crt'],
    ...(phase === 'setup' ? [] : [[stateFile, '/check/state.json']]),
  ].flatMap(([source, target]) => ['--mount', 'type=bind,src=' + source + ',dst=' + target + ',readonly']);
  const output = await docker(['run', '--rm', '--network', project + '_frontend', '--env-file', clientEnv,
    '-e', 'NODE_EXTRA_CA_CERTS=/check/root.crt', ...mounts, image, 'node', '/check/client.mjs', phase]);
  return JSON.parse(output);
}
async function verifyIsolation() {
  const ids = (await stack('ps', '-q')).split('\n').filter(Boolean);
  const containers = JSON.parse(await docker(['inspect', ...ids]));
  const service = name => containers.find(item => item.Config.Labels['com.docker.compose.service'] === name);
  const api = service('api'), worker = service('worker'), db = service('db');
  assert(!api.Config.Env.some(value => /^(OPENAI|ANTHROPIC|OPENROUTER)_API_KEY=/.test(value)));
  assert(!api.Mounts.some(value => value.Destination === '/var/run/docker.sock'));
  assert(!worker.Config.Env.some(value => value.startsWith('API_KEYS=')));
  assert(worker.Mounts.some(value => value.Destination === '/var/run/docker.sock'));
  for (const item of [api, worker]) {
    assert.equal(item.Config.User, 'node');
    assert(item.HostConfig.ReadonlyRootfs);
    assert(item.HostConfig.CapDrop.includes('ALL'));
  }
  assert.equal(api.Mounts.find(value => value.Destination === '/data/artifacts').RW, false);
  for (const item of [api, worker, db]) assert(!Object.values(item.NetworkSettings.Ports ?? {}).some(Boolean));
  const gateway = service('gateway');
  for (const bindings of Object.values(gateway.NetworkSettings.Ports))
    if (bindings) for (const binding of bindings) assert.equal(binding.HostIp, '127.0.0.1');
  await docker(['cp', gateway.Id + ':/data/caddy/pki/authorities/local/root.crt', caFile]);
  await chmod(caFile, 0o644);
  report.checks.push('service-isolation', 'private-database', 'worker-only-provider-credentials', 'loopback-test-ports');
}
async function sandboxProbe(session) {
  // Exercise the shipped Docker binary/socket group and shared artifact volume
  // even in keyless CI. This is a tools/storage check, not a model simulation.
  const script = `
    import assert from 'node:assert/strict';
    import { DockerSandboxProvider } from './dist/src/sandbox.js';
    import { ArtifactStore } from './dist/src/artifacts.js';
    const provider = new DockerSandboxProvider();
    const signal = AbortSignal.timeout(60000);
    const job = { session_id: ${JSON.stringify(session)}, epoch: 100, workspace_initialized: false,
      environment: { type: 'managed', image: process.env.SANDBOX_IMAGE } };
    const first = await provider.open(job, signal);
    try {
      const written = await first.execute('write_file', { path: 'outputs/probe.txt', content: 'persistent deployment workspace\\n' }, signal);
      assert(!written.isError);
      const shell = await first.execute('bash', { command: 'test "$(id -u)" = 10001 && test ! -S /var/run/docker.sock && test -z "$OPENROUTER_API_KEY" && echo isolated' }, signal);
      assert(!shell.isError); assert.equal(shell.text.trim(), 'isolated');
    } finally { await first.close(); }
    const second = await provider.open({ ...job, epoch: 101, workspace_initialized: true }, signal);
    try {
      const read = await second.execute('read_file', { path: 'outputs/probe.txt' }, signal);
      assert.equal(read.text, 'persistent deployment workspace\\n');
      const files = await second.artifacts(signal);
      const saved = await new ArtifactStore(process.env.ARTIFACT_DIR).publish(files.find(file => file.path === 'probe.txt'));
      console.log(JSON.stringify(saved));
    } finally { await second.close(); }
  `;
  const file = JSON.parse(await stack('exec', '-T', 'worker', 'node', '--input-type=module', '-e', script));
  const readScript = `import assert from 'node:assert/strict'; import { ArtifactStore } from './dist/src/artifacts.js';
    const bytes = await new ArtifactStore(process.env.ARTIFACT_DIR).read(${JSON.stringify(file.sha256)});
    assert.equal(bytes.toString(), 'persistent deployment workspace\\n');`;
  await stack('exec', '-T', 'api', 'node', '--input-type=module', '-e', readScript);
  report.checks.push('sandbox-tools', 'workspace-persistence', 'sandbox-credential-isolation', 'shared-artifact-permissions');
}

let created = false;
try {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await initialize(envFile, 'agents.example.test', 'operator@example.test', (await stat('/var/run/docker.sock')).gid);
  const settings = parseEnv(await readFile(envFile, 'utf8'));
  const token = Object.keys(JSON.parse(settings.API_KEYS))[0];
  const otherToken = 'pi_' + randomBytes(32).toString('base64url');
  secrets.push(token, otherToken, settings.POSTGRES_PASSWORD);
  Object.assign(settings, { COMPOSE_PROJECT_NAME: project, API_IMAGE: image,
    WORKER_IMAGE: 'pi-managed-worker:deployment-test', SANDBOX_IMAGE: 'pi-managed-sandbox:deployment-test',
    API_KEYS: JSON.stringify({ [token]: 'demo', [otherToken]: 'another-app' }),
    HTTP_BIND: '127.0.0.1:0', HTTPS_BIND: '127.0.0.1:0',
    OPENROUTER_API_KEY: live ? process.env.OPENROUTER_API_KEY : '' });
  if (Object.values(settings).some(value => /[\r\n']/.test(value))) throw new Error('Unsupported deployment test configuration value');
  await writeFile(envFile, Object.entries(settings).map(([key, value]) => key + "='" + value + "'").join('\n') + '\n', { mode: 0o600 });
  await writeFile(clientEnv, ['API_URL=https://agents.example.test', 'API_TOKEN=' + token,
    'API_OTHER_TOKEN=' + otherToken, 'LIVE_MODE=' + (live ? '1' : '0'), ''].join('\n'), { mode: 0o600 });
  const caddyFile = resolve(directory, 'Caddyfile');
  await writeFile(caddyFile, (await readFile(resolve(root, 'deploy/Caddyfile'), 'utf8')).replace('reverse_proxy api:8080', 'tls internal\n\treverse_proxy api:8080'));
  await writeFile(override, JSON.stringify({ services: { gateway: {
    volumes: [caddyFile + ':/etc/caddy/Caddyfile:ro'], networks: { frontend: { aliases: ['agents.example.test'] } },
  } } }));
  stage('Building the production API, worker, and sandbox images');
  await docker(['build', '-f', 'Dockerfile.sandbox', '-t', settings.SANDBOX_IMAGE, '.']);
  await stack('build', 'api', 'worker');
  created = true;
  stage('Starting an isolated stack with HTTPS and private database');
  await stack('up', '-d', '--wait', '--wait-timeout', '180');
  await verifyIsolation();
  await stack('stop', 'worker');
  stage('Connecting from a separate application container over verified TLS');
  const state = await client('setup');
  await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o644 });
  report.checks.push(...state.checks);
  await stack('up', '-d', '--wait', 'worker');
  if (live) {
    stage('Running a real OpenRouter model through Pi and the Docker sandbox');
    report.initial_run = await client('complete');
    report.checks.push('real-model-tools', 'artifact-download');
  } else await sandboxProbe(state.session);
  stage('Restarting API, worker, and database; verifying saved state');
  await stack('stop', 'api', 'worker');
  await stack('restart', 'db');
  await stack('up', '-d', '--wait', '--wait-timeout', '180', 'api', 'worker');
  report.after_restart = await client('verify');
  report.checks.push('database-restart-persistence', ...(live ? ['real-model-followup', 'restored-conversation-and-workspace'] : []));
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = redact(error.message);
  process.exitCode = 1;
  console.error(report.error);
  if (created) {
    const logs = await docker([...compose, 'logs', '--tail', '30', 'api', 'worker', 'gateway'], true).catch(() => 'Logs unavailable');
    console.error(redact(logs));
  }
} finally {
  stage('Removing only this test project and its session workspaces');
  let cleanupError;
  if (created) {
    try {
      await docker([...compose, 'stop', 'api', 'worker'], true);
      // Get session IDs before removing this test database, including sessions
      // created by a client that failed before returning its state file.
      const sessions = (await docker([...compose, 'exec', '-T', 'db', 'psql', '-U', 'pi', '-d', 'pi_agents', '-Atc', 'SELECT id FROM sessions'], true)).split('\n');
      for (const session of sessions.filter(value => /^ses_[0-9a-f-]{36}$/.test(value))) {
        const ids = (await docker(['ps', '-aq', '--filter', 'label=pi-managed.session=' + session], true)).split('\n').filter(Boolean);
        if (ids.length) await docker(['rm', '-f', ...ids], true);
        const volume = 'pi-workspace-' + session.replaceAll('_', '-');
        if (await docker(['volume', 'ls', '-q', '--filter', 'name=^' + volume + '$'], true)) await docker(['volume', 'rm', volume], true);
      }
    } catch (error) { cleanupError = error.message; }
    await docker([...compose, 'down', '--volumes', '--remove-orphans'], true).catch(error => { cleanupError = error.message; });
  }
  if (cleanupError) {
    report.cleanup_error = redact(cleanupError); process.exitCode = 1; report.status = 'failed';
    console.error('Cleanup needs attention: ' + report.cleanup_error);
  }
  await rm(envFile, { force: true });
  await rm(clientEnv, { force: true });
  report.finished_at = new Date().toISOString();
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  stage(report.status + '; evidence: ' + resolve(directory, 'report.json'));
}
