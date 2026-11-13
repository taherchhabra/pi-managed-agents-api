# MVP contract

Implementation baseline: 14 November 2026. This document describes the current code; [architecture.md](architecture.md) also contains future work.

## Deployment

Run on one Linux Docker host with PostgreSQL and a persistent artifact directory. `ROLE=all` starts API and worker together. `ROLE=api` and `ROLE=worker` separate them into processes, but workers must share the same Docker daemon and artifact storage. Each worker processes one run at a time. Multiple workers coordinate through PostgreSQL session locks and leases.

The default API bind address is `127.0.0.1:8080`. Authentication uses the operator's `API_KEYS` JSON object, mapping bearer tokens to tenant IDs; every key for a tenant has equal access. The worker uses server-level OpenAI, Anthropic, or OpenRouter credentials. The MVP has no per-user identity or per-tenant provider credential vault.

`docker compose up -d --wait` starts only development PostgreSQL on loopback port 55432. The API and worker run through Node. The database credentials in Compose are local development values. `npm run migrate` applies the same migration as startup. Migrations are serialized by a PostgreSQL advisory lock.

`SANDBOX_IMAGE` is an operator setting, captured in environment templates. Use an image digest when you need immutable image content. A custom image must supply Python 3, Bash, `sleep`, UID/GID 10001, and a writable `/workspace` owned by that user. Model requests run outside the sandbox.

## Requests

All examples below are JSON request bodies. Set bearer authentication and a fresh idempotency key on every new POST operation. Reuse the same key when retrying that operation.

Create an agent with `POST /v1/agents`:

```json
{
  "name": "Artifact assistant",
  "config": {
    "provider": "openai",
    "model": "gpt-4.1-mini",
    "instructions": "Complete the task and put deliverables in /workspace/outputs.",
    "tools": ["bash", "read_file", "write_file"]
  }
}
```

The response contains `latest_version.id`. A new revision uses `POST /v1/agents/:id/versions` with the configuration object alone. Existing sessions keep their original version.

For OpenRouter, set `provider` to `openrouter`, use a namespaced model ID such as `openai/gpt-4.1-mini`, and configure `OPENROUTER_API_KEY` on the worker. Pi supplies the built-in OpenRouter transport and catalog; the API does not accept custom provider URLs. See [live testing](live-testing.md) for the verified path.

Create an environment with `POST /v1/environment-templates`:

```json
{ "name": "Python sandbox", "type": "managed" }
```

The other supported type is `none`; it requires an agent with an empty tools list. A session uses the version and environment IDs returned above:

```json
{
  "agent_version_id": "av_<uuid>",
  "environment_template_id": "env_<uuid>"
}
```

Send that to `POST /v1/sessions`, then admit work through `POST /v1/sessions/:id/runs`:

```json
{ "input": "Write a Python script and save a sample report in outputs/.", "when_busy": "queue" }
```

`when_busy` is required. `queue` creates a separate run, while `reject` returns `409` if the session has any queued or active work. Each session has one root conversation and at most one running, waiting, or cancelling run. A waiting run holds up its queue. Runs are admitted durably before `202`; an API or stream disconnect does not abandon them.

GET the run for `status`, `output_text`, `error`, and `usage`. Available statuses are `queued`, `running`, `waiting`, `cancelling`, `completed`, `failed`, and `cancelled`. `GET /v1/sessions/:id` returns the active run and `event_seq` from one database snapshot. Agent, environment, and session lists return at most the latest 100 entries; pagination is deferred.

Errors use `{ "error": { "code": "...", "message": "..." } }`. Invalid payloads return `400`, missing authentication `401`, inaccessible or missing resources `404`, and lifecycle/idempotency conflicts `409`.

## Pi execution and persistence

The adapter embeds Pi SDK 1.5.2 through `createAgentSession()`, with explicit model/auth, in-memory settings and session manager, an empty resource loader, and a fixed tool allowlist. It loads no user extensions, skills, MCP servers, project instructions, or ambient Pi auth files. Public inputs cannot set provider endpoints or install executable extensions.

The only active tools are platform implementations of `bash`, `read_file`, and `write_file`, dispatched through Docker. The custom `bash` replaces Pi's host implementation. A tool wrapper commits the full session checkpoint and tool intent before dispatch, then commits the result before returning to Pi. SDK event callbacks are not used as database barriers. Normal shell exit failures and file errors return to the model so it can correct them; persistence and executor failures abort the attempt.

Checkpoints include the Pi session header, complete entry tree, active leaf, checkpoint schema, and SDK version. Configuration is pinned by the session's immutable agent version. Restore uses `SessionManager.inMemory()` and restores its branch, including compaction records. Completed runs produce a checkpoint before the service commits their result and terminal event. Runtime-version mismatches are rejected.

The worker waits for `prompt()` and idle settlement, observes `agent_settled`, and checks the final assistant stop reason before reporting success. Provider errors, aborted generation, incomplete responses, or missing required artifacts cannot be classified as completed runs.

Usage is the difference in Pi session statistics across a successful run. It includes the SDK's token counts and catalog-based cost estimate, not provider billing reconciliation. Interrupted/failed usage is `null`, which means unknown. There is no hard monetary budget.

## Execution limits and artifacts

| Limit | Current value |
| --- | --- |
| Worker concurrency | One run per worker, one active run per session |
| Lease / renewal | 30 seconds / 5 seconds |
| Run duration | 5 minutes |
| Conversational model requests / dispatched tools | 32 each; request limit checked before sending |
| Tool execution | Sequential |
| Bash command | 30 seconds; returned output truncated at 64 KiB |
| File read/write | 64 KiB UTF-8, paths confined to `/workspace` |
| Sandbox | Non-root, no network, read-only root, no added capabilities, 1 CPU, 512 MiB RAM, 128 processes |
| Temporary files | 64 MiB `/tmp` |
| Artifact export | 20 regular files, 5 MiB each, 20 MiB total |
| Session checkpoint | 16 MiB |

Each session owns a persistent Docker volume. A fresh execution container is created per attempt and removed before a terminal state is committed. Provider keys, the Docker socket, and host directories are not mounted into the sandbox. Containers provide development isolation; this is not a hardened public execution service. Workspace volume disk usage has no quota in this MVP.

On success, the worker stops all agent processes, then mounts the workspace read-only in a separate export container. Files under `/workspace/outputs` become artifacts; symlinks are omitted and special files are rejected. Every successful run exports the directory's current contents, including unchanged files from earlier runs. Stored bytes are SHA-256-addressed and verified on publication and download. Metadata, artifact events, the checkpoint, and `run.completed` commit atomically after all byte writes finish. Failed transactions can leave unreferenced object files for future garbage collection.

Downloads require the same tenant authentication as the session; a digest or artifact ID grants no access. Artifacts remain available after archive. Archiving requires no pending runs and prevents new runs. The worker asynchronously removes its containers and workspace volume, retrying cleanup after failures. Database history and artifacts currently have no expiry or deletion API.

## Recovery and cancellation

Database writes and tool admission require the current unexpired owner epoch. When a lease expires, recovery first stops that generation's Docker containers while holding the session lock, then marks the run `waiting` with `recovery_required`. A stop failure leaves recovery pending. An old worker cannot commit checkpoints, tool results, or completion after ownership changes.

There is **no automatic prompt or tool replay**. `POST .../runs/:run/resume` with `{}` supports interrupted runs that have never dispatched tools: it restores the checkpoint from before the run and retries the original input as a new attempt. This can repeat a model request and its charge. Any recorded tool dispatch makes resume return `409 reconciliation_required`, even when the result was recorded. Supporting replay of reconciled tool calls is future work.

For a run involving tools, reconcile the workspace and any effects, cancel the interrupted run, and submit new work explicitly. A missing previously initialized workspace leaves a run waiting; the service never silently replaces it with an empty volume. Restore the volume or begin a new session. The API does not yet expose a workspace repair/upload mechanism.

`POST .../runs/:run/cancel` records cancellation intent. The worker observes it on its next heartbeat, aborts Pi, terminates sandbox processes, and only then records `cancelled`. Queued and already-interrupted runs can be cancelled immediately. A cancellation racing with completion is serialized by the session lock. A successful completion committed before cancellation stays completed.

Cancelled or unsuccessful attempts restore the previous completed run's model context when they are terminated. Workspace effects are **not rolled back**. Tool invocations with an uncertain outcome are marked unknown. Graceful worker shutdown interrupts active work for explicit recovery; abrupt shutdown is detected after lease expiry and another worker's recovery poll. There is no transparent in-process JavaScript continuation after a crash.

## Events

`GET /v1/sessions/:id/events?after=<sequence>` returns up to 100 committed events and a `next_cursor`. For SSE, add `stream=true` or send `Accept: text/event-stream`. Reconnect with `Last-Event-ID`; an explicit `after` query takes precedence. Sequence values are decimal strings to preserve 64-bit precision.

Events include `schema_version`, `id`, `seq`, `session_id`, `run_id`, `type`, `data`, and `created_at`. Types include `session.created`, `input.accepted`, `run.started`, `tool.requested`, `tool.completed`, `artifact.published`, `message.completed`, run lifecycle outcomes, and `session.archived`.

SSE tails the PostgreSQL journal, so reconnecting has no notification-subscription gap. Delivery can repeat after reconnection; deduplicate by event ID. All events are retained, so expiry responses are not implemented. Streams include keepalives and respect backpressure. Disconnecting a stream never cancels work.

Streaming currently covers durable lifecycle, tool, and result events. Token deltas and running shell-output previews are deferred.

## Live acceptance testing

`npm run test:live` exercises the production Pi adapter with real OpenRouter inference. The harness uses a separate schema, random tenant tokens, and its own artifact directory. Its tighter request, token, and time limits apply only to the acceptance run. The six scenarios, evidence format, and observed results are documented in [live-testing.md](live-testing.md).

## Remaining architecture work

Before public multi-tenant hosting: hardened remote executors and workspace snapshots, disk/concurrency/spend quotas, credential mediation, production authentication, TLS/deployment operations, retention and object cleanup, broader crash testing, and SDK/runtime upgrade procedures.

Features still planned include steering, approvals, external tools, MCP, webhooks/outbox delivery, child threads, input uploads, session configuration updates, self-hosted executors, client SDKs, and OpenAI/Claude compatibility adapters. Their proposed routes in the architecture document are not implemented endpoints.
