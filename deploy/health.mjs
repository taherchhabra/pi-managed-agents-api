import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

try {
  if (process.argv[2] === 'worker') {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 4000 });
    try { await pool.query('SELECT 1'); } finally { await pool.end(); }
    await promisify(execFile)('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 4000 });
  } else {
    const response = await fetch('http://127.0.0.1:8080/healthz', { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error();
  }
} catch {
  console.error('Health check failed');
  process.exitCode = 1;
}
