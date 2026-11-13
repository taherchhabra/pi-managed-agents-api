import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceUnavailable, type ArtifactData, type Job, type ToolName, type ToolResult } from './domain.js';

export interface Sandbox {
  execute(name: ToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
  artifacts(signal: AbortSignal): Promise<ArtifactData[]>;
  close(): Promise<void>;
}
export interface SandboxProvider {
  open(job: Job, signal: AbortSignal): Promise<Sandbox>;
  stopGeneration(sessionId: string, epoch: number): Promise<void>;
  destroySession(sessionId: string): Promise<void>;
}

// Commands are argv, never interpolated into a host shell. Shell text is sent
// only to bash inside the container. Bound both captured output and wall time.
export function docker(args: string[], options: { input?: string; signal?: AbortSignal; timeout?: number; maxBytes?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error('Sandbox operation timed out'); child.kill('SIGKILL'); }, options.timeout ?? 30_000);
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? 128 * 1024)) {
        failure = new Error('Sandbox output limit exceeded'); child.kill('SIGKILL');
      } else target.push(chunk);
    };
    child.stdout.on('data', collect(chunks));
    child.stderr.on('data', collect(errors));
    child.stdin.on('error', () => {}); // EPIPE when exec exits before consuming input.
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      const stderr = Buffer.concat(errors).toString('utf8');
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(stderr.trim() || `Sandbox command exited with status ${code}`));
      else resolve(Buffer.concat(chunks).toString('utf8') + stderr);
    });
    child.stdin.end(options.input);
  });
}

async function removeContainers(names: string[]) {
  // The local abort path and a replacement owner can both stop the same
  // generation. Docker reports a transient conflict while removal is running.
  for (let attempt = 0; ; attempt++) {
    try { await docker(['rm', '-f', ...names]); return; }
    catch (error) {
      if (attempt >= 20 || !(error instanceof Error) || !error.message.includes('already in progress')) throw error;
      await delay(100);
    }
  }
}

// File helpers run as the sandbox user. resolve() blocks traversal and symlinks
// outside the workspace. Shell has access to the container, never the host.
const fileScript = `
import json, pathlib, sys
args = json.load(sys.stdin)
try:
    root = pathlib.Path('/workspace').resolve()
    path = (root / args['path']).resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError('Path must be a file inside /workspace')
    if args['operation'] == 'read_file':
        with path.open('rb') as f: data = f.read(65537)
        if len(data) > 65536: raise ValueError('File exceeds the 64 KiB read limit')
        text = data.decode('utf-8')
    else:
        data = args['content'].encode('utf-8')
        if len(data) > 65536: raise ValueError('File exceeds the 64 KiB write limit')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        text = 'Wrote ' + str(len(data)) + ' bytes to ' + str(path)
    print(json.dumps({'text': text}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({'text': str(e), 'isError': True}))
`;

const bashScript = `
import json, os, signal, subprocess, sys, tempfile
args = json.load(sys.stdin)
with tempfile.TemporaryFile() as output:
    process = subprocess.Popen(['bash', '-lc', args['command']], stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    try: code = process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        raise RuntimeError('Shell command exceeded the 30 second limit')
    output.seek(0)
    data = output.read(65537)
    text = data[:65536].decode('utf-8', errors='replace')
    if len(data) > 65536: text += '\\n[output truncated at 64 KiB]'
    if code != 0: text += '\\n[exit code ' + str(code) + ']'
    print(json.dumps({'text': text, 'isError': code != 0}, ensure_ascii=False))
`;

const artifactScript = `
import base64, json, os, pathlib, stat
root = pathlib.Path('/workspace/outputs')
result = []
total = 0
if root.is_symlink(): raise ValueError('Artifact directory cannot be a symlink')
if root.exists():
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not pathlib.Path(directory, d).is_symlink())
        for name in sorted(files):
            path = pathlib.Path(directory, name)
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode): continue
            if not stat.S_ISREG(mode): raise ValueError('Artifacts must be regular files')
            with path.open('rb') as f: data = f.read(5 * 1024 * 1024 + 1)
            total += len(data)
            if len(data) > 5 * 1024 * 1024 or total > 20 * 1024 * 1024 or len(result) >= 20:
                raise ValueError('Artifact limit exceeded: 20 files, 5 MiB each, 20 MiB total')
            result.append({'path': str(path.relative_to(root)), 'data': base64.b64encode(data).decode()})
print(json.dumps(result))
`;

const safeSession = (id: string) => {
  if (!/^ses_[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid internal session ID');
  return id.replaceAll('_', '-');
};

export class DockerSandboxProvider implements SandboxProvider {
  private volume(session: string) { return 'pi-workspace-' + safeSession(session); }
  private async containers(session: string) {
    return (await docker(['ps', '-aq', '--filter', 'label=pi-managed.session=' + session])).trim().split('\n').filter(Boolean);
  }
  async stopGeneration(session: string, epoch: number) {
    const name = 'pi-' + safeSession(session) + '-' + epoch;
    await removeContainers([name, name + '-export']);
  }
  async destroySession(session: string) {
    const containers = await this.containers(session);
    if (containers.length) await removeContainers(containers);
    // Inspect first: missing volumes are already clean, other failures must retry.
    const volumes = (await docker(['volume', 'ls', '-q', '--filter', 'name=^' + this.volume(session) + '$'])).trim();
    if (volumes) await docker(['volume', 'rm', this.volume(session)]);
  }
  async open(job: Job, signal: AbortSignal): Promise<Sandbox> {
    signal.throwIfAborted();
    if (!job.environment.image) throw new Error('Managed environment has no sandbox image');
    const name = 'pi-' + safeSession(job.session_id) + '-' + job.epoch;
    // Never recreate a missing workspace for a session that has executed work.
    if (job.workspace_initialized) {
      const existing = (await docker(['volume', 'ls', '-q', '--filter', 'name=^' + this.volume(job.session_id) + '$'], { signal })).trim();
      if (!existing) throw new WorkspaceUnavailable();
    }
    let closed = false;
    let stopWork: Promise<void> | undefined;
    let closeWork: Promise<void> | undefined;
    const stopExecution = (): Promise<void> => {
      if (closed) return Promise.resolve();
      return stopWork ??= removeContainers([name]).then(() => { closed = true; })
        .catch(error => { stopWork = undefined; throw error; });
    };
    const close = (): Promise<void> => {
      return closeWork ??= (async () => { await stopExecution(); await removeContainers([name + '-export']); })()
        .catch(error => { closeWork = undefined; throw error; });
    };
    try {
      await docker(['run', '-d', '--name', name,
        '--label', 'pi-managed.session=' + job.session_id, '--label', 'pi-managed.epoch=' + job.epoch,
        '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '128', '--cpus', '1', '--memory', '512m', '--memory-swap', '512m',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--init', '--user', '10001:10001',
        '--workdir', '/workspace', '--mount', 'type=volume,src=' + this.volume(job.session_id) + ',dst=/workspace',
        '--pull', 'never', job.environment.image, 'sleep', 'infinity'], { signal });
      signal.throwIfAborted();
    } catch (error) {
      await close().catch(() => {});
      throw error;
    }
    const stopOnAbort = () => { void close().catch(() => {}); };
    signal.addEventListener('abort', stopOnAbort, { once: true });
    return {
      execute: async (tool, args, toolSignal) => {
        toolSignal.throwIfAborted();
        try {
          const raw = await docker(['exec', '-i', name, 'python3', '-c', tool === 'bash' ? bashScript : fileScript], {
            input: JSON.stringify({ ...args, operation: tool }), signal: toolSignal, maxBytes: 512 * 1024, timeout: 35_000,
          });
          return JSON.parse(raw) as ToolResult;
        } catch (error) {
          // Killing docker exec alone doesn't kill a command inside the container.
          // Close the entire generation before returning an error to the harness.
          await close();
          throw error;
        }
      },
      artifacts: async artifactSignal => {
        // Terminate all agent processes, including detached children, before
        // mounting the workspace read-only in a separate export container.
        await stopExecution();
        const raw = await docker(['run', '--rm', '--name', name + '-export',
          '--label', 'pi-managed.session=' + job.session_id,
          '--label', 'pi-managed.epoch=' + job.epoch,
          '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          '--pids-limit', '32', '--cpus', '1', '--memory', '256m', '--memory-swap', '256m',
          '--user', '10001:10001', '--mount', 'type=volume,src=' + this.volume(job.session_id) + ',dst=/workspace,readonly',
          '--pull', 'never', '--entrypoint', 'python3', job.environment.image!, '-c', artifactScript],
          { signal: artifactSignal, maxBytes: 30 * 1024 * 1024 });
        const data = JSON.parse(raw) as { path: string; data: string }[];
        return data.map(file => ({ path: file.path, bytes: Buffer.from(file.data, 'base64') }));
      },
      close: async () => { signal.removeEventListener('abort', stopOnAbort); await close(); },
    };
  }
}
