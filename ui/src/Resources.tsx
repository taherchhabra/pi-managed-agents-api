import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  Box,
  Check,
  ChevronRight,
  Cpu,
  FileText,
  GlobeLock,
  HardDrive,
  KeyRound,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Terminal,
  Monitor,
} from "lucide-react";
import { date, shortId, useMutation, useResource } from "./client";
import {
  CopyButton,
  DocLink,
  Empty,
  ErrorBox,
  JsonBlock,
  Loading,
  Modal,
  PageHeading,
  Status,
} from "./components";
import type { Capabilities, Environment } from "./types";
import { NetworkEditor, NetworkSummary, networkLabel, networkPolicy, offlineDraft } from "./Network";

export function Environments({ caps }: { caps: Capabilities }) {
  const mutate = useMutation();
  const resource = useResource<{ data: Environment[] }>(
    "/v1/environment-templates",
  );
  const [create, setCreate] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<Environment["type"]>("managed");
  const [network, setNetwork] = useState(offlineDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<Environment>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await mutate("/v1/environment-templates", { name: name.trim(), type, ...(type === "desktop" ? { network: networkPolicy(network) } : {}) });
      setCreate(false);
      setName("");
      setNetwork(offlineDraft);
      resource.reload();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <PageHeading
        eyebrow="EXECUTION"
        title="Environments"
        description="Choose where your agents work. Each session gets its own workspace."
        actions={
          <button className="button primary" onClick={() => setCreate(true)}>
            <Plus size={16} />
            Create environment
          </button>
        }
      />
      <div className="environment-banner">
        <div className="environment-art">
          <Box size={40} />
        </div>
        <div>
          <h2>A workspace that stays with the conversation</h2>
          <p>
            Managed sessions keep their files between runs. Deliverables in{" "}
            <code>outputs/</code> become downloadable artifacts.
          </p>
        </div>
        <span className="pill">
          <ShieldCheck size={14} />
          Isolated by default
        </span>
      </div>
      <div className="section-toolbar">
        <div className="section-caption">
          Environment templates{" "}
          <span className="count">{resource.data?.data.length ?? "—"}</span>
        </div>
      </div>
      <ErrorBox error={resource.error} retry={resource.reload} />
      {!resource.data && !resource.error && <Loading />}
      {resource.data?.data.length === 0 && (
        <div className="panel">
          <Empty
            icon={<Box size={28} />}
            title="Prepare a place to work"
            action={
              <button className="button" onClick={() => setCreate(true)}>
                Create environment
                <ArrowRight size={14} />
              </button>
            }
          >
            Use a managed sandbox for tools, or keep things simple with a
            conversation-only environment.
          </Empty>
        </div>
      )}
      <div className="environment-grid">
        {resource.data?.data.map((environment) => (
          <button
            className="environment-card"
            key={environment.id}
            onClick={() => setDetail(environment)}
          >
            <div className="card-top">
              <span className="environment-icon">
                {environment.type === "desktop" ? <Monitor size={23} /> : environment.type === "managed" ? (
                  <Terminal size={23} />
                ) : (
                  <FileText size={23} />
                )}
              </span>
              <ChevronRight size={16} />
            </div>
            <h3>{environment.name}</h3>
            <p>
              {environment.type === "desktop" ? "Linux desktop · HCU" : environment.type === "managed"
                ? "Managed sandbox"
                : "Conversation only"}
            </p>
            <div className="environment-specs">
              {environment.type === "desktop" ? (<><span><Monitor size={14} />Ubuntu / Xfce</span><span><HardDrive size={14} />Persistent VM</span><span><GlobeLock size={14} />{networkLabel(environment.network)}</span></>) : environment.type === "managed" ? (
                <>
                  <span>
                    <Cpu size={14} />1 CPU
                  </span>
                  <span>
                    <HardDrive size={14} />
                    512 MB
                  </span>
                  <span>
                    <GlobeLock size={14} />
                    No network
                  </span>
                </>
              ) : (
                <>
                  <span>
                    <Check size={14} />
                    Persistent context
                  </span>
                  <span>
                    <LockKeyhole size={14} />
                    No shell or files
                  </span>
                </>
              )}
            </div>
            <div className="card-footer">
              <code>{shortId(environment.id)}</code>
              <span>{date(environment.created_at)}</span>
            </div>
          </button>
        ))}
      </div>
      <div className="quiet-note">
        <ShieldCheck size={16} />
        <span>
          Sandbox policy is controlled by the operator. Agents receive only the
          tools enabled in their pinned version.
        </span>
      </div>
      {create && (
        <Modal
          title="Create an environment"
          subtitle="A reusable runtime template for new sessions."
          close={() => setCreate(false)}
        >
          <form onSubmit={submit}>
            <label className="field">
              Name
              <input
                autoFocus
                required
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Python workspace"
              />
            </label>
            <div className="choice-grid workspace-choices">
              <label className={`choice ${type === "desktop" ? "selected" : ""} ${!caps.desktop.configured ? "disabled" : ""}`}>
                <input name="environment-type" type="radio" checked={type === "desktop"} disabled={!caps.desktop.configured} onChange={() => setType("desktop")} />
                <Monitor size={22} /><strong>Linux desktop</strong><small>{caps.desktop.configured ? "Ubuntu, Xfce, and HCU in a private VM. Apps and files stay with the session." : "Set up a desktop host to enable Linux VMs."}</small>
              </label>
              <label
                className={`choice ${type === "managed" ? "selected" : ""}`}
              >
                <input
                  name="environment-type"
                  type="radio"
                  checked={type === "managed"}
                  onChange={() => setType("managed")}
                />
                <Terminal size={22} />
                <strong>Managed sandbox</strong>
                <small>
                  Bash, Python, and a persistent filesystem. Network access
                  disabled.
                </small>
              </label>
              <label className={`choice ${type === "none" ? "selected" : ""}`}>
                <input
                  name="environment-type"
                  type="radio"
                  checked={type === "none"}
                  onChange={() => setType("none")}
                />
                <FileText size={22} />
                <strong>Conversation only</strong>
                <small>
                  Persistent conversation context, without file or command
                  tools.
                </small>
              </label>
            </div>
            {type === "desktop" && <p className="field-hint">Uses QEMU/KVM with HCU for accessibility and screen control. <DocLink page="desktop">Desktop setup guide</DocLink></p>}
            {type === "desktop" && <NetworkEditor value={network} onChange={setNetwork} />}
            {type === "managed" && (
              <p className="field-hint">
                Operator image: <code>{caps.sandbox_image}</code>
                <br />1 CPU · 512 MB memory · Non-root execution
              </p>
            )}
            <ErrorBox error={error} />
            <div className="modal-footer">
              <button
                type="button"
                className="button"
                onClick={() => setCreate(false)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={busy || !name.trim()}
              >
                {busy ? "Creating…" : "Create environment"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {detail && (
        <Modal
          title={detail.name}
          subtitle={
            detail.type === "desktop" ? "Linux desktop template" : detail.type === "managed"
              ? "Managed sandbox template"
              : "Conversation-only template"
          }
          close={() => setDetail(undefined)}
        >
          <div className="id-line">
            <code>{detail.id}</code>
            <CopyButton value={detail.id} />
          </div>
          {detail.type === "desktop" && <NetworkSummary network={detail.network} />}
          <JsonBlock
            value={{
              type: detail.type,
              ...(detail.type === "desktop" ? { platform: "linux", hypervisor: "qemu-kvm", driver: "hcu", network: detail.network, workspace: "/workspace", lifecycle: "paused between runs" } : detail.type === "managed"
                ? {
                    image: detail.image,
                    network: "none",
                    cpu: 1,
                    memory_mb: 512,
                    user: 10001,
                    workspace: "/workspace",
                    artifacts: "/workspace/outputs",
                  }
                : { tools: [], context: "persistent" }),
            }}
            label="Environment configuration"
          />
          <p className="field-hint">
            Created {date(detail.created_at)}. Use this template when starting a
            new session.
          </p>
        </Modal>
      )}
    </div>
  );
}
export function Connections({ caps }: { caps: Capabilities }) {
  const labels = {
    openrouter: "OpenRouter",
    openai: "OpenAI",
    anthropic: "Anthropic",
  };
  const [selected, setSelected] = useState<string>();
  return (
    <div className="page">
      <PageHeading
        eyebrow="WORKSPACE SETTINGS"
        title="Connections"
        description="Model providers available to your Pi runtime."
      />
      <div className="connections-panel panel">
        <div className="panel-title">
          <KeyRound size={20} />
          <div>
            <h2>Model providers</h2>
            <p>
              Credentials are configured on the server and never exposed to
              agents or the browser.
            </p>
          </div>
        </div>
        {caps.providers.map((provider) => (
          <div className="connection-row" key={provider.id}>
            <span className={`provider-logo provider-${provider.id}`}>
              {provider.id === "openrouter" ? (
                <ArrowRight size={22} />
              ) : provider.id === "openai" ? (
                <span>O</span>
              ) : (
                <span>A</span>
              )}
            </span>
            <div>
              <strong>{labels[provider.id]}</strong>
              <small>
                {provider.models.length} models in the installed catalog
              </small>
            </div>
            <Status
              value={provider.configured ? "configured" : "not_configured"}
            />
            <button
              className="button small"
              onClick={() => setSelected(provider.id)}
            >
              Setup details
            </button>
          </div>
        ))}
      </div>
      <div className="runtime-card">
        <span className="runtime-mark">π</span>
        <div>
          <div className="eyebrow">THE AGENT RUNTIME</div>
          <h2>Powered by Pi</h2>
          <p>
            Pi runs the model and tool loop. This service keeps agent versions,
            sessions, workspaces, and event history.
          </p>
          <div className="runtime-meta">
            <span>SDK {caps.sdk_version}</span>
            <span>PostgreSQL persistence</span>
            <span>Docker & Linux desktops</span>
          </div>
          <DocLink page="concepts">
            Understand agents and sessions
          </DocLink>
        </div>
      </div>
      {selected && (
        <Modal
          title={`${labels[selected as keyof typeof labels]} connection`}
          subtitle="Provider credentials belong on the server."
          close={() => setSelected(undefined)}
        >
          <ol className="setup-steps">
            <li>
              Add <code>{selected.toUpperCase()}_API_KEY</code> to the server’s{" "}
              <code>.env.vps</code> for VPS hosting, or <code>.env</code> for local development.
            </li>
            <li>
              Restart the API and worker so they receive the updated
              configuration.
            </li>
            <li>
              Choose this provider and a supported model in your agent, then
              start a test session.
            </li>
          </ol>
          <div className="quiet-note">
            <LockKeyhole size={17} />
            <span>
              Configured means a server key is present. A successful run
              verifies that the key and model work.
            </span>
          </div>
          <div className="connection-guides">
            <DocLink page="self-hosting?section=configure">VPS setup guide</DocLink>
            <DocLink page="local-setup">Local setup guide</DocLink>
          </div>
        </Modal>
      )}
    </div>
  );
}
