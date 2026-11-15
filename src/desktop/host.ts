import Fastify from 'fastify';
import { timingSafeEqual, createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, WorkspaceUnavailable, type ToolImage, type ToolResult } from '../domain.js';
import { command, guestExec, rpc, startVM } from './qemu.js';
import { HCU_REVISION } from './hcu-contract.js';
import { normalizeNetwork, offlineNetwork, type NetworkPolicy } from '../network-policy.js';
import { EgressProxy } from './egress.js';

interface State { tenant: string; epoch: number; closed: boolean; base: string; network: NetworkPolicy }
interface VM { state: State; directory: string; runtime: string; starting?: Promise<void>; closing?: Promise<void>; busy?: Promise<unknown>; preview?: Promise<Buffer>; frameAt?: number; egress?: EgressProxy }
export interface HostOptions { root: string; base: string; token: string; memory?: number; maxVMs?: number; runtime?: string; blockedCIDRs?: string[] }
const hash = (value: string) => createHash('sha256').update(value).digest();
const idPattern = /^ses_[0-9a-f-]{36}$/;

export class DesktopHost {
  private vms = new Map<string, VM>();
  private admission: Promise<unknown> = Promise.resolve();
  private openings = new Map<string, Promise<void>>();
  private fences = new Map<string, number>();
  private helpers: Record<string, string> = {};
  private lock = createServer();
  readonly root: string;
  readonly runtime: string;
  constructor(readonly options: HostOptions) {
    this.root = resolve(options.root);
    this.runtime = options.runtime ?? join(tmpdir(), `pi-desktop-${process.getuid?.() ?? 0}-${hash(this.root).toString('hex').slice(0, 10)}`);
  }
  private path(vm: VM, name: string) { return join(vm.runtime, name); }
  private async save(vm: VM) {
    await writeFile(join(vm.directory, 'state.json.tmp'), JSON.stringify(vm.state), { mode: 0o600 });
    await rename(join(vm.directory, 'state.json.tmp'), join(vm.directory, 'state.json'));
  }
  private async qmp(vm: VM, name: string) { return rpc(this.path(vm, 'qmp.sock'), name); }
  private async guest(vm: VM, operation: string, epoch: number, body?: unknown) {
    return guestExec(this.path(vm, 'qga.sock'), '/usr/bin/python3', ['/usr/local/lib/pi-desktop/runner.py', operation, String(epoch)], body);
  }
  async init() {
    if (process.getuid?.() === 0) throw new Error('Run the desktop host as a non-root user with KVM access');
    await access('/dev/kvm', constants.R_OK | constants.W_OK);
    await access(this.options.base, constants.R_OK);
    for (const name of ['runner.py','tool.py']) this.helpers[name] = await readFile(resolve('deploy/desktop', name), 'utf8');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(this.runtime, { recursive: true, mode: 0o700 });
    // Kernel releases the lock on crash. Do not delete a live daemon's socket.
    const lockPath = join(this.runtime, 'host.sock');
    const probe = await import('node:net');
    const live = await new Promise<boolean>(resolve => {
      const socket = probe.createConnection(lockPath);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
    if (live) throw new Error('A desktop host already owns this data directory');
    await rm(lockPath, { force: true });
    await new Promise<void>((resolve, reject) => { this.lock.once('error', reject); this.lock.listen(lockPath, resolve); });
    this.lock.on('connection', socket => socket.end());
    const entries = await readdir(this.root);
    for (const name of entries) {
      const match = /^(ses_[0-9a-f-]{36})\.fence\.([0-9]+)$/.exec(name);
      if (match) this.fences.set(match[1]!, Math.max(this.fences.get(match[1]!) ?? 0, Number(match[2])));
    }
    for (const name of entries) {
      if (!idPattern.test(name)) continue;
      const directory = join(this.root, name);
      const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as State;
      state.network = normalizeNetwork(state.network);
      const vm: VM = { state, directory, runtime: join(this.runtime, name.slice(4)) };
      this.vms.set(name, vm);
      // Restart never silently continues a model's old in-flight input.
      await this.close(name, state.epoch);
    }
  }
  private get(id: string, tenant?: string) {
    if (!idPattern.test(id)) throw new ApiError(400, 'invalid_session', 'Invalid session ID');
    const vm = this.vms.get(id);
    if (vm && tenant !== undefined && vm.state.tenant !== tenant) throw new ApiError(404, 'not_found', 'Desktop not found');
    return vm;
  }
  private active(id: string, tenant: string, epoch: number) {
    const vm = this.get(id, tenant);
    if (!vm || vm.state.closed || vm.state.epoch !== epoch || vm.closing || (this.fences.get(id) ?? 0) >= epoch) throw new ApiError(409, 'desktop_fenced', 'Desktop ownership changed; do not replay input');
    return vm;
  }
  async status(id: string, tenant: string) {
    const vm = this.get(id, tenant);
    let state = 'not_started';
    if (vm) {
      if (vm.starting) state = 'starting';
      else {
        try { state = (await this.qmp(vm, 'query-status')).running ? 'running' : 'paused'; }
        catch { state = 'stopped'; }
      }
    }
    return { state, platform: 'linux', driver: 'hcu', hcu_revision: HCU_REVISION, network: vm?.state.network ?? offlineNetwork(),
      network_activity: vm?.egress?.activity ?? null, width: 1280, height: 800 };
  }
  async open(id: string, tenant: string, epoch: number, initialized: boolean, network?: unknown) {
    const policy = normalizeNetwork(network);
    const work = this.admission.catch(() => {}).then(async () => {
      if ((this.fences.get(id) ?? 0) >= epoch) throw new ApiError(409, 'desktop_fenced', 'This desktop generation was already fenced');
      let vm = this.get(id, tenant);
      if (vm && JSON.stringify(vm.state.network) !== JSON.stringify(policy)) throw new ApiError(409, 'network_policy_pinned', 'A desktop session keeps its original network policy. Start a new session with the new environment.');
      if (vm && (epoch < vm.state.epoch || (epoch === vm.state.epoch && vm.state.closed))) throw new ApiError(409, 'desktop_fenced', 'This desktop generation was already closed');
      if (vm && epoch === vm.state.epoch && !vm.state.closed) { await vm.starting; return; }
      if (vm && !vm.state.closed) throw new ApiError(409, 'desktop_busy', 'Close the previous desktop generation first');
      if (!vm && initialized) throw new WorkspaceUnavailable();
      if (!vm) {
        vm = { state: { tenant, epoch, closed: false, base: resolve(this.options.base), network: policy }, directory: join(this.root, id), runtime: join(this.runtime, id.slice(4)) };
        await mkdir(vm.directory, { recursive: true, mode: 0o700 });
        await this.save(vm);
        this.vms.set(id, vm);
      }
      const current = vm;
      await current.closing;
      current.state = { ...current.state, epoch, closed: false };
      await this.save(current);
      current.starting = (async () => {
        await mkdir(current.runtime, { recursive: true, mode: 0o700 });
        const connected = policy.mode !== 'off';
        const socket = this.path(current, 'egress.sock');
        if (connected) {
          await current.egress?.close();
          current.egress = new EgressProxy(socket, policy, { blockedCIDRs: this.options.blockedCIDRs });
          await current.egress.start();
          this.active(id, tenant, epoch);
        }
        let running = false;
        try { running = !!(await this.qmp(current, 'query-status')); } catch {}
        if (!running) {
          let count = 0;
          for (const other of this.vms.values()) {
            try { await this.qmp(other, 'query-status'); count++; } catch {}
          }
          if (count >= (this.options.maxVMs ?? 2)) throw new ApiError(503, 'desktop_capacity', 'Desktop capacity reached. Archive an unused desktop session or increase host capacity.');
          const disk = join(current.directory, 'disk.qcow2');
          try { await access(disk); }
          catch {
            if (initialized) throw new WorkspaceUnavailable();
            await command('qemu-img', ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', current.state.base, disk]);
          }
          // QEMU routes no ordinary guest packets. Only this fixed endpoint
          // reaches the per-session Unix proxy, which checks every destination.
          const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
          const bridge = ['/usr/bin/python3', resolve('deploy/desktop/proxy-bridge.py'), socket].map(quote).join(' ');
          const nic = connected ? `user,model=virtio-net-pci,restrict=on,ipv6=off,guestfwd=tcp:10.0.2.100:3128-cmd:${bridge.replaceAll(',', ',,')}` : 'none';
          await startVM(current.runtime, disk, this.options.memory ?? 1536, ['-nic', nic], connected);
        } else await this.qmp(current, 'cont');
        const deadline = Date.now() + 90_000;
        while (true) {
          try {
            await guestExec(this.path(current, 'qga.sock'), '/usr/bin/test', ['-S', '/tmp/.X11-unix/X0']);
            await guestExec(this.path(current, 'qga.sock'), '/usr/bin/test', ['-S', '/run/user/1000/bus']);
            break;
          } catch (error) { if (Date.now() > deadline) throw error; await delay(500); }
        }
        this.active(id, tenant, epoch);
        // The host owns the guest protocol version. Install only these two
        // trusted helpers, never model-supplied code, before admitting input.
        await guestExec(this.path(current, 'qga.sock'), '/usr/bin/python3', ['-c',
          "import json,sys,pathlib; a=json.load(sys.stdin); root=pathlib.Path('/usr/local/lib/pi-desktop'); root.mkdir(parents=True,exist_ok=True); [(root.joinpath(n).write_text(a[n]),root.joinpath(n).chmod(0o644)) for n in ('runner.py','tool.py')]"] , this.helpers);
        this.active(id, tenant, epoch);
        await this.guest(current, 'start', epoch, { network: policy });
        // Read-only readiness probe: Xfce and RandR can still be settling after
        // their sockets appear. Never admit model input without a valid frame.
        const captureDeadline = Date.now() + 15_000;
        while (true) {
          this.active(id, tenant, epoch);
          const probe = JSON.parse(await this.guest(current, 'run', epoch, {
            name: 'GUI', args: { actions: [{ type: 'screenshot' }] }, session: 'pi-' + epoch,
          })) as ToolResult;
          if (!probe.isError && probe.images?.length) break;
          if (Date.now() >= captureDeadline) throw new Error('HCU could not capture the desktop before input admission');
          await delay(250);
        }
      })();
      try { await current.starting; }
      catch (error) {
        await current.egress?.close();
        try { await this.qmp(current, 'stop'); } catch {}
        throw error;
      }
      finally { current.starting = undefined; }
    });
    this.admission = work;
    this.openings.set(id, work);
    try { await work; } finally { if (this.openings.get(id) === work) this.openings.delete(id); }
  }
  async tool(id: string, tenant: string, epoch: number, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const vm = this.active(id, tenant, epoch);
    if (!['AX','GUI','bash','read_file','write_file'].includes(name)) throw new ApiError(400, 'invalid_tool', 'Unknown desktop tool');
    if (vm.busy) throw new ApiError(409, 'desktop_busy', 'Desktop input must be sequential');
    const work = (async () => {
      this.active(id, tenant, epoch);
      const result = JSON.parse(await this.guest(vm, 'run', epoch, { name, args, session: 'pi-' + epoch })) as ToolResult;
      this.active(id, tenant, epoch);
      if (typeof result.text !== 'string' || (result.images?.length ?? 0) > 1) throw new Error('Invalid HCU response');
      return result;
    })();
    vm.busy = work;
    try { return await work; } finally { if (vm.busy === work) vm.busy = undefined; }
  }
  async frame(id: string, tenant: string): Promise<Buffer> {
    const vm = this.get(id, tenant);
    if (!vm) throw new ApiError(409, 'desktop_not_started', 'Send a task to start this desktop');
    const cached = () => readFile(join(vm.directory, 'preview.jpg')).catch(() => { throw new ApiError(409, 'desktop_starting', 'Waiting for the first desktop frame'); });
    if (vm.state.closed || vm.closing || vm.starting || vm.busy || Date.now() - (vm.frameAt ?? 0) < 2000) return cached();
    return vm.preview ??= (async () => {
      const frame = JSON.parse(await this.guest(vm, 'run', vm.state.epoch, { name: 'frame' })) as ToolImage;
      if (!frame.data || frame.mimeType !== 'image/jpeg') throw new Error('Desktop frame unavailable');
      const bytes = Buffer.from(frame.data, 'base64');
      if (bytes.length > 1024 * 1024) throw new Error('Desktop frame exceeds limit');
      await writeFile(join(vm.directory, 'preview.jpg.tmp'), bytes, { mode: 0o600 });
      await rename(join(vm.directory, 'preview.jpg.tmp'), join(vm.directory, 'preview.jpg'));
      vm.frameAt = Date.now();
      return bytes;
    })().finally(() => { vm.preview = undefined; });
  }
  async artifacts(id: string, tenant: string, epoch: number) {
    const vm = this.active(id, tenant, epoch);
    if (vm.busy) throw new ApiError(409, 'desktop_busy', 'Desktop is executing a tool');
    const call = async (name: string, args = {}) => { this.active(id, tenant, epoch); return JSON.parse(await this.guest(vm, 'run', epoch, { name, args })); };
    const files = await call('artifact_list') as { path: string; size: number; sha256: string }[];
    if (!Array.isArray(files) || files.length > 20 || files.reduce((n, f) => n + f.size, 0) > 20 * 1024 * 1024) throw new Error('Desktop artifact limit exceeded');
    const result = [];
    for (const file of files) {
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 5 * 1024 * 1024) throw new Error('Invalid desktop artifact');
      const chunks = [];
      for (let offset = 0; offset < file.size; offset += 128 * 1024) {
        const chunk = await call('artifact_read', { path: file.path, offset });
        if (typeof chunk.data !== 'string') throw new Error('Desktop artifact changed during export');
        chunks.push(Buffer.from(chunk.data, 'base64'));
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Desktop artifact changed during export');
      result.push({ path: file.path, data: bytes.toString('base64') });
    }
    return result;
  }
  async close(id: string, epoch: number) {
    if (!idPattern.test(id)) throw new ApiError(400, 'invalid_session', 'Invalid session ID');
    this.fences.set(id, Math.max(epoch, this.fences.get(id) ?? 0));
    const opening = this.get(id);
    if (opening && epoch >= opening.state.epoch) await opening.egress?.close();
    await writeFile(join(this.root, `${id}.fence.${epoch}`), '', { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await this.openings.get(id)?.catch(() => {});
    const vm = this.get(id);
    if (!vm || epoch < vm.state.epoch) return;
    if (vm.closing) return vm.closing;
    vm.state.closed = true;
    vm.state.epoch = Math.max(epoch, vm.state.epoch);
    vm.closing = (async () => {
      // Revoke proxy connections before waiting for guest input to stop.
      await vm.egress?.close();
      await this.save(vm);
      await vm.starting?.catch(() => {});
      let status;
      try { status = await this.qmp(vm, 'query-status'); } catch { return; }
      if (!status.running) return;
      // The guest fences before killing its processes. A delayed QGA dispatch
      // cannot start input after the cancellation barrier.
      try {
        await this.guest(vm, 'stop', epoch);
        await Promise.allSettled([vm.busy, vm.preview]);
        // Capture the final screen independently of HCU's observation state.
        const frame = JSON.parse(await this.guest(vm, 'run', 0, { name: 'frame' })) as ToolImage;
        if (frame.data) await writeFile(join(vm.directory, 'preview.jpg'), Buffer.from(frame.data, 'base64'), { mode: 0o600 });
      } finally { await this.qmp(vm, 'stop'); }
    })();
    try { await vm.closing; } finally { vm.closing = undefined; }
  }
  async destroy(id: string) {
    const vm = this.get(id);
    if (!vm) return;
    await this.close(id, vm.state.epoch);
    try { await this.qmp(vm, 'query-status'); }
    catch { await rm(vm.directory, { recursive: true, force: true }); this.vms.delete(id); return; }
    await this.qmp(vm, 'quit');
    // qemu-img would also detect a held lock, but wait before deleting the disk.
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await this.qmp(vm, 'query-status'); await delay(100); }
      catch { await rm(vm.directory, { recursive: true, force: true }); await rm(vm.runtime, { recursive: true, force: true }); this.vms.delete(id); return; }
    }
    throw new Error('Desktop VM did not stop');
  }
  async shutdown() {
    for (const [id, vm] of this.vms) if (!vm.state.closed) await this.close(id, vm.state.epoch);
    await new Promise<void>(resolve => this.lock.close(() => resolve()));
  }
}

export function buildDesktopHost(host: DesktopHost) {
  const app = Fastify({ bodyLimit: 256 * 1024 });
  app.addHook('onRequest', async request => {
    if (!timingSafeEqual(hash(request.headers.authorization ?? ''), hash('Bearer ' + host.options.token))) throw new ApiError(401, 'unauthorized', 'Desktop host authentication required');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof WorkspaceUnavailable) return reply.code(409).send({ error: { code: 'workspace_unavailable', message: error.message } });
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    console.error('Desktop operation failed:', (error as Error).message.slice(0, 500));
    return reply.code(503).send({ error: { code: 'desktop_unavailable', message: 'Desktop operation failed. Check the desktop host logs before retrying.' } });
  });
  const session = (request: any) => { const id = request.params.id as string; if (!idPattern.test(id)) throw new ApiError(400, 'invalid_session', 'Invalid session ID'); return id; };
  const owner = (body: any) => {
    if (!body || !Number.isSafeInteger(body.epoch) || body.epoch < 1 || typeof body.tenant !== 'string' || !body.tenant || body.tenant.length > 100) throw new ApiError(400, 'invalid_owner', 'Invalid desktop owner');
    return body as { tenant: string; epoch: number };
  };
  const tenant = (request: any) => { const value = request.query.tenant; if (typeof value !== 'string' || !value || value.length > 100) throw new ApiError(400, 'invalid_tenant', 'Tenant required'); return value; };
  app.get('/healthz', async () => ({ status: 'ok', driver: 'hcu', revision: HCU_REVISION }));
  app.get('/sessions/:id', async request => host.status(session(request), tenant(request)));
  app.get('/sessions/:id/frame', async (request, reply) => reply.type('image/jpeg').header('Cache-Control', 'no-store').send(await host.frame(session(request), tenant(request))));
  app.post('/sessions/:id/open', async request => { const body = owner(request.body); await host.open(session(request), body.tenant, body.epoch, (request.body as any).initialized === true, (request.body as any).network); return { ok: true }; });
  app.post('/sessions/:id/tool', async request => { const body = owner(request.body); const { name, args } = request.body as any;
    if (typeof name !== 'string' || !args || Array.isArray(args) || typeof args !== 'object') throw new ApiError(400, 'invalid_tool', 'Tool arguments required');
    return host.tool(session(request), body.tenant, body.epoch, name, args); });
  app.post('/sessions/:id/artifacts', async request => { const body = owner(request.body); return host.artifacts(session(request), body.tenant, body.epoch); });
  app.post('/sessions/:id/close', async request => { const body = owner(request.body); await host.status(session(request), body.tenant); await host.close(session(request), body.epoch); return { ok: true }; });
  app.post('/sessions/:id/fence', async request => { const { epoch } = request.body as any;
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new ApiError(400, 'invalid_epoch', 'Epoch required');
    await host.close(session(request), epoch); return { ok: true }; });
  app.post('/sessions/:id/destroy', async request => { await host.destroy(session(request)); return { ok: true }; });
  return app;
}
