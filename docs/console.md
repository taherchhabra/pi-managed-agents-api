# Pi Agents console

The console is built around this service's resources: agents with immutable versions, environment templates, persistent sessions, individual runs, ordered events, and published artifacts. It uses the real API and Pi worker. No simulated model responses or seeded success states are shipped.

## Start

Follow the [local setup](../README.md#run-locally), then run `npm run dev`. Open **http://127.0.0.1:8080** and enter an existing token from the server's `API_KEYS` configuration. Do not enter an OpenRouter, OpenAI, or Anthropic key in the console.

Production builds use `npm run build` and `npm start`. The compiled UI lives in `dist/client`, alongside the compiled API under `dist/src`.

For frontend development, use two terminals:

```sh
npm run dev:api
npm run dev:ui
```

Open **http://127.0.0.1:5173**. Vite proxies API, authentication, and event-stream requests to port 8080. UI changes hot reload; server changes require restarting the API.

## Workflows

- **Agents:** create a definition from scratch or start with a workspace assistant, data analyst, or writing partner. Choose a provider and a model from the installed Pi catalog. Enable Bash, file reads, and file writes as needed. Saving edits creates a new version. The Versions view inspects and tests older definitions; existing sessions retain their original version.
- **Environments:** create a Linux desktop, managed sandbox, or conversation-only template. Desktop environments choose Off, Internet, or a domain allowlist for HTTP/HTTPS; each session pins this policy. Managed sandboxes use the operator's image, one CPU, 512 MB memory, no network, and a non-root user. A version with tools requires a Docker or desktop environment; AX/GUI requires a desktop. Sessions have separate persistent workspaces.
- **Sessions:** start a session from any saved agent version. Send messages, queue follow-ups while a run is active, and revisit the same conversation after refreshing. Search the latest 100 sessions and filter pending, failed, or archived work.
- **Playground:** see user prompts, completed Markdown responses, run status, timings, and reported token usage. Cancellation stops the active generation/sandbox through the worker. A waiting run can be resumed only when no tools have executed; the API enforces that recovery boundary.
- **Inspector:** browse each run's persisted steps, expand tool arguments/results, inspect full event JSON, and search logs by event type or payload. The event stream reconnects from its last sequence, deduplicates replayed events, and displays connection state. Log export fetches the full server history, including pages not visible in the inspector.
- **Artifacts:** preview text outputs and download immutable files from completed runs. Each successful run publishes a snapshot of `outputs/`, so an unchanged file can appear for several runs. Previews render file contents as text, including HTML and SVG.
- **Connections:** inspect which server provider keys are configured and which models exist in the service catalog (Pi's pinned catalog plus service additions). Presence of a key is not proof of provider connectivity. A successful run verifies actual access. Provider secrets remain operator-managed.
- **Documentation:** read the in-app getting-started walkthrough, API quickstart, remote app integration, core concepts, sandbox guide, run/log guide, local setup, and VPS deployment guide. Search across the guides, copy prompts or code, and follow links directly into the console. Documentation is also accessible before sign-in at `#/docs/get-started`. The API quickstart displays the same `examples/run.mjs` source exercised by the integration suite. The app integration page shows the current instance's API origin with a copy button.

Archiving preserves history and published artifacts, prevents new runs, and releases the sandbox workspace. The UI explains that consequence before submitting the action. Pending runs must be cancelled or finished first.

## Browser authentication

`POST /console/login` exchanges an existing bearer token for an opaque random cookie. The cookie is HttpOnly, host-scoped, SameSite=Strict, and expires after eight hours. The browser does not persist the bearer token in localStorage or sessionStorage. Sign-out revokes the server session. API restarts also invalidate console sessions; sign in again afterward.

Cookie-authenticated mutations require an exact matching Origin and the `X-Pi-Console: 1` header. No cross-origin access is enabled. Bearer authentication continues to work for API clients, including SSE and artifact downloads. API token and cookie headers are redacted from logs. The static app has a restrictive content security policy; model Markdown does not execute HTML or fetch remote images.

For an HTTPS reverse proxy, set `CONSOLE_ORIGIN=https://agents.example.com` (no trailing slash) on the API process. This supplies the expected browser origin and marks cookies Secure even when the proxy connects to the API over HTTP. Preserve the same origin for UI and API, and disable buffering on the SSE route. The local development defaults require no proxy configuration. Console sessions are process-local, so multiple API instances need sticky routing or a shared session store before using the console across instances.

## Read API additions

`GET /v1/agents` adds `latest_version` and `session_count`. `GET /v1/sessions` adds agent/version/environment labels, latest-run summary, run count, and pending count. Session detail includes the **pinned** config and its labels, not the agent's current version.

`GET /v1/sessions/:id/runs` returns runs in `(created_at,id)` order, with up to 100 entries per page. Supply the previous `next_cursor` as `?after=<run-id>` until it becomes null. Cursor timestamps are compared inside PostgreSQL so sub-millisecond precision is preserved. A cursor belonging to another session or tenant is rejected.

`GET /v1/capabilities` returns the three supported providers, their installed static model catalogs, `configured` booleans, sandbox image, and SDK version. It does not contact a provider or return a secret. In the VPS stack, the API receives only `OPENAI_CONFIGURED`, `ANTHROPIC_CONFIGURED`, and `OPENROUTER_CONFIGURED` flags; provider keys remain in the worker. The Compose file derives both from the same private deployment configuration.

## Scope and verification

The console displays committed run and tool events. It does not display token-by-token model deltas, internal model-request traces, hidden reasoning, or process stdout outside recorded tool results. Reported tokens/costs come from Pi's completed-run usage; interrupted usage can be unknown. There is no web secret editor, arbitrary sandbox image picker, MCP configuration, file upload, or subagent UI in this MVP.

Browser verification used the real OpenRouter `openai/gpt-4.1-mini` model with the production Pi adapter and Docker executor. It covered agent creation/version history, managed and conversation-only environment creation, session creation, file write/read/Bash calls, completed responses, context restoration after refresh, tool-error inspection, cancellation, queued follow-up execution, raw logs, filtering, artifact preview/download, and JSON-log export. The mobile layout was checked at 390 px, including navigation and horizontal overflow. Development test data is kept out of the repository.

Automated tests cover cookie sign-in/out, Origin/header checks, tenant isolation, HTTPS proxy cookies, provider-secret non-disclosure, pinned version read models, and multi-page run history with equal timestamps. The existing integration suite continues to test runtime recovery, SSE replay, cancellation, artifacts, and sandbox behavior.

## Visual reference

The OpenAI Agents interface was explored through agent setup, templates, integration/function dialogs, environment setup, session creation, successful and failed session logs, generation details, filters, and vault setup. Its restrained navigation, progressive setup, and inspectable execution history informed the design. Pi's navigation and workflows follow this project's implemented resource model rather than reproducing OpenAI's screens or unsupported features. The [OpenAI Agents overview](https://developers.openai.com/api/docs/guides/agents-api/overview) documents that reference product.
