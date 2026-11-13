import { useEffect, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  Box,
  ChevronRight,
  CircleHelp,
  KeyRound,
  Layers3,
  LogOut,
  Menu,
  MessageSquare,
  ShieldCheck,
  X,
} from "lucide-react";
import { Agents, AgentEditor } from "./Agents";
import { Sessions, SessionWorkspace } from "./Sessions";
import { Connections, Environments } from "./Resources";
import { Documentation } from "./Docs";
import { api, useResource } from "./client";
import { DocLink, ErrorBox, Loading } from "./components";
import type { Capabilities } from "./types";

function Login({ connected }: { connected: (tenant: string) => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ tenant: string }>("/console/login", { token });
      setToken("");
      connected(result.tenant);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <a href="#/agents" className="brand">
        <span className="brand-mark">π</span>
        <span>
          pi <strong>agents</strong>
        </span>
      </a>
      <div className="login-layout">
        <div className="login-story">
          <span className="eyebrow">YOUR AGENT WORKSPACE</span>
          <h1>
            Build with purpose.
            <br />
            <span>Run with context.</span>
          </h1>
          <p>
            Bring your agents to life with persistent sessions, isolated
            workspaces, and a clear view of every step.
          </p>
          <div className="login-flow">
            <span>
              <Bot size={19} />
              Agent
            </span>
            <ChevronRight size={16} />
            <span>
              <MessageSquare size={19} />
              Session
            </span>
            <ChevronRight size={16} />
            <span>
              <Activity size={19} />
              Run
            </span>
          </div>
          <div className="login-note">
            <ShieldCheck size={17} />
            Your models. Your infrastructure. Pi at the core.
          </div>
        </div>
        <form className="login-form panel" onSubmit={submit}>
          <div className="login-icon">
            <KeyRound size={22} />
          </div>
          <h2>Open your workspace</h2>
          <p>
            Sign in with an API token from this server’s <code>API_KEYS</code>{" "}
            configuration.
          </p>
          <label className="field">
            API token
            <input
              autoFocus
              type="password"
              autoComplete="off"
              required
              minLength={24}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Enter your workspace token"
            />
          </label>
          <ErrorBox error={error} />
          <button
            className="button primary full"
            disabled={busy || token.length < 24}
          >
            {busy ? "Connecting…" : "Connect to workspace"}
            <ArrowRight size={16} />
          </button>
          <small>
            Your token is exchanged for an 8-hour session. Model provider keys
            stay on the server.
          </small>
          <DocLink page="get-started">Need help getting started?</DocLink>
        </form>
      </div>
      <footer className="login-footer">
        Pi Managed Agents{" "}
        <span>Open source · Built on the Pi coding agent SDK</span>
      </footer>
    </div>
  );
}
export function App() {
  const [tenant, setTenant] = useState<string | null>();
  const [route, setRoute] = useState(
    window.location.hash.slice(1) || "/agents",
  );
  useEffect(() => {
    const change = () => setRoute(window.location.hash.slice(1) || "/agents");
    const unauthorized = () => setTenant(null);
    window.addEventListener("hashchange", change);
    window.addEventListener("pi:unauthorized", unauthorized);
    void api<{ tenant: string }>("/console/session")
      .then((value) => setTenant(value.tenant))
      .catch(() => setTenant(null));
    return () => {
      window.removeEventListener("hashchange", change);
      window.removeEventListener("pi:unauthorized", unauthorized);
    };
  }, []);
  if (route === "/docs" || route.startsWith("/docs/"))
    return <Documentation route={route} />;
  if (tenant === undefined) return <Loading />;
  if (!tenant) return <Login connected={setTenant} />;
  return (
    <Console
      key={tenant}
      tenant={tenant}
      route={route}
      logout={() => setTenant(null)}
    />
  );
}
function Console({
  tenant,
  route,
  logout,
}: {
  tenant: string;
  route: string;
  logout: () => void;
}) {
  const resource = useResource<Capabilities>("/v1/capabilities");
  const [menu, setMenu] = useState(false);
  const [mobile, setMobile] = useState(
    () => window.matchMedia("(max-width: 650px)").matches,
  );
  const [logoutError, setLogoutError] = useState("");
  useEffect(() => {
    const media = window.matchMedia("(max-width: 650px)");
    const resize = () => {
      setMobile(media.matches);
      if (!media.matches) setMenu(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    media.addEventListener("change", resize);
    window.addEventListener("keydown", escape);
    return () => {
      media.removeEventListener("change", resize);
      window.removeEventListener("keydown", escape);
    };
  }, []);
  useEffect(() => {
    setMenu(false);
    window.scrollTo({ top: 0 });
  }, [route]);
  const [path, search = ""] = route.split("?");
  const parts = path!.split("/").filter(Boolean);
  const section = parts[0] ?? "agents";
  const id = parts[1];
  const nav = [
    { path: "agents", name: "Agents", icon: Bot },
    { path: "sessions", name: "Sessions", icon: MessageSquare },
    { path: "environments", name: "Environments", icon: Box },
  ];
  const title =
    section === "connections"
      ? "Connections"
      : (nav.find((item) => item.path === section)?.name ?? "Workspace");
  return (
    <div className={`app-shell ${menu ? "menu-open" : ""}`}>
      <aside
        className="sidebar"
        id="workspace-navigation"
        inert={mobile && !menu}
      >
        <a className="brand" href="#/agents">
          <span className="brand-mark">π</span>
          <span>
            pi <strong>agents</strong>
          </span>
          <span className="beta-label">MVP</span>
        </a>
        <div className="workspace-switch">
          <span className="workspace-avatar">
            {tenant.slice(0, 1).toUpperCase()}
          </span>
          <span>
            <strong>{tenant}</strong>
            <small>Local workspace</small>
          </span>
          <Layers3 size={15} />
        </div>
        <div className="nav-heading">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {nav.map((item) => (
            <a
              className={section === item.path ? "selected" : ""}
              href={`#/${item.path}`}
              key={item.path}
            >
              <item.icon size={18} />
              {item.name}
              {section === item.path && <span className="nav-indicator" />}
            </a>
          ))}
        </nav>
        <div className="nav-heading settings-label">MANAGE</div>
        <nav>
          <a
            className={section === "connections" ? "selected" : ""}
            href="#/connections"
          >
            <KeyRound size={18} />
            Connections
          </a>
        </nav>
        <div className="sidebar-bottom">
          <a
            className="help-link"
            href="#/docs/get-started"
          >
            <CircleHelp size={17} />
            Documentation
            <ArrowRight size={14} />
          </a>
          <div className="runtime-status">
            <span className="runtime-mini">π</span>
            <span>
              <strong>Pi runtime</strong>
              <small>SDK {resource.data?.sdk_version ?? "…"}</small>
            </span>
            <span className="tiny-dot" />
          </div>
        </div>
      </aside>
      {menu && (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <main className="main" inert={mobile && menu}>
        <div className="topbar">
          <div>
            <button
              className="icon-button menu-toggle"
              aria-label="Toggle navigation"
              aria-expanded={menu}
              aria-controls="workspace-navigation"
              onClick={() => setMenu(!menu)}
            >
              {menu ? <X size={19} /> : <Menu size={19} />}
            </button>
            <span className="topbar-workspace">Workspace</span>
            <ChevronRight size={13} />
            <span>{title}</span>
            {id && (
              <>
                <ChevronRight size={13} />
                <span className="subtle">
                  {id === "new"
                    ? "Create"
                    : section === "sessions"
                      ? "Playground"
                      : "Agent details"}
                </span>
              </>
            )}
          </div>
          <div>
            <span className="api-connected">
              <span className="tiny-dot" />
              {resource.data ? "API connected" : "Connecting"}
            </span>
            <button
              className="icon-button"
              title="Sign out"
              aria-label="Sign out"
              onClick={() => {
                void api("/console/logout", {})
                  .then(logout)
                  .catch((error) => setLogoutError(error.message));
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
        <ErrorBox
          error={logoutError || resource.error}
          retry={resource.error ? resource.reload : undefined}
        />
        {resource.data ? (
          section === "agents" ? (
            id ? (
              <AgentEditor
                key={route}
                id={id}
                starter={Number(
                  new URLSearchParams(search).get("starter") ?? -1,
                )}
                caps={resource.data}
              />
            ) : (
              <Agents caps={resource.data} />
            )
          ) : section === "sessions" ? (
            id ? (
              <SessionWorkspace key={id} id={id} />
            ) : (
              <Sessions caps={resource.data} />
            )
          ) : section === "environments" ? (
            <Environments caps={resource.data} />
          ) : section === "connections" ? (
            <Connections caps={resource.data} />
          ) : (
            <div className="page">
              <h1>Page not found</h1>
              <a href="#/agents">Return to agents</a>
            </div>
          )
        ) : (
          !resource.error && <Loading />
        )}
      </main>
    </div>
  );
}
