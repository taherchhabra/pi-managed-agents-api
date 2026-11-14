import { createHash, randomUUID } from 'node:crypto';

export const SDK_VERSION = '1.5.2';
export type ToolName = 'bash' | 'read_file' | 'write_file' | 'AX' | 'GUI';
export type EnvironmentType = 'none' | 'managed' | 'desktop';
export interface AgentConfig {
  provider: 'openai' | 'anthropic' | 'openrouter';
  model: string;
  instructions: string;
  tools: ToolName[];
}
export interface Checkpoint {
  schema_version: 1;
  sdk_version: string;
  header: unknown;
  entries: unknown[];
  leaf_id: string | null;
}
export interface Job {
  id: string;
  session_id: string;
  tenant_id: string;
  input: string;
  attempt: number;
  epoch: number;
  owner: string;
  config: AgentConfig;
  environment: { type: EnvironmentType; image: string | null };
  checkpoint: Checkpoint | null;
  workspace_initialized: boolean;
}
export interface ToolImage { data: string; mimeType: 'image/jpeg'; width: number; height: number }
export interface ToolResult { text: string; isError?: boolean; images?: ToolImage[] }
export interface ArtifactData { path: string; bytes: Buffer }
export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
export class LeaseLost extends Error {
  constructor() { super('Session ownership was lost'); }
}
export class WorkspaceUnavailable extends Error {
  constructor() { super('Session workspace is missing; restore the volume before resuming'); }
}
export const makeId = (prefix: string) => prefix + '_' + randomUUID();
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const terminal = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);
export function requireRow<T>(row: T | undefined): T {
  if (!row) throw new ApiError(404, 'not_found', 'Resource not found');
  return row;
}
