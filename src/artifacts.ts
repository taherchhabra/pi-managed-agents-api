import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { digest, makeId, type ArtifactData } from './domain.js';

export class ArtifactStore {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  async publish(file: ArtifactData) {
    const sha256 = digest(file.bytes);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { await writeFile(join(this.root, sha256), file.bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    // Also verify an existing object before reusing it.
    await this.read(sha256);
    return { id: makeId('art'), path: file.path, sha256, size: file.bytes.length };
  }
  async read(sha256: string) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid artifact digest');
    const bytes = await readFile(join(this.root, sha256));
    if (digest(bytes) !== sha256) throw new Error('Artifact integrity check failed');
    return bytes;
  }
}
