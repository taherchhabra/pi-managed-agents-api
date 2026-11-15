import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopHost } from '../src/desktop/host.js';

// Real QEMU/KVM routing checks. No model key or changes to existing sessions.
await mkdir('.data/desktop-tests', { recursive: true });
const root = await mkdtemp(resolve('.data/desktop-tests/network-'));
const runtime = await mkdtemp(join(tmpdir(), 'pi-network-'));
const ids = ['ses_' + randomUUID(), 'ses_' + randomUUID()];
const options = { root, runtime, token: randomUUID(), maxVMs: 1,
  base: resolve(process.env.DESKTOP_BASE_IMAGE ?? '.data/desktop/ubuntu-hcu.qcow2') };
let host = new DesktopHost(options);
let initialized = false;
const checks: string[] = [];
const internet = { mode: 'internet', allowed_domains: [] };
const allowlist = { mode: 'allowlist', allowed_domains: ['example.com'] };
const started = Date.now();
async function shell(id: string, epoch: number, command: string) {
  const result = await host.tool(id, 'network-test', epoch, 'bash', { command });
  assert(!result.isError, result.text);
  return result.text;
}
const pass = (label: string) => { checks.push(label); console.log('PASS:', label); };
try {
  await host.init(); initialized = true;
  const id = ids[0]!;
  await host.open(id, 'network-test', 1, false, internet);
  assert.match(await shell(id, 1, 'curl -fsS --max-time 15 https://example.com'), /Example Domain/);
  assert.match(await shell(id, 1, 'curl -fsS --max-time 15 http://example.com'), /Example Domain/);
  assert.match(await shell(id, 1, 'gsettings get org.gnome.system.proxy mode'), /manual/);
  await shell(id, 1, `python3 - <<'PY'
import pathlib
panels=[]
for p in pathlib.Path('/proc').glob('[0-9]*'):
    try:
        if (p/'comm').read_text().strip()=='xfce4-panel': panels.append(p)
    except (FileNotFoundError, ProcessLookupError):
        continue
assert panels, 'The desktop panel must be running'
assert all(b'http_proxy=http://10.0.2.100:3128' in (p/'environ').read_bytes().split(b'\\0') for p in panels), 'Panel-launched apps must inherit the proxy'
PY`);
  pass('public HTTP/HTTPS through the configured desktop proxy');
  for (const target of ['http://127.0.0.1', 'http://10.0.2.2', 'http://169.254.169.254', 'http://2130706433']) {
    assert.match(await shell(id, 1, `curl -sS --max-time 5 -o /dev/null -w '%{http_code}' '${target}'`), /403/);
  }
  pass('proxy denies loopback, host, metadata and numeric IP aliases');
  await shell(id, 1, `python3 - <<'PY'
import socket
for address in [('1.1.1.1',443),('10.0.2.2',80),('169.254.169.254',80)]:
    try:
        s=socket.create_connection(address,timeout=2)
    except OSError:
        continue
    s.close()
    raise AssertionError('Direct connection unexpectedly succeeded: '+str(address))
# A normal DNS query for example.com must not escape via SLIRP DNS.
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(2)
s.sendto(bytes.fromhex('123401000001000000000000076578616d706c6503636f6d0000010001'),('10.0.2.3',53))
try:
    s.recvfrom(4096)
except TimeoutError:
    pass
else:
    raise AssertionError('Direct DNS escaped the restricted guest network')
PY`);
  pass('direct public/private TCP and direct DNS are blocked');
  await host.tool(id, 'network-test', 1, 'write_file', { path: 'retained.txt', content: 'network policy retained' });
  await host.close(id, 1);
  await assert.rejects(access(join(runtime, id.slice(4), 'egress.sock')));
  await assert.rejects(host.open(id, 'network-test', 2, true, allowlist), /original network policy/);
  await host.shutdown(); initialized = false;
  host = new DesktopHost(options);
  await host.init(); initialized = true;
  await host.open(id, 'network-test', 2, true, internet);
  assert.match(await shell(id, 2, 'curl -fsS --max-time 15 https://example.com'), /Example Domain/);
  assert.equal((await host.tool(id, 'network-test', 2, 'read_file', { path: 'retained.txt' })).text, 'network policy retained');
  pass('pause revokes proxy; host restart and resume retain policy and workspace');
  await host.destroy(id);
  const limited = ids[1]!;
  await host.open(limited, 'network-test', 1, false, allowlist);
  assert.match(await shell(limited, 1, 'curl -fsS --max-time 15 https://example.com'), /Example Domain/);
  assert.match(await shell(limited, 1, "curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://example.org"), /403/);
  const deniedTLS = await host.tool(limited, 'network-test', 1, 'bash', { command: 'curl -fsS --max-time 5 https://example.org' });
  assert(deniedTLS.isError && /403/.test(deniedTLS.text), deniedTLS.text);
  const activity = (await host.status(limited, 'network-test')).network_activity;
  assert(activity && activity.allowed >= 1 && activity.blocked >= 2);
  pass('allowlist permits approved HTTPS and rejects other HTTP/HTTPS destinations');
  await writeFile('.data/desktop-tests/network-latest.json', JSON.stringify({ verified_at: new Date().toISOString(), elapsed_ms: Date.now() - started, checks }, null, 2));
} catch (error) {
  for (const id of ids) console.error(await readFile(join(runtime, id.slice(4), 'qemu.log'), 'utf8').catch(() => ''));
  throw error;
} finally {
  if (initialized) {
    for (const id of ids) await host.destroy(id);
    await host.shutdown();
  }
  await rm(root, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
}
