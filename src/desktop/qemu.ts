import { createConnection } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
export async function command(program: string, args: string[], timeout = 30_000) {
  return (await exec(program, args, { timeout, maxBuffer: 2 * 1024 * 1024 })).stdout;
}
// QGA is a serial stream, not a concurrent RPC socket. Serialize connections
// and resynchronize after reconnects, as required by the QEMU guest protocol.
const queues = new Map<string, Promise<unknown>>();
export function rpc(path: string, execute: string, args?: Record<string, unknown>, guest = false): Promise<any> {
  const previous = queues.get(path) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(() => new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const sync = Math.floor(Math.random() * 1_000_000_000);
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('QEMU control request timed out')), 8000);
    const done = (error?: Error, result?: unknown) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
    const send = (value: unknown) => socket.write(JSON.stringify(value) + '\n');
    const request = () => send({ execute, ...(args ? { arguments: args } : {}), id: 1 });
    socket.on('error', error => done(error));
    socket.on('end', () => done(new Error('QEMU control connection closed')));
    socket.on('connect', () => {
      if (guest) { socket.write(Buffer.from([255])); send({ execute: 'guest-sync-delimited', arguments: { id: sync } }); }
    });
    let synchronized = !guest;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4 * 1024 * 1024) { done(new Error('QEMU response exceeds limit')); return; }
      let index: number;
      while ((index = buffer.indexOf(10)) !== -1) {
        let line = buffer.subarray(0, index); buffer = buffer.subarray(index + 1);
        const sentinel = line.lastIndexOf(255);
        if (sentinel !== -1) line = line.subarray(sentinel + 1);
        let value: any;
        try { value = JSON.parse(line.toString()); } catch { if (synchronized) done(new Error('Invalid QEMU response')); continue; }
        if (!synchronized) { if (value.return === sync) { synchronized = true; request(); } continue; }
        if (value.QMP) { send({ execute: 'qmp_capabilities', id: 0 }); continue; }
        if (value.id === 0) { if (value.error) done(new Error(value.error.desc)); else request(); continue; }
        if (value.id === 1) { done(value.error ? new Error(value.error.desc) : undefined, value.return); return; }
      }
    });
  }));
  queues.set(path, work);
  void work.finally(() => { if (queues.get(path) === work) queues.delete(path); }).catch(() => {});
  return work;
}

export async function guestExec(socket: string, path: string, args: string[], input?: unknown, timeout = 45_000): Promise<string> {
  const { pid } = await rpc(socket, 'guest-exec', { path, arg: args, 'capture-output': true,
    ...(input === undefined ? {} : { 'input-data': Buffer.from(JSON.stringify(input)).toString('base64') }) }, true);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = await rpc(socket, 'guest-exec-status', { pid }, true);
    if (status.exited) {
      if (status['out-truncated'] || status['err-truncated']) throw new Error('Guest response exceeded QGA output limit');
      const output = Buffer.from(status['out-data'] ?? '', 'base64').toString();
      if (status.exitcode !== 0) throw new Error(Buffer.from(status['err-data'] ?? '', 'base64').toString().slice(0, 1000) || 'Guest operation failed');
      return output;
    }
    await delay(80);
  }
  throw new Error('Guest operation timed out; reconcile before resuming');
}

export function vmArguments(directory: string, disk: string, memory: number, extra: string[] = [], proxyBridge = false) {
  const escape = (value: string) => value.replaceAll(',', ',,');
  return ['-name', 'pi-desktop', '-machine', 'q35,accel=kvm', '-cpu', 'host', '-smp', '2', '-m', String(memory),
    '-drive', `file=${escape(disk)},format=qcow2,if=virtio,cache=none`,
    '-vga', 'std', '-display', 'none', '-device', 'qemu-xhci', '-device', 'usb-tablet',
    '-qmp', `unix:${escape(directory)}/qmp.sock,server=on,wait=off`,
    '-chardev', `socket,path=${escape(directory)}/qga.sock,server=on,wait=off,id=qga`,
    '-device', 'virtio-serial', '-device', 'virtserialport,chardev=qga,name=org.qemu.guest_agent.0',
    '-serial', `file:${directory}/serial.log`, '-monitor', 'none',
    // libslirp calls setsid() before executing the fixed bridge. That syscall
    // is in QEMU's "privileged" deny group, so online VMs use no_new_privs
    // instead (set before exec below), while retaining the other filters.
    '-sandbox', `on,obsolete=deny,elevateprivileges=${proxyBridge ? 'allow' : 'deny'},spawn=${proxyBridge ? 'allow' : 'deny'},resourcecontrol=deny`,
    '-pidfile', directory + '/qemu.pid', ...extra];
}

export async function startVM(directory: string, disk: string, memory: number, extra: string[] = [], proxyBridge = false) {
  const log = await open(directory + '/qemu.log', 'a', 0o600);
  const args = vmArguments(directory, disk, memory, extra, proxyBridge);
  const child = spawn(proxyBridge ? 'setpriv' : 'qemu-system-x86_64', proxyBridge ? ['--no-new-privs', 'qemu-system-x86_64', ...args] : args,
    { detached: true, stdio: ['ignore', log.fd, log.fd], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' } });
  let failure: Error | undefined;
  child.once('error', error => { failure = error; });
  child.once('exit', (code, signal) => { failure = new Error(`QEMU exited (${code ?? signal}); inspect ${directory}/qemu.log`); });
  child.unref();
  await log.close();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (failure) throw failure;
    try { await rpc(directory + '/qmp.sock', 'query-status'); return; }
    catch { await delay(100); }
  }
  child.kill('SIGKILL');
  throw new Error('QEMU did not become ready');
}
