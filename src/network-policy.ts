import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';
import { ApiError } from './domain.js';

export interface NetworkPolicy { mode: 'off' | 'internet' | 'allowlist'; allowed_domains: string[] }
export const offlineNetwork = (): NetworkPolicy => ({ mode: 'off', allowed_domains: [] });

export function normalizeNetwork(value: unknown): NetworkPolicy {
  if (value === undefined) return offlineNetwork();
  const fail = (message: string): never => { throw new ApiError(400, 'invalid_network_policy', message); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Network must be an object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['mode', 'allowed_domains'].includes(key))) return fail('Unknown network policy field');
  if (!['off', 'internet', 'allowlist'].includes(input.mode as string)) return fail('Network mode must be off, internet, or allowlist');
  const domains = input.allowed_domains ?? [];
  if (!Array.isArray(domains) || domains.length > 100) return fail('Use at most 100 allowed domains');
  const normalized = domains.map(value => {
    if (typeof value !== 'string' || value.length > 253) return fail('Allowed domains must be hostnames');
    const raw = value.trim().toLowerCase().replace(/\.$/, '');
    if (/[\s:/\\@?#%]/.test(raw)) return fail('Use hostnames without a URL, port, path, or spaces');
    const wildcard = raw.startsWith('*.');
    const name = domainToASCII(wildcard ? raw.slice(2) : raw);
    if (!name || isIP(name) || !name.includes('.') || !/[a-z]/i.test(name.split('.').at(-1)!) ||
      !name.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      return fail('Use domain names such as example.com or *.example.com, without a URL, port, path, or IP address');
    }
    return (wildcard ? '*.' : '') + name;
  });
  if (input.mode !== 'allowlist' && normalized.length) return fail('Allowed domains apply only to allowlist mode');
  if (input.mode === 'allowlist' && !normalized.length) return fail('Add at least one allowed domain');
  return { mode: input.mode as NetworkPolicy['mode'], allowed_domains: [...new Set(normalized)].sort() };
}

export function permitsDomain(policy: NetworkPolicy, hostname: string): boolean {
  const host = domainToASCII(hostname.toLowerCase().replace(/\.$/, ''));
  return policy.mode === 'internet' || (policy.mode === 'allowlist' && policy.allowed_domains.some(domain =>
    domain.startsWith('*.') ? host.endsWith(domain.slice(1)) && host !== domain.slice(2) : host === domain));
}
