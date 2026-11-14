import { DesktopPanel, ScreenshotEvidence } from "./Desktop";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Markdown from "react-markdown";
import {
  Activity,
  Archive,
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  File,
  FileText,
  FolderOpen,
  GitBranch,
  ListFilter,
  MessageSquare,
  Play,
  Plus,
  Search,
  Square,
  Terminal,
  UserRound,
  X,
} from "lucide-react";
import {
  allEvents,
  allRuns,
  api,
  date,
  download,
  duration,
  navigate,
  pending,
  shortId,
  useResource,
  watchEvents,
} from "./client";
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
import { StartSession } from "./Agents";
import type {
  Agent,
  Artifact,
  Capabilities,
  Event,
  Run,
  Session,
} from "./types";

export function Sessions({ caps }: { caps: Capabilities }) {
  const resource = useResource<{ data: Session[] }>("/v1/sessions");
  const agents = useResource<{ data: Agent[] }>("/v1/agents");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [choose, setChoose] = useState(false);
  const [agent, setAgent] = useState<Agent>();
  const sessions =
    resource.data?.data.filter(
      (session) =>
        `${session.id} ${session.agent_name} ${session.latest_run?.input ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (filter === "all" ||
          (filter === "pending"
            ? session.pending_runs > 0
            : filter === "failed"
              ? session.latest_run?.status === "failed"
              : session.status === filter)),
    ) ?? [];
  return (
    <div className="page">
      <PageHeading
        eyebrow="TEST & OBSERVE"
        title="Sessions"
        description="Every conversation, workspace, and run. Pick up where you left off."
        actions={
          <button className="button primary" onClick={() => setChoose(true)}>
            <Plus size={16} />
            New session
          </button>
        }
      />
      <div className="section-toolbar">
        <div className="filter-buttons">
          {[
            ["all", "All sessions"],
            ["pending", "In progress"],
            ["failed", "Failed"],
            ["archived", "Archived"],
          ].map(([value, label]) => (
            <button
              className={filter === value ? "selected" : ""}
              key={value}
              onClick={() => setFilter(value!)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="search">
          <Search size={16} />
          <input
            aria-label="Search sessions"
            placeholder="Search sessions…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <ErrorBox error={resource.error} retry={resource.reload} />
      {resource.data ? (
        <SessionTable
          sessions={sessions}
          onStart={() => setChoose(true)}
          filtered={!!query || filter !== "all"}
        />
      ) : (
        !resource.error && <Loading />
      )}
      <p className="field-hint table-footnote">
        Showing up to 100 recent sessions. Open a session to inspect its
        complete run history and logs.
      </p>
      {choose && (
        <Modal
          title="Choose an agent"
          subtitle="Start a fresh session with one of your saved agents."
          close={() => setChoose(false)}
        >
          <ErrorBox error={agents.error} retry={agents.reload} />
          {agents.data?.data.length === 0 && (
            <Empty
              icon={<Bot />}
              title="Create your first agent"
              action={
                <button
                  className="button primary"
                  onClick={() => navigate("/agents/new")}
                >
                  Create agent
                </button>
              }
            >
              An agent defines the model, instructions, and tools for a session.
            </Empty>
          )}
          {agents.data?.data.map((item) => (
            <button
              className="agent-picker"
              key={item.id}
              onClick={() => {
                setChoose(false);
                setAgent(item);
              }}
            >
              <span className="agent-avatar">
                <Bot size={20} />
              </span>
              <span>
                <strong>{item.name}</strong>
                <small>{item.latest_version.config.model}</small>
              </span>
              <ChevronRight size={18} />
            </button>
          ))}
        </Modal>
      )}
      {agent && (
        <StartSession
          agent={agent}
          caps={caps}
          close={() => setAgent(undefined)}
        />
      )}
    </div>
  );
}
export function SessionTable({
  sessions,
  onStart,
  filtered = false,
}: {
  sessions: Session[];
  onStart: () => void;
  filtered?: boolean;
}) {
  if (!sessions.length)
    return (
      <div className="panel">
        <Empty
          icon={<MessageSquare size={29} />}
          title={
            filtered ? "No matching sessions" : "A new conversation starts here"
          }
          action={
            !filtered && (
              <button className="button" onClick={onStart}>
                <Play size={15} />
                Start a session
              </button>
            )
          }
        >
          {filtered
            ? "Try another search or status filter."
            : "Test an agent, inspect its work, and continue the conversation whenever you need."}
        </Empty>
      </div>
    );
  return (
    <div className="panel table-wrap">
      <table className="session-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Agent / version</th>
            <th>Status</th>
            <th>Workspace</th>
            <th>Created</th>
            <th>
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id}>
              <td>
                <a href={`#/sessions/${session.id}`}>
                  <strong>
                    {session.latest_run?.input || "Untitled session"}
                  </strong>
                  <small>
                    {shortId(session.id)}{" "}
                    <span>· {session.run_count} runs</span>
                  </small>
                </a>
              </td>
              <td>
                <span>{session.agent_name}</span>
                <small>Version {session.agent_version}</small>
              </td>
              <td>
                <Status
                  value={
                    session.status === "archived"
                      ? "archived"
                      : (session.latest_run?.status ?? "ready")
                  }
                />
                {session.pending_runs > 0 && (
                  <small>{session.pending_runs} pending</small>
                )}
              </td>
              <td>
                <span>
                  {session.environment_type === "managed"
                    ? "Managed sandbox"
                    : "Conversation"}
                </span>
              </td>
              <td className="nowrap subtle">{date(session.created_at)}</td>
              <td>
                <a
                  className="icon-button"
                  href={`#/sessions/${session.id}`}
                  aria-label={`Open session ${session.id}`}
                >
                  <ArrowRight size={16} />
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useSession(id: string) {
  const [data, setData] = useState<{
    session: Session;
    runs: Run[];
    artifacts: Artifact[];
  }>();
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<
    "live" | "connecting" | "reconnecting"
  >("connecting");
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let fetching = false;
    let requested = false;
    let timer: ReturnType<typeof setTimeout>;
    setData(undefined);
    setEvents([]);
    setError("");
    setConnection("connecting");
    const refresh = async () => {
      if (fetching) {
        requested = true;
        return;
      }
      fetching = true;
      try {
        const [session, runs, artifacts] = await Promise.all([
          api<Session>(`/v1/sessions/${id}`),
          allRuns(id),
          api<{ data: Artifact[] }>(`/v1/sessions/${id}/artifacts`),
        ]);
        if (active) {
          setData({ session, runs, artifacts: artifacts.data });
          setError("");
        }
      } catch (error) {
        if (active) setError((error as Error).message);
      } finally {
        fetching = false;
        if (active && requested) {
          requested = false;
          void refresh();
        }
      }
    };
    refreshRef.current = () => {
      void refresh();
    };
    void refresh();
    void watchEvents(
      id,
      controller.signal,
      (event) => {
        if (!active) return;
        setEvents((previous) =>
          previous.some((item) => item.seq === event.seq)
            ? previous
            : [...previous, event],
        );
        clearTimeout(timer);
        timer = setTimeout(() => {
          void refresh();
        }, 100);
      },
      (status) => {
        if (active) setConnection(status);
      },
    );
    const interval = setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [id]);
  return {
    data,
    events,
    error,
    connection,
    refresh: () => refreshRef.current(),
  };
}

export function SessionWorkspace({ id }: { id: string }) {
  const { data, events, error, connection, refresh } = useSession(id);
  const [tab, setTab] = useState("runs");
  useEffect(() => { setTab(data?.session.environment_type === "desktop" ? "desktop" : "runs"); }, [data?.session.id]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [selected, setSelected] = useState<string>("all");
  const [event, setEvent] = useState<Event>();
  const [archive, setArchive] = useState(false);
  const [preview, setPreview] = useState<{
    artifact: Artifact;
    text: string;
  }>();
  const [actionRun, setActionRun] = useState("");
  const [exporting, setExporting] = useState(false);
  const [sendKey, setSendKey] = useState(crypto.randomUUID());
  const bottom = useRef<HTMLDivElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  useEffect(() => {
    if (stickToBottom.current)
      bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [data?.runs.length, data?.runs.at(-1)?.status, events.length]);
  const send = async (text: string, key: string) => {
    setBusy(true);
    setActionError("");
    try {
      await api(
        `/v1/sessions/${id}/runs`,
        { input: text, when_busy: "queue" },
        key,
      );
      setInput((previous) => (previous.trim() === text ? "" : previous));
      setSendKey(crypto.randomUUID());
      stickToBottom.current = true;
      refresh();
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const runAction = async (run: Run, action: "cancel" | "resume") => {
    setActionRun(run.id);
    setActionError("");
    try {
      await api(`/v1/sessions/${id}/runs/${run.id}/${action}`, {});
      refresh();
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setActionRun("");
    }
  };
  const archiveSession = async () => {
    setBusy(true);
    setActionError("");
    try {
      await api(`/v1/sessions/${id}/archive`, {});
      setArchive(false);
      refresh();
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const openArtifact = async (artifact: Artifact, downloadFile: boolean) => {
    setActionError("");
    try {
      const response = await fetch(artifact.download_url, {
        credentials: "same-origin",
      });
      if (!response.ok)
        throw new Error(
          "Could not load this artifact. Sign in again if your session expired.",
        );
      const blob = await response.blob();
      if (downloadFile) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = artifact.path.split("/").at(-1)!;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else setPreview({ artifact, text: await blob.text() });
    } catch (error) {
      setActionError((error as Error).message);
    }
  };
  if (!data)
    return (
      <div className="page">
        <ErrorBox error={error} retry={refresh} />
        {!error && <Loading />}
      </div>
    );
  const { session, runs, artifacts } = data;
  const inProgress = runs.filter((run) => pending(run.status));
  const knownUsage = runs.filter((run) => run.usage);
  const tokens = knownUsage.reduce(
    (sum, run) => sum + (run.usage!.tokens.total ?? 0),
    0,
  );
  const tools = events.filter((item) => item.type === "tool.requested");
  const visibleRuns =
    selected === "all" ? runs : runs.filter((run) => run.id === selected);
  const visibleEvents =
    selected === "all"
      ? events
      : events.filter((item) => item.run_id === selected);
  const exportLogs = async () => {
    setExporting(true);
    setActionError("");
    try {
      const [snapshot, history, log, files] = await Promise.all([
        api<Session>(`/v1/sessions/${id}`),
        allRuns(id),
        allEvents(id),
        api<{ data: Artifact[] }>(`/v1/sessions/${id}/artifacts`),
      ]);
      download(`pi-session-${id}.json`, {
        exported_at: new Date().toISOString(),
        session: snapshot,
        runs: history,
        events: log,
        artifacts: files.data,
      });
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setExporting(false);
    }
  };
  return (
    <div className="workspace-page">
      <header className="workspace-heading">
        <div>
          <a className="back-link" href="#/sessions">
            Sessions <ChevronRight size={13} />
          </a>
          <div className="workspace-title">
            <span className="agent-avatar small">
              <Bot size={20} />
            </span>
            <h1>{session.agent_name}</h1>
            <Status
              value={
                session.status === "archived"
                  ? "archived"
                  : (inProgress[0]?.status ?? "ready")
              }
            />
          </div>
          <div className="session-id">
            <span>{shortId(id)}</span>
            <CopyButton value={id} label="Copy session ID" />
            <span className="separator">/</span>
            <a href={`#/agents/${session.agent_id}`}>
              Version {session.agent_version}
            </a>
          </div>
        </div>
        <div className="heading-actions">
          <button
            className="button"
            onClick={() => {
              void exportLogs();
            }}
            disabled={exporting}
          >
            <ArrowDownToLine size={15} />
            {exporting ? "Exporting…" : "Export logs"}
          </button>
          {session.status !== "archived" && (
            <button
              className="icon-button outlined"
              aria-label="Archive session"
              title="Archive session"
              disabled={!!inProgress.length}
              onClick={() => setArchive(true)}
            >
              <Archive size={17} />
            </button>
          )}
        </div>
      </header>
      <div className="session-summary">
        <div>
          <span className="summary-icon">
            <GitBranch size={16} />
          </span>
          <span>
            <small>Model</small>
            <strong>{session.config.model}</strong>
          </span>
        </div>
        <div>
          <span className="summary-icon">
            <Terminal size={16} />
          </span>
          <span>
            <small>Environment</small>
            <strong>{session.environment_name}</strong>
          </span>
        </div>
        <div>
          <span>
            <small>Runs</small>
            <strong>
              {runs.length}{" "}
              <em>
                / {runs.filter((run) => run.status === "completed").length}{" "}
                completed
              </em>
            </strong>
          </span>
        </div>
        <div>
          <span>
            <small>Tool calls</small>
            <strong>{tools.length}</strong>
          </span>
        </div>
        <div title="Usage reported by Pi for completed runs. Interrupted usage may be unknown.">
          <span>
            <small>Reported tokens</small>
            <strong>
              {tokens.toLocaleString()}{" "}
              <em>
                {runs.some(
                  (run) =>
                    ["failed", "cancelled", "waiting"].includes(run.status) &&
                    !run.usage,
                )
                  ? "+ unknown"
                  : ""}
              </em>
            </strong>
          </span>
        </div>
      </div>
      <ErrorBox
        error={actionError || error}
        retry={error ? refresh : undefined}
      />
      <div className={`playground ${session.environment_type === "desktop" ? "desktop-playground" : ""}`}>
        <section className="conversation-panel" aria-label="Conversation">
          <div className="pane-heading">
            <h2>
              <MessageSquare size={16} />
              Playground
            </h2>
            <span className="subtle">
              {session.environment_type === "desktop" ? "Persistent Linux desktop" : session.environment_type === "managed"
                ? "Persistent workspace"
                : "Conversation only"}
            </span>
          </div>
          <div
            className="conversation"
            ref={conversation}
            onScroll={() => {
              const element = conversation.current!;
              stickToBottom.current =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                100;
            }}
          >
            {!runs.length && (
              <div className="conversation-welcome">
                <div className="welcome-orbit">
                  <Bot size={35} />
                  <span />
                </div>
                <h2>What should we try?</h2>
                <p>
                  Give {session.agent_name} a task.
                  <br />
                  Watch its work unfold in the inspector.
                </p>
                <div className="prompt-suggestions">
                  {(session.environment_type === "desktop" ? ["Take a screenshot, list the open applications, and describe what you see.", "Open the text editor, type a short welcome note, and save it as /workspace/outputs/welcome.txt. Verify the result on screen."] : session.config.tools.length
                    ? [
                        "Create a short welcome note in outputs/welcome.txt and verify its contents.",
                        "Use Python to calculate the first 10 Fibonacci numbers.",
                      ]
                    : [
                        "Introduce yourself and explain how you can help.",
                        "Help me turn an idea into a clear, practical plan.",
                      ]
                  ).map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => {
                        setInput(prompt);
                        setSendKey(crypto.randomUUID());
                      }}
                    >
                      {prompt}
                      <ArrowUp size={14} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {runs.map((run, index) => (
              <article className="conversation-turn" key={run.id}>
                <div className="turn-divider">
                  <span>RUN {index + 1}</span>
                  <span>{date(run.created_at)}</span>
                </div>
                <div className="message user-message">
                  <span className="message-avatar">
                    <UserRound size={15} />
                  </span>
                  <div>
                    <strong>You</strong>
                    <div className="message-text">{run.input}</div>
                  </div>
                </div>
                <div className="message assistant-message">
                  <span className="message-avatar pi-avatar">π</span>
                  <div>
                    <strong>{session.agent_name}</strong>
                    {!!events.filter(
                      (item) =>
                        item.run_id === run.id &&
                        item.type === "tool.requested",
                    ).length && (
                      <button
                        className="tool-summary"
                        onClick={() => {
                          setSelected(run.id);
                          setTab("runs");
                        }}
                      >
                        <Terminal size={14} />
                        {
                          events.filter(
                            (item) =>
                              item.run_id === run.id &&
                              item.type === "tool.requested",
                          ).length
                        }{" "}
                        tool calls
                        <ChevronRight size={13} />
                      </button>
                    )}
                    {run.output_text && (
                      <div className="message-text markdown">
                        <Markdown
                          skipHtml
                          components={{
                            img: ({ alt }) => <span>{alt || "Image"}</span>,
                            a: ({ href, children }) => (
                              <a href={href} target="_blank" rel="noreferrer">
                                {children}
                              </a>
                            ),
                          }}
                        >
                          {run.output_text}
                        </Markdown>
                      </div>
                    )}
                    {pending(run.status) && (
                      <div className="run-progress">
                        <span
                          className={
                            run.status === "running" ? "pulse-dot" : "tiny-dot"
                          }
                        />
                        {run.status === "running"
                          ? "Working on your task…"
                          : run.status === "queued"
                            ? "Queued for execution…"
                            : run.status === "cancelling"
                              ? "Stopping the run…"
                              : "Recovery needs your attention."}
                      </div>
                    )}
                    {run.status === "failed" && (
                      <div className="message-error">
                        <strong>Run failed</strong>
                        <p>
                          {run.error?.message ?? "The run could not complete."}
                        </p>
                        <button
                          className="text-button"
                          disabled={busy || session.status === "archived"}
                          onClick={() => {
                            void send(run.input, crypto.randomUUID());
                          }}
                        >
                          Retry as a new run <ArrowRight size={13} />
                        </button>
                      </div>
                    )}
                    {run.status === "cancelled" && (
                      <p className="subtle">This run was cancelled.</p>
                    )}
                    {run.status === "waiting" && (
                      <p className="field-hint">
                        {run.error?.message} Resume is available only if no
                        tools have run; otherwise cancel and reconcile the
                        workspace before continuing.
                      </p>
                    )}
                    <div className="message-meta">
                      <Status value={run.status} />
                      {run.ended_at && (
                        <span>{duration(run.started_at, run.ended_at)}</span>
                      )}
                      {run.usage && (
                        <span>
                          {run.usage.tokens.total?.toLocaleString()} tokens
                        </span>
                      )}
                      {run.status === "waiting" &&
                        !events.some(
                          (item) =>
                            item.run_id === run.id &&
                            item.type === "tool.requested",
                        ) && (
                          <button
                            className="text-button"
                            disabled={actionRun === run.id}
                            onClick={() => {
                              void runAction(run, "resume");
                            }}
                          >
                            <Play size={12} />
                            Resume
                          </button>
                        )}
                      {pending(run.status) && run.status !== "cancelling" && (
                        <button
                          className="text-button"
                          disabled={actionRun === run.id}
                          onClick={() => {
                            void runAction(run, "cancel");
                          }}
                        >
                          <Square size={11} />
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </article>
            ))}
            <div ref={bottom} />
          </div>
          <form
            className="composer-area"
            onSubmit={(event) => {
              event.preventDefault();
              if (input.trim() && !busy) void send(input.trim(), sendKey);
            }}
          >
            <div className="composer">
              <textarea
                aria-label="Message the agent"
                placeholder={
                  session.status === "archived"
                    ? "This session is archived"
                    : "Give your agent a task…"
                }
                disabled={session.status === "archived"}
                value={input}
                maxLength={65536}
                onChange={(event) => {
                  setInput(event.target.value);
                  setSendKey(crypto.randomUUID());
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    if (input.trim() && !busy && session.status !== "archived")
                      void send(input.trim(), sendKey);
                  }
                }}
              />
              <div className="composer-bottom">
                <span>
                  <span className="tiny-dot" />
                  {session.config.provider}
                </span>
                <button
                  className="send-button"
                  aria-label={
                    inProgress.length ? "Queue message" : "Send message"
                  }
                  disabled={
                    busy || !input.trim() || session.status === "archived"
                  }
                >
                  <ArrowUp size={19} />
                </button>
              </div>
            </div>
            <small>
              {session.status === "archived"
                ? "History and artifacts are preserved. The workspace has been released."
                : inProgress.length
                  ? "New messages are queued behind the current run."
                  : "Enter to send · Shift + Enter for a new line"}
            </small>
          </form>
        </section>
        <section className="inspector-panel" aria-label="Session inspector">
          <div className="pane-heading">
            <h2>
              <Activity size={16} />
              Inspector
            </h2>
            <span className={`stream-status ${connection}`}>
              <span />
              {connection === "live"
                ? "Live events"
                : connection === "connecting"
                  ? "Connecting…"
                  : "Reconnecting…"}
            </span>
          </div>
          <div className="inspector-tabs">
            {[
              ...(session.environment_type === "desktop" ? [["desktop", "Desktop", ""]] : []),
              ["runs", "Runs", runs.length],
              ["events", "Event log", events.length],
              ["artifacts", "Artifacts", artifacts.length],
            ].map(([value, label, count]) => (
              <button
                key={value}
                className={tab === value ? "active" : ""}
                onClick={() => setTab(String(value))}
              >
                {label}
                <span>{count}</span>
              </button>
            ))}
          </div>
          {tab !== "artifacts" && tab !== "desktop" && (
            <div className="inspector-toolbar">
              <ListFilter size={14} />
              <select
                aria-label="Filter inspector by run"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                <option value="all">All runs</option>
                {runs.map((run, index) => (
                  <option value={run.id} key={run.id}>
                    Run {index + 1} · {run.status}
                  </option>
                ))}
              </select>
              <span>
                {events.length
                  ? `seq ${events.at(-1)!.seq}`
                  : "Waiting for events"}
              </span>
            </div>
          )}
          <div className="inspector-body">
            {tab === "desktop" && <DesktopPanel session={session} events={events} />}
            {tab === "runs" && (
              <>
                {visibleRuns.length === 0 ? (
                  <Empty
                    icon={<Activity size={24} />}
                    title="A clear view of every step"
                  >
                    Runs, tool calls, and results will appear here when you send
                    a task.
                  </Empty>
                ) : (
                  [...visibleRuns]
                    .reverse()
                    .map((run) => (
                      <RunTrace
                        key={run.id}
                        run={run}
                        index={runs.findIndex((item) => item.id === run.id) + 1}
                        events={events.filter((item) => item.run_id === run.id)}
                        inspect={setEvent}
                      />
                    ))
                )}
              </>
            )}
            {tab === "events" && (
              <EventLog events={visibleEvents} inspect={setEvent} />
            )}
            {tab === "artifacts" && (
              <>
                {artifacts.length === 0 ? (
                  <Empty
                    icon={<FolderOpen size={25} />}
                    title="Your agent’s deliverables"
                  >
                    Files saved under outputs/ are published here after a
                    successful run.
                  </Empty>
                ) : (
                  <div className="artifacts-list">
                    <p className="field-hint">
                      Immutable outputs from completed runs.
                    </p>
                    {artifacts.map((artifact) => (
                      <div className="artifact-card" key={artifact.id}>
                        <span className="file-icon">
                          <FileText size={22} />
                        </span>
                        <div>
                          <strong>{artifact.path.split("/").at(-1)}</strong>
                          <small>
                            {(Number(artifact.size) / 1024).toFixed(1)} KB · Run{" "}
                            {runs.findIndex(
                              (run) => run.id === artifact.run_id,
                            ) + 1}
                          </small>
                          <code>{artifact.path}</code>
                          <div className="artifact-actions">
                            {Number(artifact.size) <= 262144 &&
                              /\.(txt|md|json|csv|py|js|ts|html|css|sh|yaml|yml|log|svg)$/i.test(
                                artifact.path,
                              ) && (
                                <button
                                  className="text-button"
                                  onClick={() => {
                                    void openArtifact(artifact, false);
                                  }}
                                >
                                  Preview
                                </button>
                              )}
                            <button
                              className="text-button"
                              onClick={() => {
                                void openArtifact(artifact, true);
                              }}
                            >
                              <ArrowDownToLine size={13} />
                              Download
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="inspector-footer">
            <span className="tiny-dot" />
            Persisted events · reconnects from the last sequence
          </div>
        </section>
      </div>
      {event && (
        <Modal
          title={event.type}
          subtitle={`Sequence ${event.seq} · ${date(event.created_at)}`}
          close={() => setEvent(undefined)}
        >
          <div className="event-identifiers">
            <span>Event ID</span>
            <code>{event.id}</code>
            <CopyButton value={event.id} />
          </div>
          <ScreenshotEvidence event={event} />
          <JsonBlock value={event.data} label="Event payload" />
          <details className="config-details">
            <summary>Full event JSON</summary>
            <JsonBlock value={event} />
          </details>
        </Modal>
      )}
      {preview && (
        <Modal
          title={preview.artifact.path}
          subtitle={`${preview.artifact.size} bytes · Immutable artifact`}
          close={() => setPreview(undefined)}
        >
          <pre className="artifact-preview">{preview.text}</pre>
          <div className="modal-footer">
            <button
              className="button"
              onClick={() => {
                void openArtifact(preview.artifact, true);
              }}
            >
              <ArrowDownToLine size={15} />
              Download
            </button>
          </div>
        </Modal>
      )}
      {archive && (
        <Modal
          title="Archive this session?"
          subtitle="Conversation history, event logs, and published artifacts are kept."
          close={() => setArchive(false)}
        >
          <p className="archive-explanation">
            Archiving permanently releases this session’s sandbox files and
            prevents new runs. Download any artifacts you need first.
          </p>
          <ErrorBox error={actionError} />
          <div className="modal-footer">
            <button className="button" onClick={() => setArchive(false)}>
              Keep session
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => {
                void archiveSession();
              }}
            >
              Archive and release workspace
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RunTrace({
  run,
  index,
  events,
  inspect,
}: {
  run: Run;
  index: number;
  events: Event[];
  inspect: (event: Event) => void;
}) {
  const requests = events.filter((event) => event.type === "tool.requested");
  const totalTime = Math.max(
    1,
    new Date(run.ended_at ?? Date.now()).getTime() -
      new Date(run.started_at ?? run.created_at).getTime(),
  );
  return (
    <details className="run-trace" open>
      <summary>
        <span className="trace-chevron">
          <ChevronRight size={14} />
        </span>
        <span className="trace-run-icon">
          <Activity size={15} />
        </span>
        <strong>Run {index}</strong>
        <Status value={run.status} />
        <span className="trace-duration">
          {duration(run.started_at, run.ended_at)}
        </span>
      </summary>
      <div className="run-details">
        <div className="run-overview">
          <span>Attempt {run.attempt || "—"}</span>
          <span>
            {run.usage
              ? `$${run.usage.cost_usd.toFixed(5)} reported`
              : "Usage not reported"}
          </span>
        </div>
        <div className="trace-steps">
          {events
            .filter((event) =>
              ["input.accepted", "run.started"].includes(event.type),
            )
            .map((event) => (
              <button
                className="trace-step"
                key={event.id}
                onClick={() => inspect(event)}
              >
                <span className="trace-node">
                  {event.type === "input.accepted" ? (
                    <Check size={12} />
                  ) : (
                    <Bot size={12} />
                  )}
                </span>
                <span>
                  {event.type === "input.accepted"
                    ? "Input accepted"
                    : "Pi runtime started"}
                </span>
                <ChevronRight size={12} />
              </button>
            ))}
          {requests.map((request) => {
            const result = events.find(
              (event) =>
                event.type === "tool.completed" &&
                event.data.call_id === request.data.call_id &&
                BigInt(event.seq) > BigInt(request.seq),
            );
            const span = Math.max(
              0.02,
              (new Date(
                result?.created_at ?? run.ended_at ?? Date.now(),
              ).getTime() -
                new Date(request.created_at).getTime()) /
                totalTime,
            );
            return (
              <details className="tool-trace" key={request.id}>
                <summary>
                  <span
                    className={`trace-node ${result?.data.isError ? "error" : "tool"}`}
                  >
                    <Terminal size={12} />
                  </span>
                  <strong>{request.data.name}</strong>
                  <span className="tool-duration">
                    {result
                      ? duration(request.created_at, result.created_at)
                      : pending(run.status)
                        ? "Running…"
                        : "Unknown"}
                  </span>
                  <ChevronRight size={12} />
                </summary>
                <div className="tool-timing" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, span * 100)}%` }} />
                </div>
                <div className="tool-payload">
                  <span>Arguments</span>
                  <pre>{JSON.stringify(request.data.args, null, 2)}</pre>
                  {result && (
                    <>
                      <span>
                        {result.data.isError ? "Error output" : "Result"}
                      </span>
                      <pre className={result.data.isError ? "error-text" : ""}>
                        {result.data.text}
                      </pre>
                      <ScreenshotEvidence event={result} />
                    </>
                  )}
                  <button
                    className="text-button"
                    onClick={() => inspect(result ?? request)}
                  >
                    Inspect event
                    <ArrowRight size={12} />
                  </button>
                </div>
              </details>
            );
          })}
          {events
            .filter((event) =>
              [
                "artifact.published",
                "message.completed",
                "run.completed",
                "run.failed",
                "run.cancelled",
                "run.waiting",
              ].includes(event.type),
            )
            .map((event) => (
              <button
                className="trace-step"
                key={event.id}
                onClick={() => inspect(event)}
              >
                <span
                  className={`trace-node ${event.type.includes("failed") ? "error" : ""}`}
                >
                  {event.type === "artifact.published" ? (
                    <File size={12} />
                  ) : event.type === "message.completed" ? (
                    <MessageSquare size={12} />
                  ) : (
                    <Check size={12} />
                  )}
                </span>
                <span>
                  {event.type === "artifact.published"
                    ? `Published ${String(event.data.path).split("/").at(-1)}`
                    : event.type === "message.completed"
                      ? "Response completed"
                      : event.type.replace(".", " ")}
                </span>
                <ChevronRight size={12} />
              </button>
            ))}
        </div>
        <div className="trace-id">
          <code>{shortId(run.id)}</code>
          <CopyButton value={run.id} label="Copy run ID" />
        </div>
      </div>
    </details>
  );
}
function EventLog({
  events,
  inspect,
}: {
  events: Event[];
  inspect: (event: Event) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const shown = events.filter(
    (event) =>
      (filter === "all" ||
        (filter === "tools"
          ? event.type.startsWith("tool.")
          : event.type.includes("failed") ||
            event.data.isError ||
            event.data.error)) &&
      `${event.type} ${JSON.stringify(event.data)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="event-log">
      <div className="log-filters">
        <label className="search">
          <Search size={14} />
          <input
            aria-label="Search events"
            placeholder="Search events or payloads…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select
          aria-label="Event type"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">All events</option>
          <option value="tools">Tools</option>
          <option value="errors">Errors</option>
        </select>
      </div>
      <div className="log-column-head">
        <span>SEQ / EVENT</span>
        <span>TIME</span>
      </div>
      {shown.map((event) => (
        <button
          className="event-row"
          key={event.id}
          onClick={() => inspect(event)}
        >
          <span className="event-seq">{event.seq.padStart(2, "0")}</span>
          <span
            className={`event-type ${event.type.startsWith("tool") ? "tool-event" : ""} ${event.type.includes("failed") || event.data.isError ? "error-text" : ""}`}
          >
            {event.type}
            <small>
              {event.data.name ??
                (event.data.path
                  ? String(event.data.path)
                  : event.data.input
                    ? String(event.data.input)
                    : "")}
            </small>
          </span>
          <time>
            {new Date(event.created_at).toLocaleTimeString(undefined, {
              hour12: false,
            })}
          </time>
          <ChevronRight size={12} />
        </button>
      ))}
      {!shown.length && (
        <Empty icon={<ListFilter size={24} />} title="No events to show">
          {events.length
            ? "Try a different search or event type."
            : "The durable event log will appear here."}
        </Empty>
      )}
    </div>
  );
}
