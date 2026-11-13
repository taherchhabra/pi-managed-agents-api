export type Provider = "openrouter" | "openai" | "anthropic";
export type Tool = "bash" | "read_file" | "write_file";
export interface AgentConfig {
  provider: Provider;
  model: string;
  instructions: string;
  tools: Tool[];
}
export interface Version {
  id: string;
  version: number;
  config: AgentConfig;
  created_at: string;
}
export interface Agent {
  id: string;
  name: string;
  created_at: string;
  latest_version: Version;
  versions?: Version[];
  session_count: number;
}
export interface Environment {
  id: string;
  name: string;
  type: "none" | "managed";
  image: string | null;
  created_at: string;
}
export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";
export interface Run {
  id: string;
  session_id: string;
  status: RunStatus;
  input: string;
  output_text: string | null;
  attempt: number;
  error: { code?: string; message?: string } | null;
  usage: { tokens: Record<string, number>; cost_usd: number } | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}
export interface Session {
  id: string;
  status: "active" | "archived";
  agent_version_id: string;
  agent_id: string;
  agent_name: string;
  agent_version: number;
  environment_template_id: string;
  environment_name: string;
  environment_type: "managed" | "none";
  created_at: string;
  event_seq: string;
  config: AgentConfig;
  model: string;
  latest_run: Run | null;
  active_run: Run | null;
  run_count: number;
  pending_runs: number;
}
export interface Event {
  id: string;
  seq: string;
  type: string;
  run_id: string | null;
  session_id: string;
  created_at: string;
  data: Record<string, any>;
}
export interface Artifact {
  id: string;
  path: string;
  size: string;
  sha256: string;
  run_id: string;
  created_at: string;
  download_url: string;
}
export interface Capabilities {
  providers: {
    id: Provider;
    configured: boolean;
    models: { id: string; name: string; context_window: number }[];
  }[];
  sandbox_image: string;
  sdk_version: string;
}
