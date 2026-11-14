export interface DocSection { id: string; title: string; body: string }
export interface DocPage { id: string; title: string; group: string; description: string; minutes: string; sections: DocSection[] }

export const docPages: DocPage[] = [
  {
    "id": "get-started",
    "title": "Get started",
    "group": "Start building",
    "description": "Create an agent, send a task, inspect its tools and files, then continue the same session.",
    "minutes": "7 min",
    "sections": [
      {
        "id": "before-you-start",
        "title": "Before you start",
        "body": "You need three things for your first run:\n\n- **A running workspace.** Use your own [local installation](#/docs/local-setup), [host it on a VPS](#/docs/self-hosting), or open the address your operator gave you.\n- **A workspace token.** This signs you in and identifies your workspace. [Find your token below](#/docs/get-started?section=workspace-token).\n- **A model provider.** In [Connections](#/connections), check that at least one provider is **Configured**. This confirms a key is present; your first successful run confirms model access.\n\nAlready signed in with a configured provider? Jump to [Create an agent](#/docs/get-started?section=create-an-agent)."
      },
      {
        "id": "workspace-token",
        "title": "Find your workspace token",
        "body": "Your **workspace token** is issued by the operator of this Pi Agents server. It is separate from an OpenRouter, OpenAI, or Anthropic API key.\n\n- **VPS installation:** the setup helper generates a token and saves it under `API_KEYS` in `.env.vps`.\n- **Existing local installation:** find `API_KEYS` in the server's `.env` file.\n- **Someone else hosts the workspace:** ask that operator for your token.\n\nThe configuration looks like this:\n\n```dotenv\nAPI_KEYS='{\"PASTE_YOUR_GENERATED_TOKEN_HERE\":\"demo\"}'\n```\n\nThe text **before the colon** is the token; `demo` is the workspace name. Open [the console](#/agents), paste **only the token** into **API token**, and select **Connect to workspace**. Do not paste the whole JSON object or a model provider key.\n\nFor a new local installation, [generate a token and configure the server](#/docs/local-setup?section=credentials). On a VPS, you can also [issue a token for another workspace](#/docs/self-hosting?section=keys). A workspace token grants access to that workspace's agents, sessions, logs, and files.\n\nThe console exchanges your token for an 8-hour browser session. Sign in again when it expires or the API restarts. These documentation pages remain available before sign-in."
      },
      {
        "id": "create-an-agent",
        "title": "1. Create an agent",
        "body": "Open [Agents](#/agents) and choose **Workspace assistant**, or select **Create agent** to start from scratch.\n\n- Give it a name, such as **My first agent**.\n- Describe its job in **Instructions**.\n- Choose a configured provider and a model. For OpenRouter, you can use `deepseek/deepseek-v4.1-flash-1017`.\n- Enable **Run commands**, **Read files**, and **Write files** for this walkthrough.\n\nSelect **Create agent** to save version 1. Here is a simple instruction to start with:\n\n```text\nYou are a practical coding assistant. Write and test code in your workspace. Save deliverables under outputs/ and explain your results briefly.\n```"
      },
      {
        "id": "start-a-session",
        "title": "2. Start a session",
        "body": "From the saved agent, select **Test agent**. Keep version 1 selected and choose **Managed sandbox**, or pick an existing managed environment. Select **Start session**.\n\nA session keeps the conversation and workspace files between tasks. Creating it does not call the model yet. The model runs when you send a message.\n\nFor an agent without tools, **Conversation only** is also available. The task below needs the managed sandbox."
      },
      {
        "id": "send-a-task",
        "title": "3. Give it a task",
        "body": "Paste this into **Message the agent** in the Playground. Press **Enter** or select the send arrow; use **Shift + Enter** for a new line.\n\n```text\nWrite a Python program that generates the first ten Fibonacci numbers. Run it and save the program as outputs/fibonacci.py and the numbers as outputs/fibonacci.txt. Briefly explain the result.\n```\n\nSending a task creates a run and uses your configured model provider account. Its status moves from **Queued** to **Running**, then **Completed**. The inspector updates as work is recorded; the assistant response appears when complete. You can close the page and reopen the session while the worker continues."
      },
      {
        "id": "inspect-the-result",
        "title": "4. Inspect the result",
        "body": "The **Inspector** sits beside the conversation on desktop and below it on a narrow screen. Use its three tabs:\n\n- **Runs:** expand the run, then a tool call, to see its arguments, result, and duration. The **tool calls** button below an assistant name takes you to that run.\n- **Event log:** choose a run, search event names or payloads, and select **Tools** or **Errors** to narrow the list. Select an event to inspect or copy its JSON.\n- **Artifacts:** preview or download `fibonacci.py` and `fibonacci.txt`. These are saved snapshots published from `outputs/` after a successful run.\n\nSelect **Export logs** at the top of the session to download its saved history. If the run fails or needs attention, use [Runs & logs](#/docs/runs-and-logs?section=troubleshoot) to find the next step."
      },
      {
        "id": "keep-building",
        "title": "5. Continue the conversation",
        "body": "Send a follow-up in the **same session**:\n\n```text\nRead outputs/fibonacci.txt and tell me the sum of those numbers.\n```\n\nFor the sequence `0, 1, 1, 2, 3, 5, 8, 13, 21, 34`, the expected sum is **88**. This second run should use the file and conversation from the first run.\n\nReturn through [Sessions](#/sessions) to continue later. Start a new session for a fresh conversation and separate files. If you edit the agent and save a new version, start a new session to test that version; existing sessions keep their original configuration.\n\nReady to connect your application? The [API quickstart](#/docs/api-quickstart) performs this complete lifecycle from Node.js, including the follow-up and artifact downloads. [Connect your app](#/docs/connect-your-app) explains how to use a workspace hosted on another server."
      }
    ]
  },
  {
    "id": "api-quickstart",
    "title": "API quickstart",
    "group": "Start building",
    "description": "Go from a few HTTP calls to a persistent agent session, using a complete Node.js example.",
    "minutes": "8 min",
    "sections": [
      {
        "id": "authenticate",
        "title": "1. Connect to your workspace",
        "body": "Use **Node.js 22.19+** and a running server with OpenRouter configured. Set the same workspace token you use to sign in to the console. Use [Find your workspace token](#/docs/get-started?section=workspace-token) if you do not have it yet. The token comes from the server's `API_KEYS` configuration; provider keys stay on the server.\n\n```sh\nexport API_URL='http://127.0.0.1:8080'\nexport API_TOKEN='your-workspace-token'\nexport MODEL_PROVIDER='openrouter'\nexport MODEL='deepseek/deepseek-v4.1-flash-1017'\n```\n\nAPI clients send `Authorization: Bearer <token>`. Every new `POST /v1/...` operation also needs an `Idempotency-Key`. Reuse the same key and body if you retry that operation after an uncertain response.\n\nFor a self-hosted server, set `API_URL=https://agents.example.com` instead. [Connect your app](#/docs/connect-your-app) explains remote app credentials, session ownership, and retries."
      },
      {
        "id": "check-connection",
        "title": "2. Check the connection",
        "body": "Fetch the available models and provider configuration flags:\n\n```sh\ncurl --fail-with-body \"$API_URL/v1/capabilities\" \\\n  -H \"Authorization: Bearer $API_TOKEN\"\n```\n\nChoose a model listed under your configured provider. A `401` means the workspace token was not accepted. If a provider is not configured, configure it with [Local setup](#/docs/local-setup?section=credentials) or the [VPS deployment guide](#/docs/self-hosting?section=configure)."
      },
      {
        "id": "client",
        "title": "3. Run the complete example",
        "body": "Save the following as **quickstart.mjs**, then run `node quickstart.mjs` in the terminal where you set the variables above. No client package is required.\n\nThe example creates an agent, a managed environment, and a session; sends a user message; waits for the response; sends a follow-up in the same session; and downloads the latest output files into memory. It prints both assistant responses and the downloaded file sizes. Each execution creates a new agent and session and makes two real agent runs."
      },
      {
        "id": "inspect-api-result",
        "title": "4. Inspect and continue",
        "body": "The script prints the session and run IDs, both assistant responses, and the downloaded files. Its second message reads the Fibonacci numbers saved by the first run and asks for their sum: **88**. Open [Sessions](#/sessions) in the console, using a token for the same workspace, to inspect the conversation, tool calls, logs, and files.\n\nTo continue a session, submit another `POST /v1/sessions/:session/runs` with:\n\n```json\n{\n  \"input\": \"Read outputs/ and summarize the files we created.\",\n  \"when_busy\": \"queue\"\n}\n```\n\nA `202` response means the run was accepted. Read `GET /v1/sessions/:session/runs/:run` for its final `status`, `output_text`, `error`, and `usage`. `when_busy` is required: `queue` waits behind existing work; `reject` returns `409` when the session is busy."
      },
      {
        "id": "useful-endpoints",
        "title": "Endpoints you will use",
        "body": "- `POST /v1/agents` — create a definition; use the response's `latest_version.id` for a session.\n- `POST /v1/environment-templates` — create a `managed` or `none` environment.\n- `POST /v1/sessions` — bind an `agent_version_id` to an `environment_template_id`.\n- `POST /v1/sessions/:session/runs` — send a task.\n- `GET /v1/sessions/:session/events?stream=true` — follow saved events using SSE.\n- `GET /v1/sessions/:session/artifacts` — list outputs and their `download_url` values. Downloads require the same bearer authentication.\n- `POST /v1/sessions/:session/runs/:run/cancel` — request cancellation with an empty JSON body `{}`.\n\nErrors use `{ \"error\": { \"code\": \"...\", \"message\": \"...\" } }`. Typical status codes are `400` for an invalid request, `401` for authentication, `404` for an unavailable resource, and `409` for a lifecycle or idempotency conflict."
      }
    ]
  },
  {
    "id": "connect-your-app",
    "title": "Connect your app",
    "group": "Start building",
    "description": "Call your hosted agents from any app backend using an HTTPS URL and a workspace token.",
    "minutes": "6 min",
    "sections": [
      {
        "id": "connection",
        "title": "One URL and one workspace token",
        "body": "Your application does not need Pi, Docker, database access, or a model provider key. Those stay on the agents server. It needs the deployment's **HTTPS origin** and a **workspace API token**. The app can run on any server with outbound HTTPS access.\n\nStore these values in your application's server environment or secret store:\n\n```dotenv\nAPI_URL=https://agents.example.com\nAPI_TOKEN=your-workspace-api-token\n```\n\nUse the origin without a trailing slash or `/v1`; the examples append the endpoint path. Send `Authorization: Bearer <token>` with every API request. Provider keys such as `OPENROUTER_API_KEY` are a different credential and cannot authenticate your app.\n\nThis is this project's HTTP API with its own agents, sessions, and runs. The integration pattern is familiar, but it is not a drop-in endpoint for OpenAI or Anthropic SDKs. Use standard HTTP clients such as `fetch`, curl, or your language's HTTP library."
      },
      {
        "id": "server-boundary",
        "title": "Keep the key in your backend",
        "body": "Have the browser or mobile app call **your own backend**. Your backend authenticates your users, checks which sessions they may access, and calls Pi Agents using its private token. Return results or forward events to your user interface.\n\nDo not put the workspace token in a browser bundle, public environment variable, or mobile application. It grants full workspace access. Server-to-server calls do not need CORS; the agents API intentionally does not enable cross-origin browser access with these long-lived keys.\n\nFor example, your web frontend might run at `app.example.net`, its backend at `api.example.net`, and Pi Agents at `agents.example.com`. They do not need to share a host or private network. Use a separate workspace for each app when you want their agent data isolated. [Issue an application token](#/docs/self-hosting?section=keys) on the agents server."
      },
      {
        "id": "verify",
        "title": "Verify the connection",
        "body": "Set `API_URL` and `API_TOKEN` in your terminal or application environment, then call:\n\n```sh\ncurl --fail-with-body \"$API_URL/v1/capabilities\"   -H \"Authorization: Bearer $API_TOKEN\"\n```\n\nThe response lists models and which providers are configured. Next, follow the [API quickstart](#/docs/api-quickstart) to create an agent, environment, session, and real run. Its complete Node.js example works unchanged with the remote `API_URL`.\n\nTo see your app's work in this console, sign in with a token mapped to the **same workspace**. A different workspace cannot see those IDs and receives `404` for them."
      },
      {
        "id": "app-lifecycle",
        "title": "Build around sessions and runs",
        "body": "Provision an agent version and environment once, using the console or API. Persist their IDs in your app's configuration. Create a session for a conversation or task context, and store its ID alongside the owning user or record in your application database.\n\nFor each message, submit `POST /v1/sessions/:session/runs`. Store the returned run ID. A `202` means the task was accepted and saved; it does not mean model work has finished. Poll the run endpoint or subscribe to events while the worker executes it.\n\nThe following Node.js server code starts a run for an existing session. Pass a stable `requestId` from your application's job record so retries do not create duplicate work:\n\n```javascript\nconst base = process.env.API_URL;\nconst token = process.env.API_TOKEN;\n\nexport async function startRun(sessionId, input, requestId) {\n  const response = await fetch(\n    `${base}/v1/sessions/${encodeURIComponent(sessionId)}/runs`,\n    {\n      method: 'POST',\n      headers: {\n        Authorization: `Bearer ${token}`,\n        'Content-Type': 'application/json',\n        'Idempotency-Key': requestId,\n      },\n      body: JSON.stringify({ input, when_busy: 'queue' }),\n      signal: AbortSignal.timeout(15_000),\n    },\n  );\n  const result = await response.json();\n  if (!response.ok) throw new Error(result.error?.message ?? 'Run rejected');\n  return result; // Persist result.id, then poll or stream.\n}\n```\n\nGenerate a new request ID for a new operation. If a network timeout makes the result uncertain, retry with the **same key and body**. Reusing the key with different input returns `409`. `when_busy: \"queue\"` waits behind existing work in that session; `\"reject\"` returns `409` if it is busy."
      },
      {
        "id": "results",
        "title": "Read results and stream progress",
        "body": "Read a run with `GET /v1/sessions/:session/runs/:run`. Its `status`, `output_text`, `error`, and `usage` describe the result. Stop polling on **completed**, **failed**, or **cancelled**. A **waiting** run needs a recovery decision; it is not still generating.\n\nUse a long-lived server connection to follow saved events:\n\n```sh\ncurl -N \"$API_URL/v1/sessions/$SESSION_ID/events?stream=true\"   -H \"Authorization: Bearer $API_TOKEN\"\n```\n\nSet `SESSION_ID` to your saved session ID. Reconnect with `Last-Event-ID` or `after=<last-sequence>` and deduplicate by event ID. Disconnection does not cancel work. On a platform with short request limits, use a background job to poll; keep model execution on the agents worker.\n\nList outputs with `GET /v1/sessions/:session/artifacts`. Each `download_url` is a relative API path that also requires bearer authentication. Your backend can proxy the file to authorized users. Do not append the secret token to a download URL."
      },
      {
        "id": "errors",
        "title": "Handle failures and limits",
        "body": "- **400:** inspect the request body and required `Idempotency-Key` header.\n- **401:** check the workspace token and whether it was activated or revoked on the server.\n- **404:** check the resource ID and token's workspace. Resources in another workspace are hidden.\n- **409:** inspect the lifecycle conflict or reuse of an idempotency key with different content.\n- **429:** wait for the `Retry-After` interval before retrying. The default limit is shared by requests from the same client IP.\n- **5xx or connection timeout:** retry with bounded backoff. Keep the same idempotency key and body for a POST whose outcome is uncertain.\n\nA provider failure is recorded on the run after admission; a successful POST alone cannot confirm model access. Inspect the run and its [saved logs](#/docs/runs-and-logs). Make app-level access, concurrency, and spending decisions before admitting work; workspace tokens currently have no per-user permissions or billing quotas."
      }
    ]
  },
  {
    "id": "concepts",
    "title": "Core concepts",
    "group": "Understand your workspace",
    "description": "A small set of resources takes an agent from instructions to a finished task.",
    "minutes": "3 min",
    "sections": [
      {
        "id": "agents",
        "title": "Agents and versions",
        "body": "An **agent** defines a purpose, provider, model, instructions, and allowed tools. Saving it creates an immutable **version**.\n\nEditing the definition creates another version. Existing sessions keep the version they started with. To try new instructions or a different model, start a session using the new version."
      },
      {
        "id": "environments",
        "title": "Environments",
        "body": "An **environment template** chooses how work runs. **Managed sandbox** gives a session Bash, Python, and a filesystem when those tools are enabled on the agent. **Conversation only** keeps model context without tool execution and requires an empty tools list.\n\nCreate templates in [Environments](#/environments), or let **Test agent** create one when you choose a workspace type."
      },
      {
        "id": "sessions",
        "title": "Sessions",
        "body": "A **session** connects one agent version with one environment template. It owns the conversation, run history, and, for a managed environment, a persistent workspace.\n\nUse the same session for related tasks. Use a new session for a fresh conversation and separate files. Changing an agent later does not change an existing session."
      },
      {
        "id": "runs",
        "title": "Runs",
        "body": "Each submitted task creates a **run**. The run contains the input, model work, tool calls, final output, and status. A session executes one run at a time; additional inputs can be queued.\n\nA waiting run blocks later queued work until you resolve or cancel it. [Runs and logs](#/docs/runs-and-logs) explains how to inspect progress and recover from a problem."
      },
      {
        "id": "events-and-artifacts",
        "title": "Events and artifacts",
        "body": "**Events** record what happened: input accepted, run started, tool requested, tool completed, and run finished. They can be replayed after reconnecting.\n\n**Artifacts** are downloadable snapshots of files saved under `/workspace/outputs` by successful runs. Files in the working directory can change in later runs; published artifacts keep their original bytes."
      }
    ]
  },
  {
    "id": "tools-and-sandboxes",
    "title": "Tools & sandboxes",
    "group": "Understand your workspace",
    "description": "Give your agent a place to write code and keep files between tasks.",
    "minutes": "4 min",
    "sections": [
      {
        "id": "available-tools",
        "title": "Choose the tools it needs",
        "body": "Enable tools in the agent definition before starting a managed session:\n\n- **Run commands** (`bash`) executes Bash and Python commands. Each command has a 30-second limit; returned output is capped at 64 KiB.\n- **Read files** (`read_file`) reads a UTF-8 file inside `/workspace`, up to 64 KiB.\n- **Write files** (`write_file`) creates or updates a UTF-8 file inside `/workspace`, up to 64 KiB.\n\nTools execute sequentially. Ordinary command or file errors are returned to the agent so it can correct them."
      },
      {
        "id": "sandbox",
        "title": "Your managed workspace",
        "body": "The default environment uses the local Docker image `pi-managed-sandbox:dev`, built with Python 3.13 and Bash. Each execution attempt gets a fresh container and mounts the session's persistent volume at `/workspace`.\n\nThe container runs as a non-root user with a read-only root filesystem, **1 CPU**, **512 MiB RAM**, and no network access. Temporary storage at `/tmp` is limited to 64 MiB.\n\nPi and model API calls run in the server worker. Shell and file tools run inside the container. Model provider keys stay in the worker."
      },
      {
        "id": "publish-files",
        "title": "Turn files into artifacts",
        "body": "Ask the agent to save deliverables in `outputs/`, relative to `/workspace`. After a successful run, those files appear in the session's **Artifacts** tab.\n\n```text\nCreate a short Markdown report and save it as outputs/report.md.\n```\n\nExport supports up to **20 files**, **5 MiB per file**, and **20 MiB total**. Published files remain available after the session is archived. Each successful run publishes a snapshot, so unchanged files can appear more than once."
      },
      {
        "id": "dependencies",
        "title": "Work with available dependencies",
        "body": "Network access is disabled inside the sandbox, so commands cannot fetch websites or install packages from the internet. Start with Python's standard library and Bash.\n\nIf your tasks need extra packages, the server operator can build a custom image and set `SANDBOX_IMAGE` before creating an environment template. The image must provide Python 3, Bash, `sleep`, user/group 10001, and a `/workspace` directory writable by that user. See [Local setup](#/docs/local-setup?section=sandbox-image)."
      }
    ]
  },
  {
    "id": "runs-and-logs",
    "title": "Runs & logs",
    "group": "Understand your workspace",
    "description": "Follow progress, understand a failure, and keep the evidence from each task.",
    "minutes": "4 min",
    "sections": [
      {
        "id": "inspect",
        "title": "Read the session inspector",
        "body": "Open a session from [Sessions](#/sessions). **Playground** shows your messages and completed assistant responses. **Inspector** appears beside it on desktop and below it on a narrow screen.\n\n- **Runs** groups the steps for each task. Expand a run to see its attempt, duration, reported cost, and saved steps. Expand a tool call for its arguments and result. The **tool calls** button in the conversation opens the matching run.\n- **Event log** lists sequence numbers, event names, and timestamps. Use **Filter inspector by run**, **Search events**, and the **All events / Tools / Errors** selector to focus on the work you need. Select a row to inspect the payload, copy it, or expand **Full event JSON**.\n- **Artifacts** lists files published from successful runs. **Preview** is available for supported text files up to 256 KiB; **Download** saves any published file. Later changes to workspace files do not alter an existing artifact.\n\nThe summary above the Playground shows the pinned model, environment, run count, tool calls, and reported tokens. Usage comes from Pi; interrupted attempts may have incomplete usage.\n\nUse **Export logs** to download the session history, including runs and events beyond the currently visible list."
      },
      {
        "id": "statuses",
        "title": "Understand run status",
        "body": "- **Queued:** the input has been accepted and is waiting for a worker or earlier work.\n- **Running:** the agent is processing the task.\n- **Completed:** the response and any published artifacts have been saved.\n- **Failed:** the attempt ended with an error; inspect its message and tool events.\n- **Cancelling:** cancellation has been requested and work is stopping.\n- **Cancelled:** the run has stopped or was removed from the queue.\n- **Waiting:** the attempt was interrupted and needs an explicit recovery decision."
      },
      {
        "id": "events",
        "title": "Follow and reconnect to events",
        "body": "The console reconnects to the event stream automatically. API clients can use:\n\n```sh\ncurl -N \"$API_URL/v1/sessions/$SESSION_ID/events?stream=true&after=0\" \\\n  -H \"Authorization: Bearer $API_TOKEN\"\n```\n\nReplace `SESSION_ID` with your session ID. To resume later, send the last saved sequence using `after` or the `Last-Event-ID` header. Sequence values are decimal strings; deduplicate events by ID.\n\nStreaming covers saved lifecycle, tool, and result events. Individual response tokens and partial shell output are not streamed. Closing the page or disconnecting the stream does not cancel a run."
      },
      {
        "id": "cancel-and-recover",
        "title": "Cancel or recover a run",
        "body": "Use **Cancel** to stop queued or running work. Cancellation stops the model and active sandbox work before the run is marked cancelled. File changes already made in the workspace are not rolled back.\n\nFor a **waiting** run, **Resume** is available only when no tools have been dispatched. If tools ran, inspect their effects, cancel the interrupted attempt, and submit a new task. This avoids replaying an action with an uncertain result."
      },
      {
        "id": "troubleshoot",
        "title": "Troubleshoot your first task",
        "body": "**The provider is not configured.** Add its API key on the server and restart the API and worker. [Local setup](#/docs/local-setup?section=credentials) shows the settings.\n\n**The model is unavailable or returns an error.** Check the provider, model ID, and account access in **Connections**. A configured key alone does not verify model access.\n\n**The run stays queued.** Check earlier runs in the session, then check that a worker is running. Local development starts the API and worker together.\n\n**There are no artifacts.** Confirm that the run completed and the agent saved files under `outputs/`. File tools need a managed environment.\n\n**A command cannot reach the internet.** Managed sandboxes have networking disabled. Use available packages or ask the operator for a custom image.\n\n**A workspace is missing.** Start a new session, or have the operator restore the existing session's volume before resuming."
      }
    ]
  },
  {
    "id": "local-setup",
    "title": "Local setup",
    "group": "Run it yourself",
    "description": "Start the API, console, worker, and sandbox on your development machine.",
    "minutes": "6 min",
    "sections": [
      {
        "id": "prerequisites",
        "title": "What you need",
        "body": "For an internet-accessible service, use [Self-host on a VPS](#/docs/self-hosting). This guide starts a local development instance.\n\nInstall **Node.js 22.19+**, npm, and Docker with Compose on the Linux host that will run the service. You also need a model provider account and its API key.\n\nThe API and worker run in Node. Docker runs development PostgreSQL and the agent sandboxes. Run the commands below from your project checkout. If your workspace is already running, skip to [credentials](#/docs/local-setup?section=credentials) or [Get started](#/docs/get-started)."
      },
      {
        "id": "start-services",
        "title": "1. Prepare the services",
        "body": "```sh\nnpm ci\ndocker compose up -d --wait\ndocker build -f Dockerfile.sandbox -t pi-managed-sandbox:dev .\n# Create .env only if it does not already exist.\n[ -f .env ] || cp .env.example .env\n```\n\nCompose starts development PostgreSQL on `127.0.0.1:55432`. The image provides Python and Bash for managed sessions."
      },
      {
        "id": "credentials",
        "title": "2. Configure credentials",
        "body": "Edit the server's local `.env` file. For a **new installation**, generate a random workspace token:\n\n```sh\nnode -e \"console.log('pi_' + require('node:crypto').randomBytes(32).toString('base64url'))\"\n```\n\nCopy the output into `API_KEYS` as the JSON key before the colon. The value, `demo`, names the workspace. Reuse your existing token if this installation already has one. Tokens must contain at least 24 characters.\n\n```dotenv\nAPI_KEYS='{\"PASTE_YOUR_GENERATED_TOKEN_HERE\":\"demo\"}'\nOPENROUTER_API_KEY=your-openrouter-key\n```\n\nReplace both placeholders with your own values. Use **only the generated workspace token** in the console's **API token** field or your app backend's `API_TOKEN`. Keep the model provider key on the agents server; it does not sign you into the console. OpenAI and Anthropic use `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` respectively.\n\nThe `.env` file is ignored by Git. After changing credentials on a running instance, restart the API and worker. Existing console sessions need to sign in again after an API restart."
      },
      {
        "id": "start-console",
        "title": "3. Start the console",
        "body": "```sh\nnpm run dev\n```\n\nThis builds the UI, applies database migrations, and starts the API and worker together. Open **http://127.0.0.1:8080** and sign in with your workspace token.\n\nConfirm your provider is configured in [Connections](#/connections), then follow [Get started](#/docs/get-started). For compiled JavaScript, use `npm run build` followed by `npm start`."
      },
      {
        "id": "sandbox-image",
        "title": "4. Customize when you need to",
        "body": "Set `SANDBOX_IMAGE` to use a custom local image, then create a new environment template. Templates capture the selected image. Use an image digest when you need its contents pinned.\n\nFor UI development with hot reloading, run `npm run dev:api` and `npm run dev:ui` in separate terminals. The UI is available at **http://127.0.0.1:5173** and proxies API calls to port 8080.\n\nThis MVP runs on one Docker host with persistent database, workspace, and artifact storage. For separate API and worker processes, use `ROLE=api` and `ROLE=worker`; workers must share the Docker daemon and artifact storage."
      }
    ]
  },
  {
    "id": "self-hosting",
    "title": "Self-host on a VPS",
    "group": "Run it yourself",
    "description": "Run your own HTTPS agents service, with a console and an API that your apps can call from anywhere.",
    "minutes": "12 min",
    "sections": [
      {
        "id": "what-you-deploy",
        "title": "What you will deploy",
        "body": "Your app backend calls **https://agents.example.com/v1/...** using a workspace API token. It can run on another VPS, a serverless platform, or your development machine. The agents service owns execution and persistence; your app keeps the session and run IDs.\n\nThe supplied `compose.vps.yaml` runs four services plus tool sandboxes:\n\n- **Gateway:** Caddy serves HTTPS, redirects HTTP, and forwards the console, API, and event streams.\n- **API:** authenticates requests, saves inputs, serves the console and docs, and reads results. It has no model provider keys or Docker socket.\n- **Worker:** runs the Pi coding agent SDK, calls your configured provider, and starts tool sandboxes through the host Docker daemon.\n- **Database:** PostgreSQL stores definitions, sessions, checkpoints, runs, and events on a persistent volume.\n- **Sandbox containers:** the worker creates these on demand, with a persistent volume per session. Published artifacts have their own shared volume.\n\nOnly the gateway publishes host ports. The API, worker, and database stay on private Docker networks. The Compose file contains four long-running containers; sandboxes are created as work arrives."
      },
      {
        "id": "requirements",
        "title": "1. Prepare the host and domain",
        "body": "Use a **dedicated Linux VPS** with Docker Engine, the Docker Compose plugin, Git, and **Node.js 22.19+** for the deployment helper. The API and worker themselves run in containers. A starting allocation is **2 vCPU and 4 GB RAM** for one worker; measure your workload before increasing concurrency. Model inference runs at your provider, so no GPU is needed.\n\nPoint a DNS hostname such as `agents.example.com` to the VPS. Every published A or AAAA record must reach that host. Allow inbound **TCP 80 and 443** in the VPS provider's firewall, plus your restricted SSH access. Keep the Docker socket and database private. The worker needs outbound HTTPS to the model provider.\n\nUse a hostname directly on this VPS for the supplied configuration. Caddy obtains and renews public certificates when DNS and ports are reachable. See [Caddy's HTTPS requirements](https://caddyserver.com/docs/automatic-https#overview) if certificate issuance fails.\n\n```sh\ngit clone https://github.com/taherchhabra/pi-managed-agents-api.git\ncd pi-managed-agents-api\nnode --version\ndocker version\ndocker compose version\n```\n\nRun these commands as an operator with access to the local Docker daemon. This deployment uses the standard `/var/run/docker.sock`; remote Docker daemons and rootless socket layouts need a different deployment configuration."
      },
      {
        "id": "configure",
        "title": "2. Generate private configuration",
        "body": "Replace the example hostname and email, then initialize the deployment:\n\n```sh\nnode scripts/vps.mjs init agents.example.com you@example.com\n```\n\nThis creates **.env.vps** with a random database password, a random workspace token for the `demo` workspace, and your host's Docker socket group. The file is readable only by its owner and ignored by Git. Initialization refuses to overwrite an existing file.\n\nEdit `.env.vps` on the VPS and set at least one of `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`. Use a literal provider key without a trailing comment. `API_KEYS` maps workspace tokens to workspace names. The random token on the left side of its JSON object is the token you will use to sign in.\n\nKeep this file private and include it in an encrypted backup. Do not regenerate the database password on an existing database volume; changing an environment variable alone does not rotate PostgreSQL's stored password.\n\n```sh\nnode scripts/vps.mjs check\nnode scripts/vps.mjs up\n```\n\nThe helper builds the sandbox, API, and worker images, starts the stack, applies database migrations, and waits for API/worker/database health. It uses `.env.vps` explicitly so your development `.env` does not select deployment credentials. The first build can take several minutes. Use `--file /private/path/config.env` on every helper command if you keep configuration elsewhere.\n\nUse this dedicated Compose file for VPS hosting. The plain `docker compose up` command starts the separate development database configuration."
      },
      {
        "id": "verify",
        "title": "3. Verify HTTPS and run an agent",
        "body": "Replace the hostname below:\n\n```sh\ncurl --fail-with-body https://agents.example.com/healthz\nnode scripts/vps.mjs status\n```\n\nThe health endpoint returns `{\"status\":\"ok\"}` when the API can reach PostgreSQL. It does not validate provider access or available credits. If HTTPS is not ready, inspect `node scripts/vps.mjs logs`, DNS, and ports 80/443. Do not bypass certificate verification.\n\nOpen **https://agents.example.com** and sign in using the workspace token in `.env.vps`. Check **Connections**, then follow [Get started](#/docs/get-started) to run a real task and inspect its logs and artifacts. The documentation is also served by your instance at **/#/docs/get-started**, including before sign-in.\n\nA successful task verifies the full path through the worker, model provider, and sandbox. Now [connect an application](#/docs/connect-your-app) using this HTTPS origin and a workspace token."
      },
      {
        "id": "keys",
        "title": "4. Issue and rotate application tokens",
        "body": "Create a separate workspace for an application:\n\n```sh\nnode scripts/vps.mjs key my-app\nnode scripts/vps.mjs up\n```\n\nThe first command writes a new token to a private file under `.data/vps-keys/` and prints that file's path. Copy its contents into your application's server-side secret store. The `up` command activates the configuration. Sign in to this console with that token to create agents and sessions for **my-app**.\n\n**Workspace names define data isolation.** Keys mapped to the same name share all agents, sessions, logs, and files in that workspace. Different names create separate workspaces. Each key currently grants full API access to its workspace; there are no read-only keys or per-user roles.\n\nTo give an existing app a replacement token, run `key` with the **same workspace name**. Activate it, update the application, and verify a request. Then revoke the old key using the file that contains it:\n\n```sh\nnode scripts/vps.mjs revoke /private/path/old-token.token\nnode scripts/vps.mjs up\n```\n\nRevocation changes the configuration immediately but takes effect in the API after `up`. Restarting the API signs console users out and closes event streams; clients can reconnect using their last event sequence. Keep the original generated token privately if you need to revoke it later; it can be placed in a mode-0600 token file."
      },
      {
        "id": "operations",
        "title": "Operations and backups",
        "body": "Inspect the stack or follow its logs:\n\n```sh\nnode scripts/vps.mjs status\nnode scripts/vps.mjs logs\n```\n\nDocker restarts the services after a host reboot. Published artifacts, session workspaces, database state, and Caddy certificates live in persistent Docker volumes. Logs rotate at 10 MB per file, with three files per service. Monitor disk space, run failures, provider spend, and queued work.\n\nFor this single-VPS deployment, take an **encrypted full-disk snapshot during a maintenance window**. Pause task submissions and wait for active runs to finish, then stop the stack:\n\n```sh\nnode scripts/vps.mjs stop\n```\n\nTake the VPS provider's disk snapshot while the stack is stopped, then run `node scripts/vps.mjs up`. Include every disk containing Docker data, the checkout, and `.env.vps`. A PostgreSQL dump alone is incomplete: artifacts and `pi-workspace-*` volumes contain additional session data. Do not run volume-prune or `down --volumes` on a deployment you want to retain.\n\nTo restore, recover the full snapshot onto a VPS with the same Docker data paths, restore DNS, and run `node scripts/vps.mjs up`. The helper refreshes the Docker socket group for the restored host. Verify old session history, an artifact download, and a follow-up task before reopening traffic. Test this restoration procedure with your VPS provider; the local test harness verifies restart persistence, not your provider's snapshot recovery.\n\nBefore updating, take a backup, pause submissions, and let active runs finish. Fetch the new revision with `git pull --ff-only`, then run `node scripts/vps.mjs up`. Review release changes first: migrations may require restoring the full backup to roll back. Keep the source revision and Pi SDK version with your backup. Interrupted attempts can become **waiting** and require an explicit recovery decision; see [Runs & logs](#/docs/runs-and-logs?section=cancel-and-recover)."
      },
      {
        "id": "limits",
        "title": "Deployment limits",
        "body": "This package targets **one VPS operated by a trusted owner**, with one API process and one worker. Applications may be hosted anywhere; the service's worker, Docker volumes, and artifacts remain on that VPS. The worker handles one run at a time. This setup does not provide high availability, distributed storage, autoscaling, or zero-downtime upgrades.\n\nThe worker has access to the host Docker socket, which grants host-level control. Keep the VPS dedicated to this service and allow only trusted operators to administer it. Tool containers have no network, provider credentials, or Docker socket, but ordinary Docker containers are not a hardened boundary for a public untrusted-code platform.\n\nThe API defaults to **600 requests per minute per client IP**, with a separate **10 sign-in attempts per minute per IP** limit. Set `RATE_LIMIT_MAX` and `LOGIN_RATE_LIMIT_MAX` in `.env.vps`, then apply with `up`. A `429` includes `Retry-After`. These counters are in memory and reset on API restart. They are traffic limits, not per-workspace usage or spending quotas; add application authentication and provider spending controls for your users.\n\nThe supplied gateway is the only trusted proxy hop. Adding a CDN, load balancer, another API replica, or direct API port exposure requires reviewing proxy trust and rate limiting. Keep the default deployment topology until you have configured those changes explicitly."
      },
      {
        "id": "test-deployment",
        "title": "Test the packaged deployment",
        "body": "From a machine with Docker and Node.js, run:\n\n```sh\nnpm run test:deployment\n```\n\nThis builds an isolated stack, binds its host ports only to loopback, and connects from a separate application container over HTTPS with a trusted test CA. It checks authentication, workspace isolation, secure console cookies, idempotency, SSE delivery, Docker tools, artifact permissions, and persistence after service restarts. No model key is required and no model response is simulated by this deployment test.\n\nFor the complete model path, set `OPENROUTER_API_KEY` in your ignored local `.env` file and run:\n\n```sh\nnpm run test:deployment:live\n```\n\nThis opt-in test uses provider credits. It executes a real model through Pi, downloads a generated artifact, restarts the stack, and verifies a follow-up in the same conversation and workspace. Both modes remove their test services and volumes and keep a sanitized report under `.data/deployment-tests/`. They do not deploy to a public VPS or validate public DNS/certificate issuance."
      }
    ]
  }
];
