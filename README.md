# Pi Managed Agents API

A working MVP of a managed agents API built on the **Pi coding agent SDK**. TypeScript, Fastify, PostgreSQL, and Docker supply the service around Pi's model/tool loop.

It implements immutable agent versions, tenant-scoped sessions, asynchronous runs, idempotent admission, a leased worker, persistent Pi checkpoints, Docker tools, replayable SSE events, cancellation, and downloadable artifacts. A browser console lets you build agents, test real sessions, and inspect runs, tool calls, event logs, and artifacts. The API is native to this project; provider compatibility adapters are future work.

This is a development MVP for a trusted operator on one Docker host. The [MVP contract](docs/mvp.md) describes recovery behavior, tested guarantees, and the remaining work before public multi-tenant hosting.

## Run locally

Requires Node.js **22.19+**, npm, and Docker with Compose. The sandbox includes Python and Bash; its network is disabled.

```sh
npm ci
docker compose up -d --wait
docker build -f Dockerfile.sandbox -t pi-managed-sandbox:dev .
cp .env.example .env
```

Edit `.env`: replace the bearer token in `API_KEYS` and set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY`. Tokens map to tenant IDs. Provider keys remain in the worker and are never passed into the sandbox.

```sh
npm run dev
```

The service builds the console, migrates its schema, and listens on `http://127.0.0.1:8080`. Open that URL and sign in with a token from `API_KEYS` (not a model-provider key). Start with an agent preset or create your own; choose **Test agent**, select a workspace, and send a task. To compile and run JavaScript, use `npm run build` followed by `npm start`.

Select **Documentation** in the console for the built-in [getting-started guide](http://127.0.0.1:8080/#/docs/get-started), API quickstart, concepts, sandbox guide, logs, and local setup. The guides are searchable, include copyable examples, and work before sign-in. The [console guide](docs/console.md) also covers frontend development. For hot reloading, run `npm run dev:api` and `npm run dev:ui` in separate terminals, then visit `http://127.0.0.1:5173`.

In another terminal, set the same bearer token and run the example:

```sh
export API_TOKEN='your-token-from-API_KEYS'
npm run example
```

[The example](examples/run.mjs) creates an agent, environment, session, and run; watches durable SSE events; then prints the result and artifact download paths. It defaults to `openai/gpt-4.1-mini`; use `MODEL_PROVIDER=anthropic MODEL=claude-sonnet-4-5 npm run example` for Anthropic. The selected model must exist in the service catalog (Pi's pinned models plus [service additions](src/models.ts)). These calls use your configured provider account.

For OpenRouter, use `MODEL_PROVIDER=openrouter MODEL=openai/gpt-4.1-mini npm run example`.

[DeepSeek V4.1 Flash 1017](https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017) is available in the console under **OpenRouter**, with model ID `deepseek/deepseek-v4.1-flash-1017`. The console and worker share the same catalog additions. To run its real-model acceptance suite, use `LIVE_MODEL=deepseek/deepseek-v4.1-flash-1017 npm run test:live`.

## Test with a real model

Set `OPENROUTER_API_KEY` in the ignored `.env` file, start PostgreSQL, and build the sandbox image as above. Then run:

```sh
npm run test:live
```

The live harness starts an isolated API and worker, calls OpenRouter through the production Pi adapter, and verifies actual model responses, tool execution, artifact contents, persisted conversation/workspace state, SSE replay, tenant isolation, and cancellation. It uses no model fixtures and fails if the key is missing. No separately running API or `API_TOKEN` is needed.

It defaults to `openai/gpt-4.1-mini` (`LIVE_MODEL` overrides it), limits requests and output tokens, saves local evidence under `.data/live-tests/`, and removes its database schema and sandbox volumes afterward. This opt-in command uses provider credits and is separate from ordinary CI. [Live test contract and observed results](docs/live-testing.md).

## Verify without model credentials

With PostgreSQL and the sandbox image available:

```sh
npm run check
npm run build
```

Tests use the **real Pi SDK** with a local HTTP/SSE model fixture, real PostgreSQL schemas, and real Docker containers. No provider key or paid model call is needed. Each test creates and drops a separate database schema and removes its sandbox volumes. Set `TEST_DATABASE_URL` to use another PostgreSQL instance where the test user can create schemas.

The tests cover concurrent admission, tenant isolation, ownership fencing, recovery, checkpoint branches and compaction records, conversation restoration, tool errors, cancellation during generation and shell execution, SSE reconnection, artifact downloads, injected persistence/publication failures, and model-request/token limits. A separate live run through OpenRouter passed all six acceptance checks; direct OpenAI/Anthropic inference remains unverified.

## API

API clients authenticate with `Authorization: Bearer <token>`. The same-origin console exchanges that token for an opaque, HttpOnly session cookie. Every `/v1` `POST` also needs `Idempotency-Key`. Retrying the same key and normalized body returns the original response; changing the body returns `409`. A run's `202` response means its input was committed, and its status must be read separately.

| Resource | Endpoints |
| --- | --- |
| Agents | `POST/GET /v1/agents`, `GET /v1/agents/:id`, `POST /v1/agents/:id/versions` |
| Environments | `POST/GET /v1/environment-templates`, `GET /v1/environment-templates/:id` |
| Sessions | `POST/GET /v1/sessions`, `GET /v1/sessions/:id`, `POST /v1/sessions/:id/archive` |
| Runs | `POST/GET /v1/sessions/:id/runs`, `GET /v1/sessions/:id/runs/:run`, `POST .../:run/cancel`, `POST .../:run/resume` |
| Events | `GET /v1/sessions/:id/events?after=0`, add `stream=true` for SSE |
| Artifacts | `GET /v1/sessions/:id/artifacts`, `GET /v1/sessions/:id/artifacts/:artifact/content` |
| Capabilities | `GET /v1/capabilities` (installed model catalog and provider configuration flags) |

Run admission takes `{ "input": "...", "when_busy": "queue" }` or `"reject"`. Cancellation, resume, and archive take `{}`. SSE uses session sequence strings as IDs and accepts `Last-Event-ID`. Disconnection does not cancel a run. [Complete request examples and behavior](docs/mvp.md).

## Design and layout

- [Provider architecture research](docs/provider-architecture.md) compares the reference products and their operational contracts.
- [Proposed Pi architecture](docs/architecture.md) describes the runtime boundary, resources, persistence, recovery, and implementation stages.
- [MVP contract](docs/mvp.md) distinguishes implemented behavior from that proposal.
- [Console guide](docs/console.md) documents the browser workflows and verification.

`src/api.ts` owns admission and reads, `src/store.ts` owns transactional state, `src/worker.ts` coordinates execution, `src/runtime.ts` embeds Pi, and `src/sandbox.ts` supplies the Docker executor. `src/artifacts.ts` stores immutable output bytes outside the workspace. `src/console.ts` supplies console authentication and static hosting; `ui/` contains the React/Vite application.

The SDK is pinned to `@earendil-works/pi-coding-agent@1.5.2`. Persistence, recovery, and managed execution belong to this service; no durable-harness dependency is used.
