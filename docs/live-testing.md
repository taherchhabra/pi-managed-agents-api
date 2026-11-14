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

`LIVE_MODEL` defaults to `openai/gpt-4.1-mini`. An override must be in the service OpenRouter catalog (Pi's pinned models plus `src/models.ts`) and support tool calling. For DeepSeek V4.1 Flash 1017, run `LIVE_MODEL=deepseek/deepseek-v4.1-flash-1017 npm run test:live`. The key must have access to that model. OpenRouter documents [bearer authentication](https://openrouter.ai/docs/api_reference/authentication) and its [tool-calling interface](https://openrouter.ai/docs/guides/features/tool-calling).

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

### DeepSeek V4.1 Flash 1017

Verified **14 November 2026, Asia/Kuala_Lumpur** (2026-11-13 19:11 UTC), with Pi SDK **1.5.2** and OpenRouter **deepseek/deepseek-v4.1-flash-1017**. All **6/6 checks** above passed in **16.2 seconds**, using **11 real model requests** with no cleanup errors. The run exercised `bash`, `write_file`, and `read_file`; verified generated artifacts and event replay; restored conversation and workspace state; and settled cancellation in **321 ms**. Four completed runs reported **10,357 tokens** and an SDK cost estimate of **$0.0006448492**, excluding unknown usage from the cancelled request. These results use the shared service model registration in `src/models.ts` without changing the pinned SDK.

### HCU Linux desktop

Verified **15 November 2026, Asia/Kuala_Lumpur** (2026-11-14 22:45 UTC), with the same DeepSeek model, Pi SDK **1.5.2**, QEMU/KVM and pinned Microsoft HCU. `npm run test:desktop:live` completed two real runs: the agent opened Mousepad, saved a note through the GUI, then resumed the same desktop and appended a second line to the open document. The harness downloaded the published artifact and checked both lines. It allowed only `AX` and `GUI`, with **22 tool calls and 14 saved screenshots**. The runs took **53.0 s and 22.7 s**, reporting **199,803 tokens** (including cached input) and an SDK cost estimate of **$0.010456536**.

See [Linux desktops with HCU](desktop.md) for setup and the separate KVM cancellation/fencing test. Desktop preview and screenshot endpoints are also covered by workspace-isolation tests. The live harness deliberately leaves its session for visual inspection; archive it afterward to release the VM.

After tightening fresh-boot readiness checks, the same live lifecycle passed again at **22:56 UTC**, using **19 AX/GUI calls, 4 screenshots**, **161,202 reported tokens** and an SDK cost estimate of **$0.004551728**. The separate real-VM contract harness passed authentication, tenant isolation, cancellation, stale-generation rejection, pause/resume and cleanup; its cancellation barrier settled in **726 ms**.
