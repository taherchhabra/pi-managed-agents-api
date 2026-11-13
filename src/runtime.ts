import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import {
  createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type FileEntry, type ResourceLoader, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { SDK_VERSION, type AgentConfig, type Checkpoint, type Job, type ToolName, type ToolResult } from './domain.js';

export interface RuntimeResult { checkpoint: Checkpoint; output: string; usage: unknown }
export interface Runtime { run(): Promise<RuntimeResult>; close(): Promise<void> }
export interface RuntimeHooks {
  signal: AbortSignal;
  execute(callId: string, name: ToolName, args: Record<string, unknown>, checkpoint: Checkpoint): Promise<ToolResult>;
}
export type RuntimeFactory = (job: Job, hooks: RuntimeHooks) => Promise<Runtime>;
export interface PiOptions {
  keys: Partial<Record<AgentConfig['provider'], string>>;
  maxTurns?: number;
  maxOutputTokens?: number;
  // Trusted observation/admission hook before a model payload leaves the worker.
  // Throwing refuses the request. Payloads and credentials are never passed here.
  beforeModelRequest?: (request: { runId: string; provider: string; model: string }) => void;
  // Trusted dependency injection for contract tests. Never exposed through HTTP.
  configureModelRuntime?: (runtime: ModelRuntime) => Promise<void>;
}

export function restoreCheckpoint(checkpoint: Checkpoint | null, cwd: string): SessionManager {
  if (!checkpoint) return SessionManager.inMemory(cwd);
  if (checkpoint.schema_version !== 1 || checkpoint.sdk_version !== SDK_VERSION) {
    throw new Error('Checkpoint requires a different runtime version');
  }
  const manager = SessionManager.inMemory(cwd, undefined, structuredClone([checkpoint.header, ...checkpoint.entries]) as FileEntry[]);
  if (checkpoint.leaf_id) manager.branch(checkpoint.leaf_id);
  else manager.resetLeaf();
  return manager;
}
export function saveCheckpoint(manager: SessionManager): Checkpoint {
  const checkpoint: Checkpoint = { schema_version: 1, sdk_version: SDK_VERSION,
    header: manager.getHeader(), entries: manager.getEntries(), leaf_id: manager.getLeafId() };
  const json = JSON.stringify(checkpoint);
  if (Buffer.byteLength(json) > 16 * 1024 * 1024) throw new Error('Session checkpoint exceeds the 16 MiB MVP limit');
  return JSON.parse(json) as Checkpoint;
}

function resources(instructions: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => instructions + '\n\nFiles and commands operate in /workspace in an isolated Linux sandbox. Save deliverables under /workspace/outputs. Network access is disabled. Do not start background processes.',
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
}
const definitions = {
  bash: { description: 'Execute a bash command in the sandbox. Maximum 30 seconds; output is truncated at 64 KiB.',
    parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16_384 }) }, { additionalProperties: false }) },
  read_file: { description: 'Read a UTF-8 file inside /workspace, up to 64 KiB.',
    parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false }) },
  write_file: { description: 'Write a UTF-8 file inside /workspace, up to 64 KiB. Put deliverables in outputs/.',
    parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }), content: Type.String({ maxLength: 65_536 }) }, { additionalProperties: false }) },
};

export function piRuntime(options: PiOptions): RuntimeFactory {
  if (options.maxTurns !== undefined && (!Number.isInteger(options.maxTurns) || options.maxTurns < 1)) throw new Error('maxTurns must be a positive integer');
  if (options.maxOutputTokens !== undefined && (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)) throw new Error('maxOutputTokens must be a positive integer');
  return async (job, hooks) => {
    hooks.signal.throwIfAborted();
    const key = options.keys[job.config.provider];
    if (!key && !options.configureModelRuntime) throw new Error(`No server credential configured for ${job.config.provider}`);
    const directory = await mkdtemp(join(tmpdir(), 'pi-managed-'));
    try {
      const modelRuntime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'),
        modelsPath: null, modelsStorePath: join(directory, 'models-cache.json'), refreshOnCreate: false, allowModelNetwork: false });
      if (key) await modelRuntime.setRuntimeApiKey(job.config.provider, key);
      await options.configureModelRuntime?.(modelRuntime);
      hooks.signal.throwIfAborted();
      const model = modelRuntime.getModel(job.config.provider, job.config.model);
      if (!model) throw new Error(`Unknown model: ${job.config.provider}/${job.config.model}`);
      const manager = restoreCheckpoint(job.checkpoint, directory);
      let fatal: unknown;
      let abort = () => {};
      let toolCount = 0;
      const customTools: ToolDefinition[] = job.config.tools.map(name => ({
        name, label: name, ...definitions[name], executionMode: 'sequential',
        execute: async (callId, args) => {
          let result: ToolResult;
          try {
            if (fatal) throw fatal;
            hooks.signal.throwIfAborted();
            if (++toolCount > 32) throw new Error('Run exceeded its 32-tool budget');
            result = await hooks.execute(callId, name, args as Record<string, unknown>, saveCheckpoint(manager));
          } catch (error) {
            // Pi converts tool exceptions into model-visible errors. Persist/lease
            // failures must additionally stop the loop, so no later tool can run.
            fatal = error;
            abort();
            throw error;
          }
          // An ordinary shell/file error is a durable tool result the model can
          // correct. Infrastructure failures above stop the whole attempt.
          if (result.isError) throw new Error(result.text);
          return { content: [{ type: 'text', text: result.text || '(no output)' }], details: {} };
        },
      }));
      const { session } = await createAgentSession({
        cwd: directory, agentDir: directory, modelRuntime, model, thinkingLevel: 'off',
        resourceLoader: resources(job.config.instructions), sessionManager: manager,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: true }, cacheWarming: 'off',
          retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 60_000 } },
        }),
        noTools: 'builtin', tools: job.config.tools, customTools,
      });
      session.agent.toolExecution = 'sequential';
      abort = () => session.agent.abort();
      let modelRequests = 0;
      session.agent.onPayload = (payload, requestedModel) => {
        try {
          hooks.signal.throwIfAborted();
          if (++modelRequests > (options.maxTurns ?? 32)) throw new Error('Run exceeded its model-request budget');
          let boundedPayload = payload;
          if (options.maxOutputTokens !== undefined) {
            if (!payload || typeof payload !== 'object') throw new Error('Cannot apply output-token limit to this request');
            const body = { ...payload } as Record<string, unknown>;
            const field = requestedModel.api === 'openai-responses' ? 'max_output_tokens'
              : 'max_completion_tokens' in body ? 'max_completion_tokens' : 'max_tokens';
            const existing = typeof body[field] === 'number' ? body[field] : options.maxOutputTokens;
            body[field] = Math.min(existing, options.maxOutputTokens);
            boundedPayload = body;
          }
          options.beforeModelRequest?.({ runId: job.id, provider: requestedModel.provider, model: requestedModel.id });
          return boundedPayload;
        } catch (error) { fatal = error; abort(); throw error; }
      };
      const before = session.getSessionStats();
      let settled = false;
      const unsubscribe = session.subscribe(event => {
        if (event.type === 'agent_settled') settled = true;
      });
      hooks.signal.addEventListener('abort', abort, { once: true });
      return {
        run: async () => {
          hooks.signal.throwIfAborted();
          await session.prompt(job.input, { expandPromptTemplates: false });
          await session.waitForIdle();
          if (fatal) throw fatal;
          hooks.signal.throwIfAborted();
          const last = session.messages.findLast(message => message.role === 'assistant');
          if (!settled || last?.role !== 'assistant' || last.stopReason !== 'stop') {
            throw new Error(last?.role === 'assistant' ? (last.errorMessage || `Model ended with ${last.stopReason}`) : 'Model produced no final response');
          }
          const after = session.getSessionStats();
          const tokens = Object.fromEntries(Object.entries(after.tokens).map(([name, value]) => [name, value - before.tokens[name as keyof typeof before.tokens]]));
          return { checkpoint: saveCheckpoint(manager), output: session.getLastAssistantText() ?? '',
            usage: { tokens, cost_usd: after.cost - before.cost, source: 'pi_session_stats' } };
        },
        close: async () => {
          hooks.signal.removeEventListener('abort', abort);
          unsubscribe();
          await session.abort();
          session.dispose();
          await modelRuntime.settleCredentialWrites();
          await rm(directory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  };
}
