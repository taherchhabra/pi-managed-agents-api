import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { test } from 'node:test';
import { composeEnvironment, initialize, issueKey, revokeKey } from '../scripts/vps.mjs';

test('deployment initialization and key rotation preserve credentials and restrict file permissions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-deploy-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, '.env.vps');
  await initialize(file, 'agents.example.com', 'operator@example.com', 999);
  const original = await readFile(file, 'utf8');
  const env = parseEnv(original);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.match(env.POSTGRES_PASSWORD, /^[a-f0-9]{64}$/);
  assert.equal(Object.values(JSON.parse(env.API_KEYS))[0], 'demo');
  await assert.rejects(initialize(file, 'agents.example.com', 'operator@example.com', 999), { code: 'EEXIST' });
  assert.equal(await readFile(file, 'utf8'), original);
  const output = await issueKey(file, 'my-app', directory);
  const credential = (await readFile(output, 'utf8')).trim();
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  const changed = parseEnv(await readFile(file, 'utf8'));
  assert.equal(changed.POSTGRES_PASSWORD, env.POSTGRES_PASSWORD);
  assert.equal(JSON.parse(changed.API_KEYS)[credential], 'my-app');
  await revokeKey(file, output);
  assert.equal(parseEnv(await readFile(file, 'utf8')).API_KEYS, env.API_KEYS);
  await assert.rejects(issueKey(file, 'bad\nname', directory), /Tenant/);
  await writeFile(file, 'API_KEYS=malformed-private-token');
  await assert.rejects(issueKey(file, 'my-app', directory), { message: 'API_KEYS must be valid JSON' });
});

test('deployment commands use their explicit credentials and the local Docker daemon', () => {
  const env = composeEnvironment({ API_KEYS: 'unrelated-shell-token', DOCKER_HOST: 'tcp://remote.example:2375', DOCKER_CONTEXT: 'remote-context' });
  assert.equal(env.API_KEYS, undefined);
  assert.equal(env.DOCKER_CONTEXT, undefined);
  assert.equal(env.DOCKER_HOST, 'unix:///var/run/docker.sock');
});
