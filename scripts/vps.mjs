import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = () => 'pi_' + randomBytes(32).toString('base64url');
const tenantPattern = /^[a-z][a-z0-9_-]{0,62}$/;
const composeKeys = ['COMPOSE_PROJECT_NAME', 'AGENTS_DOMAIN', 'ACME_EMAIL', 'POSTGRES_PASSWORD', 'API_KEYS',
  'DOCKER_GID', 'SANDBOX_IMAGE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
  'RATE_LIMIT_MAX', 'LOGIN_RATE_LIMIT_MAX', 'API_IMAGE', 'WORKER_IMAGE', 'HTTP_BIND', 'HTTPS_BIND', 'DESKTOP_HOST_URL', 'DESKTOP_HOST_TOKEN'];

// Explicit --env-file is authoritative, even when the operator's shell contains
// credentials from a different local development stack.
export function composeEnvironment(source = process.env) {
  const environment = { ...source };
  for (const key of composeKeys) delete environment[key];
  // The worker mounts this same local daemon. Never accidentally deploy through
  // an operator's remote Docker context while using the local socket group.
  environment.DOCKER_HOST = 'unix:///var/run/docker.sock';
  for (const key of ['DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete environment[key];
  return environment;
}
export async function initialize(file, domain, email, dockerGid) {
  if (!domain || domain.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))
    throw new Error('Supply a DNS hostname, such as agents.example.com, without a scheme or path');
  if (!email || !/^[a-zA-Z0-9.!#$%&*+/=?^_~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email))
    throw new Error('Supply an email address for certificate notices');
  if (!Number.isInteger(dockerGid) || dockerGid < 0) throw new Error('Invalid Docker socket group');
  const workspaceToken = token();
  const text = [
    '# Private deployment configuration. Never commit or share this file.',
    'COMPOSE_PROJECT_NAME=pi-agents',
    'AGENTS_DOMAIN=' + domain,
    "ACME_EMAIL='" + email + "'",
    'POSTGRES_PASSWORD=' + randomBytes(32).toString('hex'),
    "API_KEYS='" + JSON.stringify({ [workspaceToken]: 'demo' }) + "'",
    'DOCKER_GID=' + dockerGid,
    'SANDBOX_IMAGE=pi-managed-sandbox:dev',
    'RATE_LIMIT_MAX=600',
    'LOGIN_RATE_LIMIT_MAX=10',
    '# Set at least one provider key before starting.',
    'OPENROUTER_API_KEY=',
    'OPENAI_API_KEY=',
    'ANTHROPIC_API_KEY=',
    '',
  ].join('\n');
  await writeFile(file, text, { flag: 'wx', mode: 0o600 });
  return { file, tenant: 'demo' };
}
async function update(file, source, key, value) {
  const line = key + "='" + value + "'";
  if (/[\r\n']/.test(value)) throw new Error('Unsupported value in deployment configuration');
  const pattern = new RegExp('^' + key + '=.*$', 'm');
  const body = pattern.test(source) ? source.replace(pattern, () => line) : source.trimEnd() + '\n' + line + '\n';
  const temporary = file + '.' + randomBytes(6).toString('hex') + '.tmp';
  await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}
function configuredKeys(source) {
  let keys;
  try { keys = JSON.parse(parseEnv(source).API_KEYS ?? '{}'); }
  catch { throw new Error('API_KEYS must be valid JSON'); }
  if (!keys || Array.isArray(keys) || typeof keys !== 'object' || !Object.keys(keys).length ||
    Object.entries(keys).some(([key, tenant]) => key.length < 24 || typeof tenant !== 'string' || !tenantPattern.test(tenant)))
    throw new Error('API_KEYS must contain strong tokens mapped to valid tenant names');
  return keys;
}
export async function issueKey(file, tenant, outputDirectory) {
  if (!tenantPattern.test(tenant ?? '')) throw new Error('Tenant must use lowercase letters, digits, underscores, or hyphens');
  const source = await readFile(file, 'utf8');
  const keys = configuredKeys(source);
  const credential = token();
  keys[credential] = tenant;
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const output = resolve(outputDirectory, tenant + '-' + randomBytes(4).toString('hex') + '.token');
  await writeFile(output, credential + '\n', { mode: 0o600, flag: 'wx' });
  await update(file, source, 'API_KEYS', JSON.stringify(keys));
  return output;
}
export async function revokeKey(file, tokenFile) {
  const credential = (await readFile(tokenFile, 'utf8')).trim();
  const source = await readFile(file, 'utf8');
  const keys = configuredKeys(source);
  if (!Object.hasOwn(keys, credential)) throw new Error('This key is not configured');
  if (Object.keys(keys).length < 2) throw new Error('Create a replacement key before revoking the last one');
  delete keys[credential];
  await update(file, source, 'API_KEYS', JSON.stringify(keys));
}
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: root, env: composeEnvironment(), stdio: 'inherit' });
    child.on('error', () => reject(new Error('Docker could not be started')));
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('Docker command failed')));
  });
}
export async function main() {
  const { values, positionals } = parseArgs({
    options: { file: { type: 'string', default: '.env.vps' } }, allowPositionals: true,
  });
  const file = resolve(values.file);
  const [command, first, second] = positionals;
  if (command === 'init') {
    const socket = await stat('/var/run/docker.sock');
    if (!socket.isSocket()) throw new Error('A local Linux Docker socket is required');
    await initialize(file, first, second, socket.gid);
    console.log('Created ' + file + ' (mode 0600). Add a provider key there. The demo workspace token is the key in API_KEYS.');
    return;
  }
  if (command === 'key') {
    const output = await issueKey(file, first, resolve(root, '.data/vps-keys'));
    console.log('Saved the new token to ' + output + '. Run the up command to activate it.');
    return;
  }
  if (command === 'revoke') {
    if (!first) throw new Error('Supply the path to the token file to revoke');
    await revokeKey(file, resolve(first));
    console.log('Removed the token from configuration. Run the up command to revoke it on the server.');
    return;
  }
  if (!['up', 'status', 'logs', 'stop', 'check'].includes(command)) {
    throw new Error('Usage: node scripts/vps.mjs [--file .env.vps] init <domain> <email> | key <tenant> | revoke <token-file> | up | status | logs | stop | check');
  }
  const source = await readFile(file, 'utf8');
  const config = parseEnv(source);
  if (!/^[a-f0-9]{64}$/.test(config.POSTGRES_PASSWORD ?? '')) throw new Error('Use the generated 64-character hex database password');
  configuredKeys(source);
  const compose = ['compose', '--env-file', file, '-f', 'compose.vps.yaml'];
  if (command === 'up' || command === 'check') {
    const socket = await stat('/var/run/docker.sock');
    if (!socket.isSocket()) throw new Error('A local Linux Docker socket is required');
    if (String(socket.gid) !== config.DOCKER_GID) await update(file, source, 'DOCKER_GID', String(socket.gid));
    await chmod(file, 0o600);
    await run(['info', '--format', 'Docker server {{.ServerVersion}}']);
    await run([...compose, 'config', '--quiet']);
    if (command === 'check') return;
    if (![config.OPENAI_API_KEY, config.ANTHROPIC_API_KEY, config.OPENROUTER_API_KEY].some(value => value?.trim()))
      throw new Error('Set a model provider API key in the deployment file first');
    if (config.SANDBOX_IMAGE === 'pi-managed-sandbox:dev')
      await run(['build', '-f', 'Dockerfile.sandbox', '-t', config.SANDBOX_IMAGE, '.']);
    else await run(['image', 'inspect', '--format', '{{.Id}}', config.SANDBOX_IMAGE]);
    await run([...compose, 'up', '-d', '--build', '--wait', '--wait-timeout', '180']);
    console.log('Stack started. Verify HTTPS at https://' + config.AGENTS_DOMAIN + '/healthz before connecting apps.');
  } else if (command === 'status') await run([...compose, 'ps']);
  else if (command === 'logs') await run([...compose, 'logs', '--tail', '100', '-f']);
  else await run([...compose, 'stop']);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.code === 'EEXIST' ? 'Configuration already exists; it was not overwritten.' : error.message);
    process.exitCode = 1;
  });
}
