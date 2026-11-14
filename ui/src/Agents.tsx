import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Bot,
  Box,
  Code2,
  FileText,
  GitBranch,
  Play,
  Plus,
  Search,
  Terminal,
  WandSparkles,
  Monitor,
  MousePointer2,
} from "lucide-react";
import { date, navigate, shortId, useMutation, useResource } from "./client";
import {
  CopyButton,
  Empty,
  ErrorBox,
  JsonBlock,
  Loading,
  Modal,
  PageHeading,
  Status,
} from "./components";
import type {
  Agent,
  AgentConfig,
  Capabilities,
  Environment,
  Session,
  Tool,
  Version,
} from "./types";
import { SessionTable } from "./Sessions";

const toolInfo = [
  {
    id: "bash" as Tool,
    title: "Run commands",
    description: "Execute Bash and Python in the workspace.",
    icon: Terminal,
  },
  {
    id: "read_file" as Tool,
    title: "Read files",
    description: "Read text files from the session workspace.",
    icon: FileText,
  },
  {
    id: "write_file" as Tool,
    title: "Write files",
    description: "Create files and publish outputs as artifacts.",
    icon: Code2,
  },
  { id: "AX" as Tool, title: "Accessibility · HCU", description: "Find and operate named controls, windows, and menus.", icon: Monitor },
  { id: "GUI" as Tool, title: "Screen & input · HCU", description: "See screenshots, click, type, scroll, and zoom.", icon: MousePointer2 },
];
export const starterConfigs = [
  {
    name: "Workspace assistant",
    description: "Write code, run commands, and create useful files.",
    icon: Terminal,
    instructions:
      "You are a practical coding assistant. Use your workspace to write and test code. Explain your results briefly. Save deliverables under outputs/.",
    tools: ["bash", "read_file", "write_file"] as Tool[],
  },
  {
    name: "Data analyst",
    description: "Explore supplied data and turn it into clear findings.",
    icon: Box,
    instructions:
      "Analyze data supplied by the user using Python. Check your calculations and summarize the findings. Save reports under outputs/.",
    tools: ["bash", "read_file", "write_file"] as Tool[],
  },
  {
    name: "Writing partner",
    description: "Draft, refine, and keep the conversation in context.",
    icon: FileText,
    instructions:
      "Help the user write clearly. Ask for missing context when needed, and provide concise drafts and practical edits.",
    tools: [] as Tool[],
  },
  { name: "Desktop assistant", description: "Use Linux apps with vision and accessibility.", icon: Monitor,
    instructions: "You are a desktop assistant. Use HCU AX for named controls and GUI for screenshots and visual tasks. Inspect the desktop before acting, verify results, and save deliverables under /workspace/outputs.",
    tools: ["AX", "GUI"] as Tool[] },
];
export function Agents({ caps }: { caps: Capabilities }) {
  const { data, error, reload } = useResource<{ data: Agent[] }>("/v1/agents");
  const [query, setQuery] = useState("");
  const [testAgent, setTestAgent] = useState<Agent>();
  const agents = data?.data.filter((agent) =>
    `${agent.name} ${agent.latest_version.config.model} ${agent.latest_version.config.instructions}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="page">
      <PageHeading
        eyebrow="YOUR WORKSPACE"
        title="Agents"
        description="Give your agent a purpose. Test it in a persistent session."
        actions={
          <button
            className="button primary"
            onClick={() => navigate("/agents/new")}
          >
            <Plus size={17} />
            Create agent
          </button>
        }
      />
      <div className="section-toolbar">
        <div className="section-caption">
          Agent library{" "}
          <span className="count">{data?.data.length ?? "—"}</span>
        </div>
        <label className="search">
          <Search size={16} />
          <input
            aria-label="Search agents"
            placeholder="Search agents…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <ErrorBox error={error} retry={reload} />
      {!data && !error ? (
        <Loading />
      ) : (
        <div className="agent-grid">
          {agents?.map((agent, index) => (
            <article className="agent-card" key={agent.id}>
              <div className="card-top">
                <span className={`agent-avatar tone-${index % 3}`}>
                  <Bot size={23} />
                </span>
                <span className="version-chip">
                  <GitBranch size={12} />v{agent.latest_version.version}
                </span>
              </div>
              <a className="card-title" href={`#/agents/${agent.id}`}>
                {agent.name}
              </a>
              <p className="card-description">
                {agent.latest_version.config.instructions ||
                  "No instructions yet."}
              </p>
              <div
                className="model-label"
                title={agent.latest_version.config.model}
              >
                <span className="tiny-dot" />
                {agent.latest_version.config.model}
              </div>
              <div className="card-footer">
                <span>
                  {agent.session_count}{" "}
                  {agent.session_count === 1 ? "session" : "sessions"} ·{" "}
                  {agent.latest_version.config.tools.length} tools
                </span>
                <button
                  className="text-button"
                  onClick={() => setTestAgent(agent)}
                >
                  <Play size={13} />
                  Test agent
                </button>
              </div>
            </article>
          ))}
          {!query && (
            <button
              className="create-card"
              onClick={() => navigate("/agents/new")}
            >
              <span className="create-plus">
                <Plus size={22} />
              </span>
              <strong>Start with an idea</strong>
              <span>Configure a new agent your way.</span>
              <ArrowRight size={17} />
            </button>
          )}
        </div>
      )}
      {query && agents?.length === 0 && (
        <Empty icon={<Search />} title="No matching agents">
          Try a different name, model, or instruction.
        </Empty>
      )}
      <section className="starter-section">
        <div className="section-caption">
          <WandSparkles size={17} />A little inspiration
        </div>
        <p>Start with a purpose, then make it yours.</p>
        <div className="starter-grid">
          {starterConfigs.map((starter, index) => (
            <button
              className="starter-card"
              key={starter.name}
              onClick={() => navigate("/agents/new?starter=" + index)}
            >
              <starter.icon size={20} />
              <span>
                <strong>{starter.name}</strong>
                <small>{starter.description}</small>
              </span>
              <ArrowRight size={15} />
            </button>
          ))}
        </div>
      </section>
      <div className="quiet-note">
        <GitBranch size={15} />
        <span>
          Every saved version is immutable. Existing sessions keep the version
          they started with.
        </span>
      </div>
      {testAgent && (
        <StartSession
          agent={testAgent}
          caps={caps}
          close={() => setTestAgent(undefined)}
        />
      )}
    </div>
  );
}

export function StartSession({
  agent,
  caps,
  close,
  version,
}: {
  agent: Agent;
  caps: Capabilities;
  close: () => void;
  version?: Version;
}) {
  const mutate = useMutation();
  const environments = useResource<{ data: Environment[] }>(
    "/v1/environment-templates",
  );
  const details = useResource<Agent>(`/v1/agents/${agent.id}`);
  const [versionId, setVersionId] = useState(
    version?.id ?? agent.latest_version.id,
  );
  const selected =
    details.data?.versions?.find((item) => item.id === versionId) ??
    version ??
    agent.latest_version;
  const [environment, setEnvironment] = useState("");
  const needsDesktop = selected.config.tools.some(tool => tool === "AX" || tool === "GUI");
  const [newType, setNewType] = useState<Environment["type"]>(
    needsDesktop ? "desktop" : selected.config.tools.length ? "managed" : "none",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const compatible =
    environments.data?.data.filter(
      (item) => needsDesktop ? item.type === "desktop" : item.type !== "none" || selected.config.tools.length === 0,
    ) ?? [];
  const configured = caps.providers.find(
    (provider) => provider.id === selected.config.provider,
  )?.configured;
  useEffect(() => {
    setEnvironment("");
    setNewType(needsDesktop ? "desktop" : selected.config.tools.length ? "managed" : "none");
  }, [versionId]);
  const start = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      let id = environment;
      if (!id) {
        const existing = compatible.find((item) => item.type === newType);
        id =
          existing?.id ??
          (
            await mutate<Environment>("/v1/environment-templates", {
              name:
                newType === "desktop" ? "Linux desktop" : newType === "managed"
                  ? "Managed workspace"
                  : "Conversation only",
              type: newType,
            })
          ).id;
        setEnvironment(id);
      }
      const session = await mutate<Session>("/v1/sessions", {
        agent_version_id: selected.id,
        environment_template_id: id,
      });
      close();
      navigate(`/sessions/${session.id}`);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Start a test session"
      subtitle="A fresh conversation with its own context and workspace."
      close={close}
    >
      <form onSubmit={start}>
        <div className="selected-agent">
          <span className="agent-avatar">
            <Bot size={22} />
          </span>
          <div>
            <strong>{agent.name}</strong>
            <small>{selected.config.model}</small>
          </div>
        </div>
        <label className="field">
          Agent version
          <select
            value={versionId}
            onChange={(event) => setVersionId(event.target.value)}
          >
            {(details.data?.versions ?? [selected]).map((item) => (
              <option key={item.id} value={item.id}>
                Version {item.version}
                {item.id === agent.latest_version.id ? " · latest" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Environment
          <select
            value={environment}
            onChange={(event) => setEnvironment(event.target.value)}
          >
            <option value="">Choose a workspace type</option>
            {compatible.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name} ·{" "}
                {item.type === "desktop" ? "Linux desktop" : item.type === "managed" ? "Managed sandbox" : "No sandbox"}
              </option>
            ))}
          </select>
        </label>
        {!environment && (
          <div className="choice-grid">
            <label className={`choice ${newType === "desktop" ? "selected" : ""} ${!caps.desktop.configured ? "disabled" : ""}`}>
              <input type="radio" name="workspace" checked={newType === "desktop"} disabled={!caps.desktop.configured} onChange={() => setNewType("desktop")} />
              <Monitor size={21} /><strong>Linux desktop</strong><small>{caps.desktop.configured ? "A private VM with persistent apps, HCU, and a live preview." : "Configure a desktop host to enable this environment."}</small>
            </label>
            <label
              className={`choice ${newType === "managed" ? "selected" : ""}`}
            >
              <input
                type="radio"
                name="workspace"
                disabled={needsDesktop}
                checked={newType === "managed"}
                onChange={() => setNewType("managed")}
              />
              <Terminal size={21} />
              <strong>Managed sandbox</strong>
              <small>
                Files, Bash, and Python. An isolated workspace that persists
                across runs.
              </small>
            </label>
            <label
              className={`choice ${newType === "none" ? "selected" : ""} ${selected.config.tools.length ? "disabled" : ""}`}
            >
              <input
                type="radio"
                name="workspace"
                disabled={!!selected.config.tools.length}
                checked={newType === "none"}
                onChange={() => setNewType("none")}
              />
              <Bot size={21} />
              <strong>Conversation only</strong>
              <small>
                {selected.config.tools.length
                  ? "This version has tools and needs a sandbox."
                  : "Conversation memory without shell or file access."}
              </small>
            </label>
          </div>
        )}
        <p className="field-hint">
          Sessions pin the selected version and environment. Send a message
          after creating the session to call the model.
        </p>
        {!configured && (
          <ErrorBox
            error={`Configure ${selected.config.provider.toUpperCase()}_API_KEY on the server before testing this model.`}
          />
        )}
        <ErrorBox error={error || environments.error || details.error} />
        <div className="modal-footer">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || !configured || !environments.data || (needsDesktop && !caps.desktop.configured)}
          >
            <Play size={15} />
            {busy ? "Starting…" : "Start session"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function AgentEditor({
  id,
  starter,
  caps,
}: {
  id: string;
  starter: number;
  caps: Capabilities;
}) {
  const mutate = useMutation();
  const isNew = id === "new";
  const resource = useResource<Agent>(
    isNew ? "/v1/agents" : `/v1/agents/${id}`,
  );
  const defaultProvider =
    caps.providers.find((item) => item.configured)?.id ?? "openrouter";
  const preset = starterConfigs[starter];
  const [name, setName] = useState(preset?.name ?? "");
  const [config, setConfig] = useState<AgentConfig>({
    provider: defaultProvider,
    model:
      defaultProvider === "openrouter"
        ? (preset?.name === "Desktop assistant" ? "deepseek/deepseek-v4.1-flash-1017" : "openai/gpt-4.1-mini")
        : defaultProvider === "openai"
          ? "gpt-4.1-mini"
          : "claude-sonnet-4-5",
    instructions: preset?.instructions ?? "",
    tools: preset?.tools ?? [],
  });
  const [tab, setTab] = useState("configure");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [test, setTest] = useState(false);
  const latest = resource.data?.versions?.at(-1);
  const [viewVersion, setViewVersion] = useState<Version>();
  useEffect(() => {
    if (!isNew && latest) {
      setName(resource.data!.name);
      setConfig(latest.config);
    }
  }, [latest?.id]);
  const dirty =
    isNew ||
    (latest && JSON.stringify(config) !== JSON.stringify(latest.config));
  useEffect(() => {
    if (!dirty) return;
    const stop = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", stop);
    return () => window.removeEventListener("beforeunload", stop);
  }, [dirty]);
  const provider = caps.providers.find((item) => item.id === config.provider)!;
  const models = provider.models;
  const validModel = models.some((item) => item.id === config.model);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved("");
    try {
      if (isNew) {
        const agent = await mutate<Agent>("/v1/agents", {
          name: name.trim(),
          config,
        });
        navigate(`/agents/${agent.id}`);
      } else {
        const version = await mutate<Version>(
          `/v1/agents/${id}/versions`,
          config,
        );
        resource.reload();
        setSaved(`Version ${version.version} saved`);
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!isNew && !resource.data)
    return (
      <div className="page">
        <ErrorBox error={resource.error} retry={resource.reload} />
        {!resource.error && <Loading />}
      </div>
    );
  return (
    <div className="page">
      <PageHeading
        eyebrow={
          isNew ? "NEW AGENT" : `AGENT · VERSION ${latest?.version ?? ""}`
        }
        title={isNew ? "Make it your own" : name}
        description={
          isNew
            ? "Define what it does, which model it uses, and how it works."
            : "Reusable instructions. Versioned configuration. Persistent sessions."
        }
        actions={
          !isNew && (
            <button className="button primary" onClick={() => setTest(true)}>
              <Play size={15} />
              Test agent
            </button>
          )
        }
      />
      {!isNew && (
        <div className="tabs">
          <button
            className={tab === "configure" ? "active" : ""}
            onClick={() => setTab("configure")}
          >
            Configuration
          </button>
          <button
            className={tab === "versions" ? "active" : ""}
            onClick={() => setTab("versions")}
          >
            Versions <span>{resource.data?.versions?.length}</span>
          </button>
          <button
            className={tab === "sessions" ? "active" : ""}
            onClick={() => setTab("sessions")}
          >
            Sessions
          </button>
        </div>
      )}
      {tab === "configure" && (
        <div className="editor-grid">
          <form className="panel editor-form" onSubmit={submit}>
            <div className="panel-title">
              <span className="small-icon">
                <Bot size={18} />
              </span>
              <div>
                <h2>Agent definition</h2>
                <p>Set the direction. Pi handles the loop.</p>
              </div>
            </div>
            <label className="field">
              Name
              <input
                required
                maxLength={200}
                disabled={!isNew}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Workspace assistant"
              />
            </label>
            <label className="field">
              Instructions
              <textarea
                required
                rows={8}
                maxLength={32768}
                value={config.instructions}
                onChange={(event) =>
                  setConfig({ ...config, instructions: event.target.value })
                }
                placeholder="Describe the agent's purpose, how it should work, and what a good result looks like…"
              />
            </label>
            <div className="field-divider" />
            <h3>Model</h3>
            <div className="field-row">
              <label className="field">
                Provider
                <select
                  value={config.provider}
                  onChange={(event) => {
                    const provider = event.target
                      .value as AgentConfig["provider"];
                    setConfig({
                      ...config,
                      provider,
                      model:
                        provider === "openrouter"
                          ? "openai/gpt-4.1-mini"
                          : provider === "openai"
                            ? "gpt-4.1-mini"
                            : "claude-sonnet-4-5",
                    });
                  }}
                >
                  {caps.providers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id === "openrouter"
                        ? "OpenRouter"
                        : item.id === "openai"
                          ? "OpenAI"
                          : "Anthropic"}
                      {item.configured ? "" : " · not configured"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Model ID
                <input
                  required
                  list="model-catalog"
                  value={config.model}
                  onChange={(event) =>
                    setConfig({ ...config, model: event.target.value })
                  }
                />
                <datalist id="model-catalog">
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </datalist>
              </label>
            </div>
            <p className="field-hint">
              {validModel
                ? `${models.find((model) => model.id === config.model)!.context_window.toLocaleString()} token context · ${models.find((model) => model.id === config.model)!.input.includes("image") ? "Vision supported" : "Text only"}`
                : "Choose a model ID from the installed Pi catalog."}
            </p>
            <div className="field-divider" />
            <h3>
              Workspace tools <span className="subtle">Optional</span>
            </h3>
            <p className="field-hint">
              Commands and files work in Docker or a desktop VM. HCU tools require a Linux desktop and a model with image input.
            </p>
            <div className="tool-options">
              {toolInfo.map((tool) => (
                <label key={tool.id} className="tool-option">
                  <tool.icon size={19} />
                  <span>
                    <strong>{tool.title}</strong>
                    <small>{tool.description}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={config.tools.includes(tool.id)}
                    onChange={(event) =>
                      setConfig({
                        ...config,
                        tools: event.target.checked
                          ? [...config.tools, tool.id]
                          : config.tools.filter((item) => item !== tool.id),
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <ErrorBox error={error} />
            {saved && (
              <p className="success-note" role="status">
                {saved}
              </p>
            )}
            <div className="form-footer">
              <span>
                {isNew
                  ? "Creates version 1"
                  : dirty
                    ? "Unsaved changes"
                    : `Version ${latest?.version} · saved`}
              </span>
              <button
                className="button primary"
                disabled={busy || !dirty || !validModel || !name.trim()}
              >
                <GitBranch size={15} />
                {busy ? "Saving…" : isNew ? "Create agent" : "Save new version"}
              </button>
            </div>
          </form>
          <aside className="editor-aside">
            <div className="test-panel">
              <div className="test-illustration">
                <Bot size={36} />
                <span>
                  <Play size={15} />
                </span>
              </div>
              <div className="eyebrow">FROM CONFIG TO CONVERSATION</div>
              <h2>See your agent in action</h2>
              <p>
                Start a session, send a task, and follow every run and tool call
                as it happens.
              </p>
              <ol>
                <li>Choose an agent version</li>
                <li>Pick a workspace</li>
                <li>Send a task and inspect the results</li>
              </ol>
              <button
                className="button full"
                disabled={isNew}
                onClick={() => setTest(true)}
              >
                <Play size={15} />
                Test saved version
              </button>
              {isNew && <small>Save your agent to start testing.</small>}
              {!isNew && dirty && (
                <small>Save your changes to test a new version.</small>
              )}
            </div>
            {!isNew && (
              <div className="id-line">
                <span>{shortId(id)}</span>
                <CopyButton value={id} label="Copy agent ID" />
              </div>
            )}
            <details className="config-details">
              <summary>View API configuration</summary>
              <JsonBlock
                value={isNew ? { name, config } : config}
                label="Request body"
              />
            </details>
          </aside>
        </div>
      )}
      {tab === "versions" && (
        <div className="panel versions-panel">
          <div className="panel-title">
            <GitBranch size={20} />
            <div>
              <h2>Version history</h2>
              <p>
                Inspect any saved definition. Sessions always keep their pinned
                version.
              </p>
            </div>
          </div>
          {[...(resource.data?.versions ?? [])].reverse().map((version) => (
            <div className="version-row" key={version.id}>
              <span className="version-dot">
                <GitBranch size={17} />
              </span>
              <div>
                <strong>
                  Version {version.version}{" "}
                  {version.id === latest?.id && (
                    <span className="pill">Latest</span>
                  )}
                </strong>
                <small>
                  {version.config.model} · {version.config.tools.length} tools ·{" "}
                  {date(version.created_at)}
                </small>
              </div>
              <button
                className="button small"
                onClick={() => setViewVersion(version)}
              >
                Inspect
              </button>
              <button
                className="button small"
                onClick={() => {
                  setViewVersion(version);
                  setTest(true);
                }}
              >
                <Play size={13} />
                Test
              </button>
            </div>
          ))}
        </div>
      )}
      {tab === "sessions" && (
        <AgentSessions id={id} onStart={() => setTest(true)} />
      )}
      {viewVersion && !test && (
        <Modal
          title={`Version ${viewVersion.version}`}
          subtitle={date(viewVersion.created_at)}
          close={() => setViewVersion(undefined)}
        >
          <JsonBlock value={viewVersion.config} label="Saved configuration" />
          <div className="modal-footer">
            <button className="button primary" onClick={() => setTest(true)}>
              <Play size={15} />
              Test this version
            </button>
          </div>
        </Modal>
      )}
      {test && resource.data && latest && (
        <StartSession
          caps={caps}
          agent={{ ...resource.data, latest_version: latest }}
          version={viewVersion}
          close={() => {
            setTest(false);
            setViewVersion(undefined);
          }}
        />
      )}
    </div>
  );
}
function AgentSessions({ id, onStart }: { id: string; onStart: () => void }) {
  const resource = useResource<{ data: Session[] }>("/v1/sessions");
  return (
    <>
      <ErrorBox error={resource.error} retry={resource.reload} />
      {resource.data ? (
        <SessionTable
          sessions={resource.data.data.filter(
            (session) => session.agent_id === id,
          )}
          onStart={onStart}
        />
      ) : (
        !resource.error && <Loading />
      )}
    </>
  );
}
