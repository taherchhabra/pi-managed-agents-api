import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ArtifactStore } from './artifacts.js';
import { LeaseLost, WorkspaceUnavailable, type Job } from './domain.js';
import { type Runtime, type RuntimeFactory } from './runtime.js';
import { type Sandbox, type SandboxProvider } from './sandbox.js';
import { Store } from './store.js';

export interface WorkerOptions {
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  runTimeoutMs?: number;
  onError?: (error: unknown) => void;
}
export class Worker {
  readonly owner = randomUUID();
  private stopping = false;
  private loop?: Promise<void>;
  private current?: AbortController;
  private wake = new AbortController();
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  constructor(private store: Store, private runtimeFactory: RuntimeFactory, private sandboxes: SandboxProvider,
    private artifacts: ArtifactStore, private options: WorkerOptions = {}) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? 5_000;
    if (this.heartbeatMs >= this.leaseMs / 2) throw new Error('Heartbeat must be less than half the lease interval');
  }
  start() {
    if (this.loop) return;
    this.loop = this.poll();
  }
  async stop() {
    this.stopping = true;
    this.wake.abort();
    this.current?.abort(new Error('Worker is shutting down'));
    await this.loop;
  }
  private async poll() {
    while (!this.stopping) {
      try {
        await this.store.recoverExpired((id, epoch) => this.sandboxes.stopGeneration(id, epoch));
        await this.store.cleanupArchived(id => this.sandboxes.destroySession(id));
        if (await this.processOne()) continue;
      } catch (error) { this.options.onError?.(error); }
      await delay(this.options.pollMs ?? 500, undefined, { signal: this.wake.signal }).catch(() => {});
    }
  }
  async processOne(): Promise<boolean> {
    if (this.stopping) return false;
    const job = await this.store.claim(this.owner, this.leaseMs);
    if (!job) return false;
    await this.execute(job);
    return true;
  }
  private async execute(job: Job) {
    const controller = new AbortController();
    this.current = controller;
    let sandbox: Sandbox | undefined;
    let runtime: Runtime | undefined;
    let userCancelled = false;
    let leaseLost = false;
    let heartbeatWork: Promise<void> = Promise.resolve();
    const heartbeat = async () => {
      try {
        const state = await this.store.heartbeat(job, this.leaseMs);
        if (state === 'cancelling') { userCancelled = true; controller.abort(new Error('Run cancelled')); }
      } catch (error) {
        leaseLost = true;
        controller.abort(error);
      }
    };
    let heartbeatBusy = false;
    const ticker = setInterval(() => {
      if (!heartbeatBusy) {
        heartbeatBusy = true;
        heartbeatWork = heartbeat().finally(() => { heartbeatBusy = false; });
      }
    }, this.heartbeatMs);
    const deadline = setTimeout(() => controller.abort(new Error('Run exceeded its wall-clock limit')), this.options.runTimeoutMs ?? 300_000);
    const close = async () => {
      // Stop effects before publishing a terminal status or releasing ownership.
      const results = await Promise.allSettled([runtime?.close(), sandbox?.close()]);
      if (results[0]!.status === 'fulfilled') runtime = undefined;
      if (results[1]!.status === 'fulfilled') sandbox = undefined;
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    };
    try {
      if (job.environment.type !== 'none') {
        sandbox = await this.sandboxes.open(job, controller.signal);
        // A slow provision can outlive a lease. Verify again before any model/tool work.
        await this.store.workspaceReady(job);
      }
      runtime = await this.runtimeFactory(job, {
        signal: controller.signal,
        execute: async (call, name, args, checkpoint) => {
          controller.signal.throwIfAborted();
          if (!sandbox || !job.config.tools.includes(name)) throw new Error('Tool is not permitted for this session');
          await this.store.startTool(job, call, name, args, checkpoint);
          controller.signal.throwIfAborted();
          const result = await sandbox.execute(name, args, controller.signal);
          const images = [];
          for (const image of result.images ?? []) {
            const bytes = Buffer.from(image.data, 'base64');
            if (bytes.length > 1024 * 1024 || image.mimeType !== 'image/jpeg') throw new Error('Invalid desktop screenshot');
            images.push({ ...await this.artifacts.publish({ path: 'screenshot.jpg', bytes }), width: image.width, height: image.height });
          }
          await this.store.endTool(job, call, result, images);
          return result;
        },
      });
      const result = await runtime.run();
      const files = sandbox ? await sandbox.artifacts(controller.signal) : [];
      const artifacts = [];
      for (const file of files) artifacts.push(await this.artifacts.publish(file));
      await close();
      controller.signal.throwIfAborted();
      await this.store.finish(job, 'completed', result.checkpoint, result.output, null, result.usage, artifacts);
    } catch (error) {
      // If cleanup fails, leave ownership to expire rather than admitting a new
      // run beside an executor whose processes might still be running.
      await close();
      if (error instanceof LeaseLost || leaseLost) return;
      if (userCancelled) await this.store.finish(job, 'cancelled', null, '', null, null);
      else if (error instanceof WorkspaceUnavailable || this.stopping || await this.store.hasTools(job)) {
        await this.store.interrupt(job, error instanceof WorkspaceUnavailable ? error.message : this.stopping ? 'Worker stopped. Explicit recovery is required.' : 'Execution stopped after tool dispatch. Reconcile workspace effects before new work.');
      } else {
        await this.store.finish(job, 'failed', null, '', { code: 'execution_failed', message: error instanceof Error ? error.message : 'Execution failed' }, null);
      }
    } finally {
      clearInterval(ticker);
      clearTimeout(deadline);
      await heartbeatWork;
      this.current = undefined;
    }
  }
}
