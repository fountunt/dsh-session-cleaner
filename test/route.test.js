// Route-level tests: drive the registered handler with fake Node req/res objects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { apply } from "../lib/index.js";

function fakeRequest({ method = "POST", host = "127.0.0.1:3080", origin, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)];
  const stream = Readable.from(chunks);
  stream.method = method;
  stream.headers = { host, ...(origin === undefined ? {} : { origin }) };
  return stream;
}

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(text = "") {
      this.body = text;
    },
  };
}

/** Register the plugin's route and return its handler plus the fake services. */
function mount(services = {}) {
  let route;
  const ctx = {
    webServer: { register: (value) => ((route = value), () => {}) },
    effect: (factory) => {
      factory();
      return () => {};
    },
    get: (name) => services[name],
    logger: { info() {}, warn() {} },
  };
  apply(ctx);
  assert.equal(route.path, "/api-ext/session.delete");
  assert.equal(route.kind, "exact");
  return route.handler;
}

async function call(handler, request) {
  const response = fakeResponse();
  await handler(request, response);
  return { status: response.status, body: response.body === "" ? undefined : JSON.parse(response.body) };
}

test("rejects non-POST methods with 405", async () => {
  const handler = mount();
  const { status } = await call(handler, fakeRequest({ method: "GET" }));
  assert.equal(status, 405);
});

test("rejects a cross-origin POST with 403", async () => {
  const handler = mount();
  const { status, body } = await call(
    handler,
    fakeRequest({ origin: "https://evil.example", body: '{"sessionId":"session-a"}' }),
  );
  assert.equal(status, 403);
  assert.equal(body.error.code, "forbidden");
});

test("rejects a malformed session id with a bad-request result", async () => {
  const handler = mount();
  for (const body of ['{"sessionId":"../etc"}', "{}", "not json"]) {
    const { body: result } = await call(handler, fakeRequest({ body }));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "bad-request");
  }
});

test("reports not-found when no live entry, workspace, or artifact matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-cleaner-route-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    await mkdir(join(root, "sessions", "--test--", "session-other"), { recursive: true });
    const handler = mount({
      sessions: { store: new Map() },
      workspaceRegistry: { list: () => [] },
    });
    const { status, body } = await call(handler, fakeRequest({ body: '{"sessionId":"session-missing"}' }));
    assert.equal(status, 404);
    assert.equal(body.error.code, "not-found");
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    await rm(root, { recursive: true, force: true });
  }
});

test("deletes live state, workspace record, and artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-cleaner-route-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    const sessionDir = join(root, "sessions", "--test--", "session-a");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.v4.jsonl.zstd"), "x");

    let detached = false;
    const store = new Map([["session-a", { detach: () => (detached = true) }]]);
    const detachCalls = [];
    const handler = mount({
      sessions: { store },
      workspaceRegistry: {
        list: () => [
          {
            get sessionIds() {
              return ["session-a"];
            },
            async detachSession(id) {
              detachCalls.push(id);
            },
          },
        ],
      },
      sessionPersistence: {
        async stat() {
          return { location: { kind: "jsonl", path: join(sessionDir, "session.v4.jsonl.zstd") } };
        },
      },
    });

    const { status, body } = await call(handler, fakeRequest({ body: '{"sessionId":"session-a"}' }));
    assert.equal(status, 200);
    assert.deepEqual(body.value, { detached: true, agentDisposed: false, workspaces: 1, files: 1 });
    assert.equal(detached, true);
    assert.deepEqual(detachCalls, ["session-a"]);
    assert.deepEqual(await readdir(join(root, "sessions", "--test--")), []);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a running session before touching anything", async () => {
  let detached = false;
  const handler = mount({
    sessions: { store: new Map([["session-a", { detach: () => (detached = true) }]]) },
    agents: { get: () => ({ status: "running" }) },
  });
  const { body } = await call(handler, fakeRequest({ body: '{"sessionId":"session-a"}' }));
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "refused");
  assert.equal(detached, false);
});

test("refuses an idle agent whose fiber cannot be unloaded", async () => {
  const handler = mount({
    sessions: { store: new Map([["session-a", { detach: () => {} }]]) },
    agents: { get: () => ({ status: "inactive", ctx: { fiber: {} } }) },
  });
  const { body } = await call(handler, fakeRequest({ body: '{"sessionId":"session-a"}' }));
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "refused");
});

test("unloads an idle agent's fiber before deleting", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-cleaner-route-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    const sessionDir = join(root, "sessions", "--test--", "session-a");
    await mkdir(sessionDir, { recursive: true });
    let unloaded = false;
    const handler = mount({
      sessions: { store: new Map([["session-a", { detach: () => {} }]]) },
      agents: {
        get: () => ({
          status: "inactive",
          ctx: { fiber: { _unload: async () => { unloaded = true; } } },
        }),
      },
    });
    const { status, body } = await call(handler, fakeRequest({ body: '{"sessionId":"session-a"}' }));
    assert.equal(status, 200);
    assert.equal(unloaded, true);
    assert.equal(body.value.agentDisposed, true);
    assert.equal(body.value.files, 1);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    await rm(root, { recursive: true, force: true });
  }
});
