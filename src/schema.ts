export const schema = `
CREATE TABLE agents (
  id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id, tenant_id)
);
CREATE TABLE agent_versions (
  id text PRIMARY KEY, tenant_id text NOT NULL, agent_id text NOT NULL,
  version integer NOT NULL, config jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id, version), UNIQUE(id, tenant_id),
  FOREIGN KEY(agent_id, tenant_id) REFERENCES agents(id, tenant_id)
);
CREATE TABLE environment_templates (
  id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL,
  type text NOT NULL CHECK(type IN ('none', 'managed')), image text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id, tenant_id)
);
CREATE TABLE sessions (
  id text PRIMARY KEY, tenant_id text NOT NULL, agent_version_id text NOT NULL,
  environment_template_id text NOT NULL, status text NOT NULL DEFAULT 'active',
  checkpoint jsonb, workspace_initialized boolean NOT NULL DEFAULT false,
  workspace_cleaned boolean NOT NULL DEFAULT false,
  event_seq bigint NOT NULL DEFAULT 0, epoch bigint NOT NULL DEFAULT 0,
  lease_owner text, lease_expires timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, tenant_id), CHECK(status IN ('active', 'archived')),
  FOREIGN KEY(agent_version_id, tenant_id) REFERENCES agent_versions(id, tenant_id),
  FOREIGN KEY(environment_template_id, tenant_id) REFERENCES environment_templates(id, tenant_id)
);
CREATE TABLE runs (
  id text PRIMARY KEY, session_id text NOT NULL, tenant_id text NOT NULL,
  input text NOT NULL, status text NOT NULL DEFAULT 'queued', attempt integer NOT NULL DEFAULT 0,
  base_checkpoint jsonb, output_text text, error jsonb, usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, ended_at timestamptz,
  UNIQUE(id, tenant_id),
  CHECK(status IN ('queued','running','waiting','cancelling','completed','failed','cancelled')),
  FOREIGN KEY(session_id, tenant_id) REFERENCES sessions(id, tenant_id)
);
CREATE INDEX runs_queue ON runs(created_at, id) WHERE status = 'queued';
CREATE UNIQUE INDEX runs_one_active ON runs(session_id) WHERE status IN ('running','waiting','cancelling');
CREATE TABLE events (
  session_id text NOT NULL, tenant_id text NOT NULL, seq bigint NOT NULL,
  id text NOT NULL UNIQUE, type text NOT NULL, run_id text, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id, seq),
  FOREIGN KEY(session_id, tenant_id) REFERENCES sessions(id, tenant_id)
);
CREATE TABLE idempotency (
  tenant_id text NOT NULL, scope text NOT NULL, key text NOT NULL, request_hash text NOT NULL,
  status_code integer NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, scope, key)
);
CREATE TABLE tool_calls (
  run_id text NOT NULL, call_id text NOT NULL, tenant_id text NOT NULL, attempt integer NOT NULL,
  name text NOT NULL, args jsonb NOT NULL, status text NOT NULL DEFAULT 'running', result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  PRIMARY KEY(run_id, attempt, call_id),
  FOREIGN KEY(run_id, tenant_id) REFERENCES runs(id, tenant_id)
);
CREATE TABLE artifacts (
  id text PRIMARY KEY, tenant_id text NOT NULL, session_id text NOT NULL, run_id text NOT NULL,
  path text NOT NULL, sha256 text NOT NULL, size bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id, path),
  FOREIGN KEY(session_id, tenant_id) REFERENCES sessions(id, tenant_id),
  FOREIGN KEY(run_id, tenant_id) REFERENCES runs(id, tenant_id)
);
`;
