import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify, { LogController, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Type } from 'typebox';
import { ArtifactStore } from './artifacts.js';
import type { Config } from './config.js';
import { ApiError, type AgentConfig } from './domain.js';
import { Store } from './store.js';
import { installConsole } from './console.js';
import { modelCatalog } from './catalog.js';
import type { DesktopClient } from './desktop/client.js';

declare module 'fastify' { interface FastifyRequest { tenant: string } }
const object = (properties: Record<string, any>) => Type.Object(properties, { additionalProperties: false });
const name = Type.String({ minLength: 1, maxLength: 200 });
const id = Type.String({ pattern: '^[a-z]+_[0-9a-f-]{36}$', maxLength: 50 });
const config = object({ provider: Type.Union([Type.Literal('openai'), Type.Literal('anthropic'), Type.Literal('openrouter')]),
  model: Type.String({ minLength: 1, maxLength: 200 }), instructions: Type.String({ maxLength: 32_768 }),
  tools: Type.Array(Type.Union([Type.Literal('bash'), Type.Literal('read_file'), Type.Literal('write_file'), Type.Literal('AX'), Type.Literal('GUI')]), { uniqueItems: true, maxItems: 5 }) });
const sessionParams = object({ session: id });
const runParams = object({ session: id, run: id });
const cursor = Type.String({ pattern: '^(0|[1-9][0-9]{0,18})$', maxLength: 19 });
const params = (request: FastifyRequest) => request.params as Record<string, string>;

export function buildApi(store: Store, artifacts: ArtifactStore, options: Pick<Config, 'apiKeys' | 'sandboxImage'> & Partial<Pick<Config, 'providerKeys' | 'providerConfigured' | 'consoleOrigin' | 'trustProxyHops' | 'rateLimitMax' | 'loginRateLimitMax'>> & { desktop?: DesktopClient }, logger = false) {
  const app = Fastify({ logger: logger ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'] } : false,
    logController: new LogController({ disableRequestLogging: true }), bodyLimit: 256 * 1024,
    trustProxy: options.trustProxyHops ? (_address, hop) => hop < options.trustProxyHops! : false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  const streams = new Set<AbortController>();
  app.register(rateLimit, { max: options.rateLimitMax ?? 600, timeWindow: 60_000 });
  // Register routes after the limiter's onRoute hook has been installed.
  app.register(async function routes(app) {
    app.decorateRequest('tenant', '');
    installConsole(app, options.apiKeys, options.consoleOrigin, options.loginRateLimitMax);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      const typed = error as { validation?: unknown; statusCode?: number; code?: string };
      if (typed.statusCode === 429) return reply.code(429).send({ error: { code: 'rate_limit_exceeded', message: 'Too many requests. Retry after the Retry-After interval.' } });
      if (typed.validation || (typed.statusCode && typed.statusCode < 500)) {
        return reply.code(typed.statusCode ?? 400).send({ error: { code: 'invalid_request', message: 'Request does not match the API schema' } });
      }
      // Database errors can contain transcript values; log only the error code.
      app.log.error({ code: typed.code }, 'Request failed');
      return reply.code(500).send({ error: { code: 'internal_error', message: 'The request could not be completed' } });
    });
    app.addHook('preClose', async () => { for (const controller of streams) controller.abort(); });
    app.get('/healthz', { config: { rateLimit: false } }, async () => { await store.pool.query('SELECT 1'); return { status: 'ok' }; });
    let catalog: ReturnType<typeof modelCatalog> | undefined;
    const validateDesktopModel = async (config: AgentConfig) => {
      if (!config.tools.some(tool => tool === 'AX' || tool === 'GUI')) return;
      catalog ??= modelCatalog().catch(error => { catalog = undefined; throw error; });
      const model = (await catalog).find(provider => provider.id === config.provider)?.models.find(model => model.id === config.model);
      if (!model?.input.includes('image')) throw new ApiError(400, 'vision_model_required', 'HCU desktop tools require a model with image input support');
    };
    app.get('/v1/capabilities', async () => {
      catalog ??= modelCatalog().catch(error => { catalog = undefined; throw error; });
      return { providers: (await catalog).map(provider => ({ ...provider, configured: options.providerConfigured?.[provider.id] ?? !!options.providerKeys?.[provider.id] })),
        sandbox_image: options.sandboxImage, desktop: { configured: !!options.desktop, platform: 'linux', network: 'none' }, runtime: 'Pi coding agent SDK', sdk_version: '1.5.2' };
    });

    const mutation = async (request: FastifyRequest, fn: Parameters<Store['mutate']>[4]) => {
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string') throw new ApiError(400, 'idempotency_key_required', 'Supply an Idempotency-Key header');
      const scope = request.method + ' ' + request.url.split('?')[0];
      return store.mutate(request.tenant, scope, key, request.body ?? {}, fn);
    };

    app.post('/v1/agents', { schema: { body: object({ name, config }) } }, async (request, reply) => {
      const body = request.body as { name: string; config: AgentConfig };
      await validateDesktopModel(body.config);
      const result = await mutation(request, tx => store.createAgent(tx, request.tenant, body.name, body.config));
      return reply.code(result.status).send(result.body);
    });
    app.get('/v1/agents', async request => ({ data: await store.list(request.tenant, 'agents') }));
    app.get('/v1/agents/:agent', { schema: { params: object({ agent: id }) } }, request => store.getAgent(request.tenant, params(request).agent!));
    app.post('/v1/agents/:agent/versions', { schema: { params: object({ agent: id }), body: config } }, async (request, reply) => {
      await validateDesktopModel(request.body as AgentConfig);
      const result = await mutation(request, tx => store.createVersion(tx, request.tenant, params(request).agent!, request.body as AgentConfig));
      return reply.code(result.status).send(result.body);
    });
    app.get('/v1/environment-templates', async request => ({ data: await store.list(request.tenant, 'environment_templates') }));
    app.get('/v1/environment-templates/:environment', { schema: { params: object({ environment: id }) } }, request => store.getEnvironment(request.tenant, params(request).environment!));
    app.post('/v1/environment-templates', { schema: { body: object({ name, type: Type.Union([Type.Literal('none'), Type.Literal('managed'), Type.Literal('desktop')]) }) } }, async (request, reply) => {
      const body = request.body as { name: string; type: string };
      if (body.type === 'desktop' && !options.desktop) throw new ApiError(503, 'desktop_unavailable', 'Configure a desktop host before creating a Linux desktop environment');
      const result = await mutation(request, tx => store.createEnvironment(tx, request.tenant, body.name, body.type, options.sandboxImage));
      return reply.code(result.status).send(result.body);
    });
    app.get('/v1/sessions', async request => ({ data: await store.list(request.tenant, 'sessions') }));
    app.post('/v1/sessions', { schema: { body: object({ agent_version_id: id, environment_template_id: id }) } }, async (request, reply) => {
      const body = request.body as { agent_version_id: string; environment_template_id: string };
      const result = await mutation(request, tx => store.createSession(tx, request.tenant, body.agent_version_id, body.environment_template_id));
      return reply.code(result.status).send(result.body);
    });
    app.get('/v1/sessions/:session', { schema: { params: sessionParams } }, request => store.getSession(request.tenant, params(request).session!));
    const desktopSession = async (request: FastifyRequest) => {
      const session = await store.getSession(request.tenant, params(request).session!);
      if (session.environment_type !== 'desktop') throw new ApiError(404, 'not_found', 'This session has no desktop');
      if (session.status === 'archived') throw new ApiError(410, 'desktop_archived', 'This desktop has been archived. Saved screenshots remain available in the event log.');
      if (!options.desktop) throw new ApiError(503, 'desktop_unavailable', 'Desktop host is not configured');
      return options.desktop;
    };
    app.get('/v1/sessions/:session/desktop', { schema: { params: sessionParams } }, async request =>
      (await desktopSession(request)).status(params(request).session!, request.tenant));
    app.get('/v1/sessions/:session/desktop/frame', { schema: { params: sessionParams } }, async (request, reply) => {
      const bytes = await (await desktopSession(request)).frame(params(request).session!, request.tenant);
      return reply.type('image/jpeg').header('Cache-Control', 'no-store').send(bytes);
    });
    app.get('/v1/sessions/:session/screenshots/:screenshot', { schema: { params: object({ session: id, screenshot: id }) } }, async (request, reply) => {
      const capture = await store.screenshot(request.tenant, params(request).session!, params(request).screenshot!);
      return reply.type('image/jpeg').header('Cache-Control', 'no-store').send(await artifacts.read(capture.sha256));
    });
    app.get('/v1/sessions/:session/runs', { schema: { params: sessionParams, querystring: object({ after: Type.Optional(id) }) } }, async request => {
      const data = await store.runs(request.tenant, params(request).session!, (request.query as { after?: string }).after);
      return { data, next_cursor: data.length === 100 ? data.at(-1)!.id : null };
    });
    app.post('/v1/sessions/:session/runs', { schema: { params: sessionParams,
      body: object({ input: Type.String({ minLength: 1, maxLength: 65_536 }), when_busy: Type.Union([Type.Literal('queue'), Type.Literal('reject')]) }) } }, async (request, reply) => {
      const body = request.body as { input: string; when_busy: string };
      const result = await mutation(request, tx => store.enqueue(tx, request.tenant, params(request).session!, body.input, body.when_busy));
      return reply.code(result.status).send(result.body);
    });
    app.get('/v1/sessions/:session/runs/:run', { schema: { params: runParams } }, request => store.getRun(request.tenant, params(request).session!, params(request).run!));
    for (const operation of ['cancel', 'resume'] as const) {
      app.post('/v1/sessions/:session/runs/:run/' + operation, { schema: { params: runParams, body: object({}) } }, async (request, reply) => {
        const result = await mutation(request, tx => store[operation](tx, request.tenant, params(request).session!, params(request).run!));
        return reply.code(result.status).send(result.body);
      });
    }
    app.post('/v1/sessions/:session/archive', { schema: { params: sessionParams, body: object({}) } }, async (request, reply) => {
      const result = await mutation(request, tx => store.archive(tx, request.tenant, params(request).session!));
      return reply.code(result.status).send(result.body);
    });
    app.get('/v1/sessions/:session/events', { schema: { params: sessionParams,
      querystring: object({ after: Type.Optional(cursor), stream: Type.Optional(Type.Literal('true')) }) } }, async (request, reply) => {
      const query = request.query as { after?: string; stream?: string };
      const session = params(request).session!;
      const header = request.headers['last-event-id'];
      let after = query.after ?? (typeof header === 'string' ? header : '0');
      if (!/^(0|[1-9][0-9]{0,18})$/.test(after) || BigInt(after) > 9223372036854775807n) throw new ApiError(400, 'invalid_cursor', 'Cursor must be a nonnegative 64-bit session sequence');
      const snapshot = await store.getSession(request.tenant, session);
      if (BigInt(after) > BigInt(snapshot.event_seq)) throw new ApiError(400, 'invalid_cursor', 'Cursor is beyond this session history');
      if (query.stream !== 'true' && !request.headers.accept?.includes('text/event-stream')) {
        const data = await store.events(request.tenant, session, after);
        return { data, next_cursor: data.at(-1)?.seq ?? after };
      }
      const controller = new AbortController();
      streams.add(controller);
      const disconnect = () => controller.abort();
      reply.raw.on('close', disconnect);
      reply.hijack();
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      const write = async (data: string) => {
        if (!reply.raw.write(data)) await once(reply.raw, 'drain', { signal: controller.signal });
      };
      try {
        await write(': connected\n\n');
        let lastHeartbeat = Date.now();
        while (!controller.signal.aborted) {
          if (request.consoleAuthorized && !request.consoleAuthorized()) break;
          const events = await store.events(request.tenant, session, after);
          for (const event of events) {
            await write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            after = event.seq;
          }
          if (Date.now() - lastHeartbeat >= 15_000) { await write(': heartbeat\n\n'); lastHeartbeat = Date.now(); }
          if (events.length < 100) await delay(250, undefined, { signal: controller.signal });
        }
      } catch {
        // Disconnects never cancel work. On a database failure the client reconnects
        // from its last received cursor and reads the durable backlog again.
      } finally {
        reply.raw.removeListener('close', disconnect);
        streams.delete(controller);
        reply.raw.end();
      }
    });
    app.get('/v1/sessions/:session/artifacts', { schema: { params: sessionParams } }, async request => {
      const session = params(request).session!;
      return { data: (await store.artifacts(request.tenant, session)).map(file => ({ ...file, download_url: `/v1/sessions/${session}/artifacts/${file.id}/content` })) };
    });
    app.get('/v1/sessions/:session/artifacts/:artifact/content', { schema: { params: object({ session: id, artifact: id }) } }, async (request, reply) => {
      const file = await store.artifact(request.tenant, params(request).session!, params(request).artifact!);
      const bytes = await artifacts.read(file.sha256);
      return reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename="${file.id}"`)
        .header('X-Content-Type-Options', 'nosniff').header('ETag', '"' + file.sha256 + '"').send(bytes);
    });
  });
  return app;
}
