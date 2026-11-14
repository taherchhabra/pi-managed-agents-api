import { ApiError, WorkspaceUnavailable, type Job, type ToolResult } from '../domain.js';
import type { Sandbox, SandboxProvider } from '../sandbox.js';

export interface DesktopStatus {
  state: 'not_started' | 'starting' | 'running' | 'paused' | 'stopped';
  platform: 'linux'; network: 'none'; width: number; height: number;
}

// Only the control plane knows this credential. Guests and browser clients
// never receive a desktop-host address, socket path, or token.
export class DesktopClient implements SandboxProvider {
  constructor(private url: string, private token: string) {}
  private async request(path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(this.url + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + this.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]) });
    if (!response.ok) {
      const value = await response.json() as { error?: { code?: string; message?: string } };
      if (value.error?.code === 'workspace_unavailable') throw new WorkspaceUnavailable();
      throw new ApiError(response.status, value.error?.code ?? 'desktop_unavailable', value.error?.message ?? 'Desktop host is unavailable');
    }
    return response;
  }
  async status(session: string, tenant: string): Promise<DesktopStatus> {
    return (await this.request(`/sessions/${session}?tenant=${encodeURIComponent(tenant)}`)).json() as Promise<DesktopStatus>;
  }
  async frame(session: string, tenant: string): Promise<Buffer> {
    const response = await this.request(`/sessions/${session}/frame?tenant=${encodeURIComponent(tenant)}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 1024 * 1024) throw new Error('Desktop frame exceeds limit');
    return bytes;
  }
  async open(job: Job, signal: AbortSignal): Promise<Sandbox> {
    const path = `/sessions/${job.session_id}`;
    const owner = { tenant: job.tenant_id, epoch: job.epoch };
    try { await this.request(path + '/open', { ...owner, initialized: job.workspace_initialized }, signal); }
    catch (error) { await this.stopGeneration(job.session_id, job.epoch); throw error; }
    let closed: Promise<void> | undefined;
    const close = () => closed ??= this.request(path + '/close', owner).then(() => {}).catch(error => { closed = undefined; throw error; });
    const stop = () => { void close().catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) { await close(); signal.throwIfAborted(); }
    return {
      execute: async (name, args, toolSignal) => {
        const result = await (await this.request(path + '/tool', { ...owner, name, args }, toolSignal)).json() as ToolResult;
        if (!result || typeof result.text !== 'string' || (result.images?.length ?? 0) > 1) throw new Error('Invalid desktop tool response');
        return result;
      },
      artifacts: async toolSignal => {
        const files = await (await this.request(path + '/artifacts', owner, toolSignal)).json() as { path: string; data: string }[];
        let total = 0;
        if (files.length > 20) throw new Error('Desktop artifact limit exceeded');
        return files.map(file => {
          const bytes = Buffer.from(file.data, 'base64'); total += bytes.length;
          if (bytes.length > 5 * 1024 * 1024 || total > 20 * 1024 * 1024) throw new Error('Desktop artifact limit exceeded');
          return { path: file.path, bytes };
        });
      },
      close: async () => { signal.removeEventListener('abort', stop); await close(); },
    };
  }
  async stopGeneration(session: string, epoch: number) { await this.request(`/sessions/${session}/fence`, { epoch }); }
  async destroySession(session: string) { await this.request(`/sessions/${session}/destroy`, {}); }
}

export class EnvironmentSandboxProvider implements SandboxProvider {
  constructor(private docker: SandboxProvider, private desktop: DesktopClient | undefined,
    private environment: (session: string) => Promise<string>) {}
  private provider(type: string) {
    if (type === 'desktop') {
      if (!this.desktop) throw new Error('Desktop host is not configured');
      return this.desktop;
    }
    return this.docker;
  }
  open(job: Job, signal: AbortSignal) { return this.provider(job.environment.type).open(job, signal); }
  async stopGeneration(session: string, epoch: number) { await this.provider(await this.environment(session)).stopGeneration(session, epoch); }
  async destroySession(session: string) { await this.provider(await this.environment(session)).destroySession(session); }
}
