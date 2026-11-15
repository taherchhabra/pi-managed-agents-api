import { resolve } from 'node:path';
import { DesktopHost, buildDesktopHost } from './host.js';

const token = process.env.DESKTOP_HOST_TOKEN;
if (!token || token.length < 32) throw new Error('DESKTOP_HOST_TOKEN must be at least 32 characters');
const positive = (name: string, fallback: number, max: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(name + ' is out of range');
  return value;
};
const host = new DesktopHost({ root: resolve(process.env.DESKTOP_DATA_DIR ?? '.data/desktop/sessions'),
  base: resolve(process.env.DESKTOP_BASE_IMAGE ?? '.data/desktop/ubuntu-hcu.qcow2'), token,
  memory: positive('DESKTOP_MEMORY_MB', 1536, 16384), maxVMs: positive('DESKTOP_MAX_VMS', 2, 100),
  runtime: process.env.DESKTOP_RUNTIME_DIR,
  blockedCIDRs: (process.env.DESKTOP_EGRESS_BLOCKED_CIDRS ?? '').split(',').map(value => value.trim()).filter(Boolean) });
await host.init();
const app = buildDesktopHost(host);
await app.listen({ host: process.env.DESKTOP_BIND ?? '127.0.0.1', port: positive('DESKTOP_PORT', 8090, 65535) });
console.log('HCU desktop host listening on port ' + (process.env.DESKTOP_PORT ?? 8090));
let stopping = false;
for (const name of ['SIGINT','SIGTERM'] as const) process.once(name, () => {
  if (stopping) return;
  stopping = true;
  void app.close().then(() => host.shutdown()).catch(() => { process.exitCode = 1; });
});
