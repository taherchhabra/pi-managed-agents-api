import pg from 'pg';
import { buildApi } from './api.js';
import { ArtifactStore } from './artifacts.js';
import { loadConfig } from './config.js';
import { piRuntime } from './runtime.js';
import { DockerSandboxProvider } from './sandbox.js';
import { Store } from './store.js';
import { Worker } from './worker.js';
import { DesktopClient, EnvironmentSandboxProvider } from './desktop/client.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 15_000 });
pool.on('error', () => console.error('PostgreSQL pool connection failed'));
const store = new Store(pool);
await store.migrate();
const artifacts = new ArtifactStore(config.artifactDir);
const desktop = config.desktopUrl ? new DesktopClient(config.desktopUrl, config.desktopToken!) : undefined;
const sandboxes = new EnvironmentSandboxProvider(new DockerSandboxProvider(), desktop, id => store.environmentType(id));
const app = config.role === 'worker' ? undefined : buildApi(store, artifacts, { ...config, desktop }, true);
const worker = config.role === 'api' ? undefined : new Worker(store, piRuntime({ keys: config.providerKeys }), sandboxes, artifacts, {
  onError: () => console.error('Worker operation failed; retrying after the polling interval'),
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await Promise.all([worker?.stop(), app?.close()]);
  await pool.end();
};
process.once('SIGINT', () => { void stop().catch(() => { process.exitCode = 1; }); });
process.once('SIGTERM', () => { void stop().catch(() => { process.exitCode = 1; }); });
try {
  if (app) await app.listen({ host: config.host, port: config.port });
  worker?.start();
  console.log(`Pi Managed Agents started (role=${config.role})`);
} catch (error) { await stop(); throw error; }
