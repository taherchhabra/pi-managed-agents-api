export interface DocSection { id: string; title: string; body: string }
export interface DocPage { id: string; title: string; group: string; description: string; minutes: string; sections: DocSection[] }

export const docPages: DocPage[] = [
  {
    "id": "get-started",
    "title": "Get started",
    "group": "Start building",
    "description": "Create your first agent, run a task, and see exactly what happened.",
    "minutes": "5 min",
    "sections": [
      {
        "id": "before-you-start",
        "title": "Before you start",
        "body": "You need a running Pi Agents workspace, its **workspace API token**, and a model provider configured on the server. If you are already signed in, you can start below.\n\nOpen [Connections](#/connections) and look for a **configured** provider. This means a key is present; your first successful run confirms model access. Need to start the server or add a key? Follow [Local setup](#/docs/local-setup)."
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
        "body": "Paste this into the session composer and send it. The agent will write code, run it in the sandbox, and save a file you can inspect.\n\n```text\nWrite a Python program that generates the first ten Fibonacci numbers. Run it and save the program as outputs/fibonacci.py and the numbers as outputs/fibonacci.txt. Briefly explain the result.\n```\n\nThe run moves from **queued** to **running**, then **completed**. Keep the session open to follow its progress. Sending a task uses your configured model provider account."
      },
      {
        "id": "inspect-the-result",
        "title": "4. Inspect the result",
        "body": "Use the session inspector beside the conversation:\n\n- **Runs** shows each attempt, its status, and the tool calls. Expand a call to see its arguments and result.\n- **Event log** shows the saved event log. Search or inspect an event's JSON to understand what happened.\n- **Artifacts** contains files published from `outputs/` after a successful run. Preview or download `fibonacci.txt`.\n\nSelect **Export logs** to download the session history. Events update as work is recorded; assistant text appears when a response is complete."
      },
      {
        "id": "keep-building",
        "title": "5. Continue the conversation",
        "body": "Send a follow-up in the same session:\n\n```text\nRead outputs/fibonacci.txt and tell me the sum of those numbers.\n```\n\nThe agent uses the existing workspace and conversation. Start a new session when you want a fresh task context.\n\nYou are ready to [build with the API](#/docs/api-quickstart), learn how [agents and sessions fit together](#/docs/concepts), or explore [runs and logs](#/docs/runs-and-logs)."
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
        "body": "Use **Node.js 22.19+** and a running server with OpenRouter configured. Set the same workspace token you use to sign in to the console. It is a token from the server's `API_KEYS` configuration; provider keys stay on the server.\n\n```sh\nexport API_URL='http://127.0.0.1:8080'\nexport API_TOKEN='your-workspace-token'\nexport MODEL_PROVIDER='openrouter'\nexport MODEL='deepseek/deepseek-v4.1-flash-1017'\n```\n\nAPI clients send `Authorization: Bearer <token>`. Every new `POST /v1/...` operation also needs an `Idempotency-Key`. Reuse the same key and body if you retry that operation after an uncertain response."
      },
      {
        "id": "check-connection",
        "title": "2. Check the connection",
        "body": "Fetch the available models and provider configuration flags:\n\n```sh\ncurl --fail-with-body \"$API_URL/v1/capabilities\" \\\n  -H \"Authorization: Bearer $API_TOKEN\"\n```\n\nChoose a model listed under your configured provider. A `401` means the workspace token was not accepted. If a provider is not configured, follow [Local setup](#/docs/local-setup?section=credentials)."
      },
      {
        "id": "client",
        "title": "3. Run the complete example",
        "body": "Save the following as **quickstart.mjs**, then run `node quickstart.mjs` in the terminal where you set the variables above. No client package is required.\n\nThe example creates an agent, a managed environment, and a session; submits a task; follows its event stream; and prints the final response and artifact download paths. Each execution creates a new session and makes real model calls."
      },
      {
        "id": "inspect-api-result",
        "title": "4. Inspect and continue",
        "body": "The script prints the session and run IDs. Open [Sessions](#/sessions) in the console, using a token for the same workspace, to inspect the conversation, tool calls, logs, and files.\n\nTo continue a session, submit another `POST /v1/sessions/:session/runs` with:\n\n```json\n{\n  \"input\": \"Read outputs/ and summarize the files we created.\",\n  \"when_busy\": \"queue\"\n}\n```\n\nA `202` response means the run was accepted. Read `GET /v1/sessions/:session/runs/:run` for its final `status`, `output_text`, `error`, and `usage`. `when_busy` is required: `queue` waits behind existing work; `reject` returns `409` when the session is busy."
      },
      {
        "id": "useful-endpoints",
        "title": "Endpoints you will use",
        "body": "- `POST /v1/agents` — create a definition; use the response's `latest_version.id` for a session.\n- `POST /v1/environment-templates` — create a `managed` or `none` environment.\n- `POST /v1/sessions` — bind an `agent_version_id` to an `environment_template_id`.\n- `POST /v1/sessions/:session/runs` — send a task.\n- `GET /v1/sessions/:session/events?stream=true` — follow saved events using SSE.\n- `GET /v1/sessions/:session/artifacts` — list outputs and their `download_url` values. Downloads require the same bearer authentication.\n- `POST /v1/sessions/:session/runs/:run/cancel` — request cancellation with an empty JSON body `{}`.\n\nErrors use `{ \"error\": { \"code\": \"...\", \"message\": \"...\" } }`. Typical status codes are `400` for an invalid request, `401` for authentication, `404` for an unavailable resource, and `409` for a lifecycle or idempotency conflict."
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
        "body": "Open a session from [Sessions](#/sessions). The conversation shows prompts and completed assistant responses. In the inspector:\n\n- **Runs** groups the steps for each task. Expand tool calls to inspect inputs and results.\n- **Event log** shows the saved event log, with search, filters, and raw JSON details.\n- **Artifacts** lets you preview or download published files.\n\nUse **Export logs** to save the session history, including runs and events beyond the currently visible list."
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
        "body": "Install **Node.js 22.19+**, npm, and Docker with Compose on the Linux host that will run the service. You also need a model provider account and its API key.\n\nThe API and worker run in Node. Docker runs development PostgreSQL and the agent sandboxes. Run the commands below from your project checkout. If your workspace is already running, skip to [credentials](#/docs/local-setup?section=credentials) or [Get started](#/docs/get-started)."
      },
      {
        "id": "start-services",
        "title": "1. Prepare the services",
        "body": "```sh\nnpm ci\ndocker compose up -d --wait\ndocker build -f Dockerfile.sandbox -t pi-managed-sandbox:dev .\n# Create .env only if it does not already exist.\n[ -f .env ] || cp .env.example .env\n```\n\nCompose starts development PostgreSQL on `127.0.0.1:55432`. The image provides Python and Bash for managed sessions."
      },
      {
        "id": "credentials",
        "title": "2. Configure credentials",
        "body": "Edit the local `.env` file. Set `API_KEYS` to a JSON object mapping a long, random workspace token to a workspace name. Tokens must be at least 24 characters. Set at least one model provider key.\n\n```dotenv\nAPI_KEYS={\"replace-with-a-long-random-workspace-token\":\"demo\"}\nOPENROUTER_API_KEY=your-openrouter-key\n```\n\nUse the token on the left side of `API_KEYS` to sign in to the console or authenticate API clients. Keep provider keys on the server. OpenAI and Anthropic use `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` respectively.\n\nThe `.env` file is ignored by Git. After changing credentials on a running instance, restart the API and worker. Existing console sessions need to sign in again after an API restart."
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
  }
];
