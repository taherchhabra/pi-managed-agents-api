import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { agentConfig, fixture, tokenA, tokenB } from "./fixture.js";
import { buildApi } from "../src/api.js";

test("signing out terminates an already-open console event stream", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { session } = await f.createSession();
  const origin = await f.app.listen({ host: "127.0.0.1", port: 0 });
  const headers = { origin, "x-pi-console": "1" };
  const login = await fetch(origin + "/console/login", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ token: tokenA }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const response = await fetch(
    `${origin}/v1/sessions/${session.id}/events?stream=true`,
    { headers: { cookie }, signal: AbortSignal.timeout(3000) },
  );
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  assert.equal(
    (
      await fetch(origin + "/console/logout", {
        method: "POST",
        headers: { ...headers, cookie },
      })
    ).status,
    200,
  );
  while (!(await reader.read()).done) {
    /* drain events admitted before sign-out */
  }
  reader.releaseLock();
});

test("console sign-in protects cookies, rejects cross-origin writes, scopes tenants, and revokes sign-out", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const headers = { origin: "http://localhost:80", "x-pi-console": "1" };
  for (const bad of [
    {},
    { ...headers, origin: "https://other.example" },
    { origin: headers.origin },
  ]) {
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/console/login",
          headers: bad,
          payload: { token: tokenA },
        })
      ).statusCode,
      403,
    );
  }
  const login = await f.app.inject({
    method: "POST",
    url: "/console/login",
    headers,
    payload: { token: tokenA },
  });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.json().tenant, "tenant-a");
  assert(!login.body.includes(tokenA));
  const setCookie = String(login.headers["set-cookie"]);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=28800/);
  assert(!setCookie.includes(tokenA));
  const cookie = setCookie.split(";")[0]!;
  const create = { name: "Console agent", config: agentConfig };
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/agents",
        headers: { cookie, "idempotency-key": "console-create" },
        payload: create,
      })
    ).statusCode,
    403,
  );
  const saved = await f.app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: { ...headers, cookie, "idempotency-key": "console-create" },
    payload: create,
  });
  assert.equal(saved.statusCode, 201, saved.body);
  assert.equal(
    (await f.app.inject({ url: "/v1/agents", headers: { cookie } })).json().data
      .length,
    1,
  );
  assert.equal(
    (await f.request("GET", "/v1/agents", undefined, undefined, tokenB)).json()
      .data.length,
    0,
  );
  assert.equal(
    (
      await f.app.inject({
        url: "/console/session",
        headers: { cookie, authorization: "Bearer invalid" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/console/logout",
        headers: { ...headers, cookie },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await f.app.inject({ url: "/console/session", headers: { cookie } }))
      .statusCode,
    401,
  );
  assert.equal(
    (await f.app.inject({ url: "/v1/capabilities" })).statusCode,
    401,
  );
  const caps = await f.request("GET", "/v1/capabilities");
  assert.equal(caps.statusCode, 200, caps.body);
  assert(
    caps
      .json()
      .providers.find((provider: any) => provider.id === "openrouter")
      .models.some((model: any) => model.id === "openai/gpt-4.1-mini"),
  );
  assert(!caps.body.includes(tokenA));
});

test("console read models preserve pinned versions, paginate runs, and enforce tenant boundaries", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { agent, session } = await f.createSession();
  await f.request("POST", `/v1/agents/${agent.id}/versions`, {
    ...agentConfig,
    instructions: "A newer definition",
  });
  const listed = (await f.request("GET", "/v1/agents")).json().data[0];
  assert.equal(listed.latest_version.version, 2);
  assert.equal(listed.session_count, 1);
  const snapshot = (
    await f.request("GET", `/v1/sessions/${session.id}`)
  ).json();
  assert.equal(snapshot.agent_version, 1);
  assert.equal(snapshot.config.instructions, agentConfig.instructions);
  assert.equal(snapshot.agent_name, "Test agent");
  assert.equal(snapshot.environment_type, "none");
  // Equal timestamps exercise the stable (created_at,id) pagination boundary.
  const ids = Array.from({ length: 102 }, () => "run_" + randomUUID()).sort();
  await f.pool.query(
    `INSERT INTO runs(id,tenant_id,session_id,input,created_at)
    SELECT unnest($1::text[]),'tenant-a',$2,'queued from console',now()`,
    [ids, session.id],
  );
  const first = (
    await f.request("GET", `/v1/sessions/${session.id}/runs`)
  ).json();
  assert.equal(first.data.length, 100);
  assert.equal(first.next_cursor, ids[99]);
  const next = (
    await f.request(
      "GET",
      `/v1/sessions/${session.id}/runs?after=${first.next_cursor}`,
    )
  ).json();
  assert.equal(next.data.length, 2);
  assert.equal(next.next_cursor, null);
  assert.deepEqual(
    [...first.data, ...next.data].map((run) => run.id),
    ids,
  );
  assert.equal(
    (
      await f.request(
        "GET",
        `/v1/sessions/${session.id}/runs`,
        undefined,
        undefined,
        tokenB,
      )
    ).statusCode,
    404,
  );
  const other = await f.createSession();
  assert.equal(
    (
      await f.request(
        "GET",
        `/v1/sessions/${other.session.id}/runs?after=${ids[0]}`,
      )
    ).statusCode,
    404,
  );
  const sessions = (await f.request("GET", "/v1/sessions")).json().data;
  const item = sessions.find((item: any) => item.id === session.id);
  assert.equal(item.agent_version, 1);
  assert.equal(item.pending_runs, 102);
  assert.equal(item.latest_run.id, ids.at(-1));
});

test("a configured HTTPS console origin produces secure cookies behind a TLS proxy", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const app = buildApi(f.store, f.artifacts, {
    apiKeys: { [tokenA]: "tenant-a" },
    sandboxImage: "test-image",
    consoleOrigin: "https://agents.example",
    providerKeys: { openrouter: "server-only-secret" },
  });
  t.after(() => app.close());
  const login = await app.inject({
    method: "POST",
    url: "/console/login",
    headers: { origin: "https://agents.example", "x-pi-console": "1" },
    payload: { token: tokenA },
  });
  assert.equal(login.statusCode, 200, login.body);
  assert.match(String(login.headers["set-cookie"]), /; Secure/);
  const rejected = await app.inject({
    method: "POST",
    url: "/console/login",
    headers: { origin: "http://localhost:80", "x-pi-console": "1" },
    payload: { token: tokenA },
  });
  assert.equal(rejected.statusCode, 403);
  const caps = await app.inject({
    url: "/v1/capabilities",
    headers: { authorization: "Bearer " + tokenA },
  });
  assert(
    caps.json().providers.find((provider: any) => provider.id === "openrouter")
      .configured,
  );
  assert(!caps.body.includes("server-only-secret"));
});
