import { resolve } from 'node:path';
import type { AgentConfig } from './domain.js';

export interface Config {
  databaseUrl: string;
  apiKeys: Record<string, string>;
  host: string;
  port: number;
  role: 'api' | 'worker' | 'all';
  artifactDir: string;
  sandboxImage: string;
  providerKeys: Partial<Record<AgentConfig['provider'], string>>;
  providerConfigured: Partial<Record<AgentConfig['provider'], boolean>>;
  trustProxyHops: number;
  rateLimitMax: number;
  loginRateLimitMax: number;
  consoleOrigin?: string;
  desktopUrl?: string;
  desktopToken?: string;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const role = env.ROLE ?? 'all';
  if (!['api', 'worker', 'all'].includes(role)) throw new Error('ROLE must be api, worker, or all');
  let apiKeys: Record<string, string>;
  try { apiKeys = JSON.parse(env.API_KEYS ?? '{}'); }
  catch { throw new Error('API_KEYS must be a JSON object mapping bearer tokens to tenant IDs'); }
  if (!apiKeys || Array.isArray(apiKeys) || typeof apiKeys !== 'object' || (role !== 'worker' && !Object.keys(apiKeys).length) ||
    Object.entries(apiKeys).some(([key, tenant]) => key.length < 24 || typeof tenant !== 'string' || !tenant || tenant.length > 100)) {
    throw new Error('API_KEYS requires at least one token of 24+ characters mapped to a tenant ID');
  }
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(name + ' is out of range');
    return value;
  };
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
  const consoleOrigin = env.CONSOLE_ORIGIN;
  const desktopUrl = env.DESKTOP_HOST_URL;
  const desktopToken = env.DESKTOP_HOST_TOKEN;
  if (desktopUrl || desktopToken) {
    if (!desktopUrl || !desktopToken || desktopToken.length < 32) throw new Error('Set DESKTOP_HOST_URL and a DESKTOP_HOST_TOKEN of 32+ characters together');
    const url = new URL(desktopUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== desktopUrl) throw new Error('DESKTOP_HOST_URL must be an http(s) origin');
  }
  if (consoleOrigin) {
    try {
      const url = new URL(consoleOrigin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== consoleOrigin) throw new Error();
    } catch { throw new Error('CONSOLE_ORIGIN must be an http(s) origin without a path or trailing slash'); }
  }
  return { databaseUrl: env.DATABASE_URL, apiKeys, host: env.HOST ?? '127.0.0.1', port,
    role: role as Config['role'], artifactDir: resolve(env.ARTIFACT_DIR ?? '.data/artifacts'),
    sandboxImage: env.SANDBOX_IMAGE ?? 'pi-managed-sandbox:dev', consoleOrigin, desktopUrl, desktopToken,
    trustProxyHops: integer('TRUST_PROXY_HOPS', 0, 0, 10),
    rateLimitMax: integer('RATE_LIMIT_MAX', 600, 1, 100_000),
    loginRateLimitMax: integer('LOGIN_RATE_LIMIT_MAX', 10, 1, 1000),
    providerConfigured: {
      openai: !!env.OPENAI_API_KEY || env.OPENAI_CONFIGURED === 'true',
      anthropic: !!env.ANTHROPIC_API_KEY || env.ANTHROPIC_CONFIGURED === 'true',
      openrouter: !!env.OPENROUTER_API_KEY || env.OPENROUTER_CONFIGURED === 'true',
    },
    providerKeys: { openai: env.OPENAI_API_KEY, anthropic: env.ANTHROPIC_API_KEY, openrouter: env.OPENROUTER_API_KEY } };
}
