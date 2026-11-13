import pg, { type PoolClient } from 'pg';
import { schema } from './schema.js';
import { ApiError, canonical, digest, LeaseLost, makeId, requireRow, terminal,
  type AgentConfig, type Checkpoint, type Job, type ToolResult } from './domain.js';

type Tx = PoolClient;
export interface Reply { status: number; body: any }
const runFields = 'id, session_id, status, input, attempt, output_text, error, usage, created_at, started_at, ended_at';

export class Store {
  constructor(public pool: pg.Pool) {}
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect();
    try { await tx.query('BEGIN'); const value = await fn(tx); await tx.query('COMMIT'); return value; }
    catch (error) { await tx.query('ROLLBACK'); throw error; }
    finally { tx.release(); }
  }
  async migrate() {
    await this.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':pi:migrations', 0))");
      await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)');
      if (!(await tx.query('SELECT 1 FROM schema_migrations WHERE version=1')).rowCount) {
        await tx.query(schema);
        await tx.query('INSERT INTO schema_migrations VALUES(1)');
      }
    });
  }
  async mutate(tenant: string, scope: string, key: string, body: unknown, fn: (tx: Tx) => Promise<Reply>): Promise<Reply> {
    if (!key || key.length > 200) throw new ApiError(400, 'idempotency_key_required', 'Supply an Idempotency-Key of 1–200 characters');
    return this.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [canonical([tenant, scope, key])]);
      const hash = digest(canonical(body));
      const old = (await tx.query('SELECT * FROM idempotency WHERE tenant_id=$1 AND scope=$2 AND key=$3', [tenant, scope, key])).rows[0];
      if (old) {
        if (old.request_hash !== hash) throw new ApiError(409, 'idempotency_conflict', 'This key was already used for different input');
        return { status: old.status_code, body: old.response };
      }
      const response = await fn(tx);
      await tx.query('INSERT INTO idempotency(tenant_id,scope,key,request_hash,status_code,response) VALUES($1,$2,$3,$4,$5,$6)',
        [tenant, scope, key, hash, response.status, JSON.stringify(response.body)]);
      return response;
    });
  }
  private async event(tx: Tx, tenant: string, sessionId: string, type: string, runId: string | null, data: unknown) {
    const row = requireRow((await tx.query('UPDATE sessions SET event_seq=event_seq+1 WHERE id=$1 AND tenant_id=$2 RETURNING event_seq', [sessionId, tenant])).rows[0]);
    await tx.query('INSERT INTO events(session_id,tenant_id,seq,id,type,run_id,data) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [sessionId, tenant, row.event_seq, makeId('evt'), type, runId, JSON.stringify(data)]);
  }
  private async session(tx: Tx, tenant: string, id: string) {
    return requireRow((await tx.query('SELECT * FROM sessions WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [id, tenant])).rows[0]);
  }
  async createAgent(tx: Tx, tenant: string, name: string, config: AgentConfig): Promise<Reply> {
    const id = makeId('agt');
    const row = (await tx.query('INSERT INTO agents(id,tenant_id,name) VALUES($1,$2,$3) RETURNING id,name,created_at', [id, tenant, name])).rows[0];
    const version = await this.createVersion(tx, tenant, id, config);
    return { status: 201, body: { ...row, latest_version: version.body } };
  }
  async createVersion(tx: Tx, tenant: string, agent: string, config: AgentConfig): Promise<Reply> {
    requireRow((await tx.query('SELECT id FROM agents WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [agent, tenant])).rows[0]);
    const row = (await tx.query('INSERT INTO agent_versions(id,tenant_id,agent_id,version,config) SELECT $1,$2,$3,COALESCE(MAX(version),0)+1,$4 FROM agent_versions WHERE agent_id=$3 RETURNING id,agent_id,version,config,created_at',
      [makeId('av'), tenant, agent, JSON.stringify(config)])).rows[0];
    return { status: 201, body: row };
  }
  async createEnvironment(tx: Tx, tenant: string, name: string, type: string, image: string): Promise<Reply> {
    const row = (await tx.query('INSERT INTO environment_templates(id,tenant_id,name,type,image) VALUES($1,$2,$3,$4,$5) RETURNING id,name,type,image,created_at',
      [makeId('env'), tenant, name, type, type === 'managed' ? image : null])).rows[0];
    return { status: 201, body: row };
  }
  async createSession(tx: Tx, tenant: string, version: string, environment: string): Promise<Reply> {
    const agent = requireRow((await tx.query('SELECT config FROM agent_versions WHERE id=$1 AND tenant_id=$2', [version, tenant])).rows[0]);
    const env = requireRow((await tx.query('SELECT type FROM environment_templates WHERE id=$1 AND tenant_id=$2', [environment, tenant])).rows[0]);
    if (env.type === 'none' && agent.config.tools.length) throw new ApiError(400, 'environment_required', 'Filesystem and shell tools require a managed environment');
    const id = makeId('ses');
    const row = (await tx.query('INSERT INTO sessions(id,tenant_id,agent_version_id,environment_template_id) VALUES($1,$2,$3,$4) RETURNING id,status,agent_version_id,environment_template_id,created_at',
      [id, tenant, version, environment])).rows[0];
    await this.event(tx, tenant, id, 'session.created', null, { session_id: id });
    return { status: 201, body: row };
  }
  async enqueue(tx: Tx, tenant: string, sessionId: string, input: string, whenBusy: string): Promise<Reply> {
    const session = await this.session(tx, tenant, sessionId);
    if (session.status !== 'active') throw new ApiError(409, 'session_archived', 'Session is archived');
    if (whenBusy === 'reject' && (await tx.query("SELECT 1 FROM runs WHERE session_id=$1 AND status IN ('queued','running','waiting','cancelling')", [sessionId])).rowCount) {
      throw new ApiError(409, 'session_busy', 'Session already has pending work');
    }
    const id = makeId('run');
    const row = (await tx.query('INSERT INTO runs(id,tenant_id,session_id,input) VALUES($1,$2,$3,$4) RETURNING ' + runFields, [id, tenant, sessionId, input])).rows[0];
    await this.event(tx, tenant, sessionId, 'input.accepted', id, { input });
    return { status: 202, body: row };
  }
  async cancel(tx: Tx, tenant: string, sessionId: string, runId: string): Promise<Reply> {
    const session = await this.session(tx, tenant, sessionId);
    const run = requireRow((await tx.query('SELECT * FROM runs WHERE id=$1 AND session_id=$2 AND tenant_id=$3 FOR UPDATE', [runId, sessionId, tenant])).rows[0]);
    if (!terminal(run.status) && run.status !== 'cancelling') {
      const status = run.status === 'running' ? 'cancelling' : 'cancelled';
      // A lost worker's checkpoint may contain an unresolved tool call. Return to
      // the last completed run's context; workspace effects are not rolled back.
      if (run.status === 'waiting') await tx.query('UPDATE sessions SET checkpoint=$2 WHERE id=$1', [sessionId, run.base_checkpoint]);
      await tx.query('UPDATE runs SET status=$2, ended_at=CASE WHEN $2=\'cancelled\' THEN now() ELSE NULL END WHERE id=$1', [runId, status]);
      await this.event(tx, tenant, sessionId, 'run.' + status, runId, {});
    }
    return { status: terminal(run.status) ? 200 : 202, body: requireRow((await tx.query('SELECT ' + runFields + ' FROM runs WHERE id=$1', [runId])).rows[0]) };
  }
  async resume(tx: Tx, tenant: string, sessionId: string, runId: string): Promise<Reply> {
    const session = await this.session(tx, tenant, sessionId);
    if (session.status !== 'active') throw new ApiError(409, 'session_archived', 'Session is archived');
    const run = requireRow((await tx.query('SELECT * FROM runs WHERE id=$1 AND session_id=$2 AND tenant_id=$3 FOR UPDATE', [runId, sessionId, tenant])).rows[0]);
    if (run.status !== 'waiting') throw new ApiError(409, 'not_waiting', 'Only interrupted runs can be resumed');
    if ((await tx.query('SELECT 1 FROM tool_calls WHERE run_id=$1 LIMIT 1', [runId])).rowCount) {
      throw new ApiError(409, 'reconciliation_required', 'This run invoked tools. Cancel it and reconcile workspace effects before submitting new work; automatic tool replay is not supported');
    }
    await tx.query('UPDATE sessions SET checkpoint=$2 WHERE id=$1', [sessionId, run.base_checkpoint]);
    const row = (await tx.query("UPDATE runs SET status='queued',error=NULL,ended_at=NULL WHERE id=$1 RETURNING " + runFields, [runId])).rows[0];
    await this.event(tx, tenant, sessionId, 'run.resumed', runId, { next_attempt: run.attempt + 1 });
    return { status: 202, body: row };
  }
  async archive(tx: Tx, tenant: string, sessionId: string): Promise<Reply> {
    const row = await this.session(tx, tenant, sessionId);
    if ((await tx.query("SELECT 1 FROM runs WHERE session_id=$1 AND status IN ('queued','running','waiting','cancelling')", [sessionId])).rowCount) {
      throw new ApiError(409, 'session_busy', 'Cancel or finish pending runs before archiving');
    }
    if (row.status !== 'archived') {
      await tx.query("UPDATE sessions SET status='archived' WHERE id=$1", [sessionId]);
      await this.event(tx, tenant, sessionId, 'session.archived', null, {});
    }
    return { status: 200, body: { id: sessionId, status: 'archived' } };
  }
  async getSession(tenant: string, id: string) {
    // A single SQL snapshot pairs activity with its replay cursor.
    return requireRow((await this.pool.query(`SELECT s.id,s.status,s.agent_version_id,s.environment_template_id,s.event_seq,s.created_at,
      a.id AS agent_id,a.name AS agent_name,v.version AS agent_version,v.config,
      e.name AS environment_name,e.type AS environment_type,
      (SELECT row_to_json(active) FROM (SELECT ${runFields} FROM runs r WHERE r.session_id=s.id
        AND r.status IN ('running','waiting','cancelling') LIMIT 1) active) AS active_run
      FROM sessions s JOIN agent_versions v ON v.id=s.agent_version_id AND v.tenant_id=s.tenant_id
      JOIN agents a ON a.id=v.agent_id AND a.tenant_id=s.tenant_id
      JOIN environment_templates e ON e.id=s.environment_template_id AND e.tenant_id=s.tenant_id
      WHERE s.id=$1 AND s.tenant_id=$2`, [id, tenant])).rows[0]);
  }
  async getAgent(tenant: string, id: string) {
    return requireRow((await this.pool.query(`SELECT a.id,a.name,a.created_at,
      (SELECT json_agg(v ORDER BY v.version) FROM (SELECT id,version,config,created_at FROM agent_versions
        WHERE agent_id=a.id AND tenant_id=a.tenant_id) v) AS versions
      FROM agents a WHERE a.id=$1 AND a.tenant_id=$2`, [id, tenant])).rows[0]);
  }
  async getEnvironment(tenant: string, id: string) {
    return requireRow((await this.pool.query('SELECT id,name,type,image,created_at FROM environment_templates WHERE id=$1 AND tenant_id=$2', [id, tenant])).rows[0]);
  }
  async getRun(tenant: string, session: string, run: string) {
    return requireRow((await this.pool.query('SELECT ' + runFields + ' FROM runs WHERE tenant_id=$1 AND session_id=$2 AND id=$3', [tenant, session, run])).rows[0]);
  }
  async list(tenant: string, resource: 'agents' | 'environment_templates' | 'sessions') {
    if (resource === 'agents') return (await this.pool.query(`SELECT a.id,a.name,a.created_at,
      (SELECT row_to_json(v) FROM (SELECT id,version,config,created_at FROM agent_versions WHERE agent_id=a.id AND tenant_id=a.tenant_id ORDER BY version DESC LIMIT 1) v) AS latest_version,
      (SELECT count(*)::integer FROM sessions s JOIN agent_versions v ON v.id=s.agent_version_id WHERE v.agent_id=a.id AND s.tenant_id=a.tenant_id) AS session_count
      FROM agents a WHERE a.tenant_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT 100`, [tenant])).rows;
    if (resource === 'sessions') return (await this.pool.query(`SELECT s.id,s.status,s.agent_version_id,s.environment_template_id,s.created_at,
      a.id AS agent_id,a.name AS agent_name,v.version AS agent_version,v.config->>'model' AS model,
      e.name AS environment_name,e.type AS environment_type,
      (SELECT row_to_json(r) FROM (SELECT id,status,left(input,200) AS input,created_at FROM runs WHERE session_id=s.id AND tenant_id=s.tenant_id ORDER BY created_at DESC,id DESC LIMIT 1) r) AS latest_run,
      (SELECT count(*)::integer FROM runs WHERE session_id=s.id AND tenant_id=s.tenant_id) AS run_count,
      (SELECT count(*)::integer FROM runs WHERE session_id=s.id AND tenant_id=s.tenant_id AND status IN ('queued','running','waiting','cancelling')) AS pending_runs
      FROM sessions s JOIN agent_versions v ON v.id=s.agent_version_id AND v.tenant_id=s.tenant_id
      JOIN agents a ON a.id=v.agent_id AND a.tenant_id=s.tenant_id
      JOIN environment_templates e ON e.id=s.environment_template_id AND e.tenant_id=s.tenant_id
      WHERE s.tenant_id=$1 ORDER BY s.created_at DESC,s.id DESC LIMIT 100`, [tenant])).rows;
    const fields = { agents: 'id,name,created_at', environment_templates: 'id,name,type,image,created_at', sessions: 'id,status,agent_version_id,environment_template_id,created_at' }[resource];
    return (await this.pool.query('SELECT ' + fields + ' FROM ' + resource + ' WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100', [tenant])).rows;
  }
  async runs(tenant: string, session: string, after?: string) {
    requireRow((await this.pool.query('SELECT id FROM sessions WHERE id=$1 AND tenant_id=$2', [session, tenant])).rows[0]);
    if (after) await this.getRun(tenant, session, after);
    return (await this.pool.query('SELECT ' + runFields + ` FROM runs WHERE tenant_id=$1 AND session_id=$2
      ${after ? 'AND (created_at,id)>(SELECT created_at,id FROM runs WHERE id=$3 AND tenant_id=$1 AND session_id=$2)' : ''}
      ORDER BY created_at,id LIMIT 100`, after ? [tenant, session, after] : [tenant, session])).rows;
  }
  async events(tenant: string, session: string, after: string, limit = 100) {
    requireRow((await this.pool.query('SELECT id FROM sessions WHERE id=$1 AND tenant_id=$2', [session, tenant])).rows[0]);
    return (await this.pool.query('SELECT id,seq,type,run_id,session_id,data,created_at,1 AS schema_version FROM events WHERE tenant_id=$1 AND session_id=$2 AND seq>$3 ORDER BY seq LIMIT $4', [tenant, session, after, limit])).rows;
  }
  async artifacts(tenant: string, session: string) {
    requireRow((await this.pool.query('SELECT id FROM sessions WHERE id=$1 AND tenant_id=$2', [session, tenant])).rows[0]);
    return (await this.pool.query('SELECT id,session_id,run_id,path,sha256,size,created_at FROM artifacts WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at,id', [tenant, session])).rows;
  }
  async artifact(tenant: string, session: string, id: string) {
    return requireRow((await this.pool.query('SELECT * FROM artifacts WHERE tenant_id=$1 AND session_id=$2 AND id=$3', [tenant, session, id])).rows[0]);
  }
  async claim(owner: string, leaseMs: number): Promise<Job | null> {
    return this.transaction(async tx => {
      const row = (await tx.query(`SELECT s.* FROM sessions s WHERE s.status='active'
        AND (s.lease_expires IS NULL OR s.lease_expires<now())
        AND EXISTS(SELECT 1 FROM runs r WHERE r.session_id=s.id AND r.status='queued')
        AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.session_id=s.id AND r.status IN ('running','waiting','cancelling'))
        ORDER BY s.created_at,s.id FOR UPDATE OF s SKIP LOCKED LIMIT 1`)).rows[0];
      if (!row) return null;
      const run = (await tx.query("SELECT * FROM runs WHERE session_id=$1 AND status='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE", [row.id])).rows[0];
      const session = (await tx.query("UPDATE sessions SET epoch=epoch+1,lease_owner=$2,lease_expires=now()+$3*interval '1 millisecond' WHERE id=$1 RETURNING epoch", [row.id, owner, leaseMs])).rows[0];
      await tx.query("UPDATE runs SET status='running',attempt=attempt+1,base_checkpoint=$2,started_at=now(),error=NULL WHERE id=$1", [run.id, row.checkpoint]);
      const config = (await tx.query('SELECT config FROM agent_versions WHERE id=$1', [row.agent_version_id])).rows[0].config;
      const environment = (await tx.query('SELECT type,image FROM environment_templates WHERE id=$1', [row.environment_template_id])).rows[0];
      await this.event(tx, row.tenant_id, row.id, 'run.started', run.id, { attempt: run.attempt + 1 });
      return { id: run.id, session_id: row.id, tenant_id: row.tenant_id, input: run.input, attempt: run.attempt + 1, epoch: Number(session.epoch), owner, config, environment, checkpoint: row.checkpoint, workspace_initialized: row.workspace_initialized };
    });
  }
  private async owned(tx: Tx, job: Job) {
    const row = (await tx.query('SELECT id FROM sessions WHERE id=$1 AND tenant_id=$2 AND epoch=$3 AND lease_owner=$4 AND lease_expires>clock_timestamp() FOR UPDATE', [job.session_id, job.tenant_id, job.epoch, job.owner])).rows[0];
    if (!row) throw new LeaseLost();
  }
  async workspaceReady(job: Job) {
    await this.transaction(async tx => {
      await this.owned(tx, job);
      await tx.query('UPDATE sessions SET workspace_initialized=true WHERE id=$1', [job.session_id]);
    });
  }
  async heartbeat(job: Job, leaseMs: number): Promise<string> {
    return this.transaction(async tx => {
      await this.owned(tx, job);
      await tx.query("UPDATE sessions SET lease_expires=clock_timestamp()+$2*interval '1 millisecond' WHERE id=$1", [job.session_id, leaseMs]);
      return (await tx.query('SELECT status FROM runs WHERE id=$1', [job.id])).rows[0].status;
    });
  }
  async startTool(job: Job, call: string, name: string, args: unknown, checkpoint: Checkpoint) {
    await this.transaction(async tx => {
      await this.owned(tx, job);
      const run = (await tx.query('SELECT status FROM runs WHERE id=$1', [job.id])).rows[0];
      if (run.status !== 'running') throw new Error('Run is stopping');
      await tx.query('UPDATE sessions SET checkpoint=$2 WHERE id=$1', [job.session_id, JSON.stringify(checkpoint)]);
      await tx.query('INSERT INTO tool_calls(run_id,call_id,tenant_id,attempt,name,args) VALUES($1,$2,$3,$4,$5,$6)', [job.id, call, job.tenant_id, job.attempt, name, JSON.stringify(args)]);
      await this.event(tx, job.tenant_id, job.session_id, 'tool.requested', job.id, { call_id: call, name, args });
    });
  }
  async endTool(job: Job, call: string, result: ToolResult) {
    await this.transaction(async tx => {
      await this.owned(tx, job);
      await tx.query("UPDATE tool_calls SET status='completed',result=$4,ended_at=now() WHERE run_id=$1 AND attempt=$2 AND call_id=$3", [job.id, job.attempt, call, JSON.stringify(result)]);
      await this.event(tx, job.tenant_id, job.session_id, 'tool.completed', job.id, { call_id: call, ...result });
    });
  }
  async finish(job: Job, status: 'completed' | 'failed' | 'cancelled', checkpoint: Checkpoint | null, output: string, error: unknown, usage: unknown, artifacts: { id: string; path: string; sha256: string; size: number }[] = []) {
    await this.transaction(async tx => {
      await this.owned(tx, job);
      const current = (await tx.query('SELECT status FROM runs WHERE id=$1', [job.id])).rows[0].status;
      if (current === 'cancelling') status = 'cancelled';
      if (checkpoint && status === 'completed') await tx.query('UPDATE sessions SET checkpoint=$2 WHERE id=$1', [job.session_id, JSON.stringify(checkpoint)]);
      else await tx.query('UPDATE sessions SET checkpoint=$2 WHERE id=$1', [job.session_id, job.checkpoint]);
      if (status === 'completed') for (const artifact of artifacts) {
        await tx.query('INSERT INTO artifacts(id,tenant_id,session_id,run_id,path,sha256,size) VALUES($1,$2,$3,$4,$5,$6,$7)', [artifact.id, job.tenant_id, job.session_id, job.id, artifact.path, artifact.sha256, artifact.size]);
        await this.event(tx, job.tenant_id, job.session_id, 'artifact.published', job.id, artifact);
      }
      if (output && status === 'completed') await this.event(tx, job.tenant_id, job.session_id, 'message.completed', job.id, { text: output });
      await tx.query("UPDATE tool_calls SET status='unknown' WHERE run_id=$1 AND status='running'", [job.id]);
      await tx.query('UPDATE runs SET status=$2,output_text=$3,error=$4,usage=$5,ended_at=now() WHERE id=$1', [job.id, status, status === 'completed' ? output : null, status === 'cancelled' ? null : error ? JSON.stringify(error) : null, usage ? JSON.stringify(usage) : null]);
      await this.event(tx, job.tenant_id, job.session_id, 'run.' + status, job.id, { error: error ?? null });
      await tx.query('UPDATE sessions SET lease_owner=NULL,lease_expires=NULL WHERE id=$1', [job.session_id]);
    });
  }
  async hasTools(job: Job) {
    return !!(await this.pool.query('SELECT 1 FROM tool_calls WHERE run_id=$1 AND tenant_id=$2 LIMIT 1', [job.id, job.tenant_id])).rowCount;
  }
  async interrupt(job: Job, message: string) {
    await this.transaction(async tx => {
      await this.owned(tx, job);
      const run = (await tx.query('SELECT status FROM runs WHERE id=$1', [job.id])).rows[0];
      const status = run.status === 'cancelling' ? 'cancelled' : 'waiting';
      const error = { code: 'recovery_required', message };
      await tx.query("UPDATE runs SET status=$2,error=$3,ended_at=CASE WHEN $2='cancelled' THEN now() ELSE NULL END WHERE id=$1", [job.id, status, JSON.stringify(error)]);
      await tx.query("UPDATE tool_calls SET status='unknown' WHERE run_id=$1 AND status='running'", [job.id]);
      if (status === 'cancelled') await tx.query('UPDATE sessions SET checkpoint=$2 WHERE id=$1', [job.session_id, job.checkpoint]);
      await this.event(tx, job.tenant_id, job.session_id, 'run.' + status, job.id, { reason: 'recovery_required', error });
      await tx.query('UPDATE sessions SET epoch=epoch+1,lease_owner=NULL,lease_expires=NULL WHERE id=$1', [job.session_id]);
    });
  }
  async cleanupArchived(cleanup: (id: string) => Promise<void>) {
    const rows = (await this.pool.query("SELECT id FROM sessions WHERE status='archived' AND workspace_cleaned=false LIMIT 20")).rows;
    for (const row of rows) {
      await cleanup(row.id);
      await this.pool.query("UPDATE sessions SET workspace_cleaned=true WHERE id=$1 AND status='archived'", [row.id]);
    }
  }
  async recoverExpired(stopGeneration: (session: string, epoch: number) => Promise<void>) {
    return this.transaction(async tx => {
      const sessions = (await tx.query("SELECT * FROM sessions WHERE lease_expires<=now() AND lease_owner IS NOT NULL FOR UPDATE SKIP LOCKED")).rows;
      for (const session of sessions) {
        // The row lock prevents handoff while the old executor is being stopped.
        // A cleanup failure rolls back recovery and leaves the session fenced.
        await stopGeneration(session.id, Number(session.epoch));
        const runs = (await tx.query("SELECT * FROM runs WHERE session_id=$1 AND status IN ('running','cancelling') FOR UPDATE", [session.id])).rows;
        for (const run of runs) {
          const status = run.status === 'cancelling' ? 'cancelled' : 'waiting';
          const error = { code: 'recovery_required', message: 'Worker ownership expired. Explicit recovery or cancellation is required.' };
          await tx.query('UPDATE runs SET status=$2,error=$3,ended_at=CASE WHEN $2=\'cancelled\' THEN now() ELSE NULL END WHERE id=$1', [run.id, status, JSON.stringify(error)]);
          await tx.query("UPDATE tool_calls SET status='unknown' WHERE run_id=$1 AND status='running'", [run.id]);
          if (status === 'cancelled') await tx.query('UPDATE sessions SET checkpoint=$2 WHERE id=$1', [session.id, run.base_checkpoint]);
          await this.event(tx, session.tenant_id, session.id, 'run.' + status, run.id, { reason: 'recovery_required' });
        }
        await tx.query('UPDATE sessions SET epoch=epoch+1,lease_owner=NULL,lease_expires=NULL WHERE id=$1', [session.id]);
      }
      return sessions.length;
    });
  }
}
