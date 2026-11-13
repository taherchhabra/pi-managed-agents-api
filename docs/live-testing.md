# Live model acceptance harness

Run the service through real OpenRouter inference using the production Pi coding-agent SDK adapter. This command does not load the local model fixture and does not substitute canned responses when credentials or the provider are unavailable.

## Run

```sh
npm ci
docker compose up -d --wait
docker build -f Dockerfile.sandbox -t pi-managed-sandbox:dev .
```

Put `OPENROUTER_API_KEY` in the repository's ignored `.env` file, then run:

```sh
npm run test:live
```

`LIVE_MODEL` defaults to `openai/gpt-4.1-mini`. An override must be in Pi's pinned OpenRouter catalog and support tool calling. The key must have access to that model. OpenRouter documents [bearer authentication](https://openrouter.ai/docs/api_reference/authentication) and its [tool-calling interface](https://openrouter.ai/docs/guides/features/tool-calling).

The harness uses `TEST_DATABASE_URL`, then `DATABASE_URL`, then the local Compose database. Its database user needs permission to create and drop schemas. `SANDBOX_IMAGE` selects the already-built local image. There is no automatic image pull, no API-key prompt, and no fixture fallback. A missing key exits unsuccessfully before provisioning or calling a model.

The runner creates a random PostgreSQL schema, local HTTP listener, tenant tokens, and a background worker. API requests use HTTP. The Pi adapter sends real inference requests to OpenRouter. Shell/file tools execute in real Docker containers. It does not use an existing API deployment or its sessions.

## Acceptance checks

1. **Live inference and idempotency:** concurrently submit the same command twice, verify one admitted run, and check the real model returns a newly generated marker.
2. **Conversation restoration:** stop and replace the worker, then ask for the earlier marker without including it in the follow-up or enabling tools. Checkpoint restoration must supply it.
3. **Tool errors, code execution, and artifacts:** ask the model to invoke a deliberately failing shell command, recover, write a Python program, execute it, and read its result. Validate tool events, computed values, published bytes, and SHA-256 digests. Disconnect SSE during execution, then verify replayed event IDs against the journal.
4. **Workspace restoration:** replace the worker again, have the model read the existing file and write a copy, then validate the newly published JSON against the original expected data.
5. **Tenant isolation and retention:** deny another tenant access to the live run and artifact, archive the session, and verify the artifact still downloads correctly.
6. **Cancellation:** have the real model dispatch a 20-second shell command, cancel through HTTP during execution, and verify prompt cancellation without a completed-run event.

Worker replacement here creates a new worker and Pi session in the same test process. It verifies database/workspace restoration, not operating-system crash recovery. Existing deterministic tests separately exercise lease expiry and uncertain tool outcomes.

An assertion, provider failure, timeout, or cleanup error makes the command exit unsuccessfully. The model must actually exercise the requested tools; a plausible final message alone cannot pass. These are acceptance checks for service behavior, not a broad coding-quality benchmark. Different models can fail instruction-following assertions even when the transport works correctly.

## Bounds and evidence

The live runner allows at most 8 model requests per run, 24 across the suite, and 2,048 output tokens per request. It sets a 2-minute run timeout and an 8-minute suite timeout. Pi/provider automatic retries are disabled. Admission limits run before outbound payload delivery; output limits are applied to the provider payload. These are request/token/time controls, not a guaranteed monetary ceiling or provider billing reconciliation.

Each run saves an ignored directory under `.data/live-tests/<timestamp>-<id>/`:

- `report.json`: checks, timings, model-request metadata, limits, usage, and cleanup outcome.
- `runs.json`, `events.json`, `tool-calls.json`: the final database evidence, including failures.
- `artifacts/<run-id>/`: downloaded and digest-verified deliverables.
- `objects/`: immutable artifact bytes from the isolated service.

`.data/live-tests/latest.json` contains the most recent summary. Credentials are redacted from JSON evidence and never passed to model prompts or containers. Reports and keys are ignored by Git. The runner stops its workers, removes its sandbox volumes, and drops only its generated schema; evidence files remain for inspection. Interrupted requests have unknown usage rather than a fabricated zero.

Ordinary `npm run check` remains credential-free. It tests the OpenRouter API/configuration path, request/token bounds, refusal before provider dispatch, and failure without a live key in addition to the existing integration suite. CI runs those tests; paid live execution remains an explicit local command.

## Observed live result

Verified **14 November 2026, Asia/Kuala_Lumpur** (2026-11-13 16:25 UTC), with Pi SDK **1.5.2** and OpenRouter **openai/gpt-4.1-mini**:

| Check | Result | Duration |
| --- | --- | --- |
| Live inference and idempotency | Passed | 3.38 s |
| Conversation restoration | Passed | 1.38 s |
| Tool failure recovery, Python, artifacts, SSE replay | Passed | 7.66 s |
| Workspace restoration | Passed | 4.17 s |
| Tenant isolation and archive retention | Passed | 0.02 s |
| Cancellation | Passed | 2.25 s; cancellation settled in 317 ms |

The suite made **9 real model requests** and passed **6/6 checks** in approximately **19.5 seconds**, with no cleanup errors. Four completed runs reported **4,742 tokens** and an SDK cost estimate of **$0.0023828**; the cancelled run's usage is unknown and excluded. This result qualifies the selected model/path for these scenarios; it does not establish all-model compatibility or production reliability.
