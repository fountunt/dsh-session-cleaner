// Unit tests for the dsh-session-cleaner deletion internals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  artifactDirs,
  detachLiveStore,
  detachWorkspaces,
  disposeAgentFiber,
  removeArtifacts,
  sameOrigin,
} from "../lib/index.js";

test("disposeAgentFiber unloads the agent fiber (sync and async)", async () => {
  let syncUnloaded = false;
  const syncAgent = { ctx: { fiber: { _unload: () => { syncUnloaded = true; } } } };
  assert.equal(await disposeAgentFiber(syncAgent), true);
  assert.equal(syncUnloaded, true);

  let asyncUnloaded = false;
  const asyncAgent = { ctx: { fiber: { _unload: async () => { asyncUnloaded = true; } } } };
  assert.equal(await disposeAgentFiber(asyncAgent), true);
  assert.equal(asyncUnloaded, true);

  // missing ctx / fiber / _unload -> false (caller refuses deletion)
  assert.equal(await disposeAgentFiber({}), false);
  assert.equal(await disposeAgentFiber({ ctx: {} }), false);
  assert.equal(await disposeAgentFiber({ ctx: { fiber: {} } }), false);
  // throwing _unload -> false
  assert.equal(
    await disposeAgentFiber({ ctx: { fiber: { _unload: () => { throw new Error("boom"); } } } }),
    false,
  );
});

test("detachLiveStore calls the entry detach disposer", () => {
  let detached = false;
  const sessions = {
    store: new Map([["session-a", { detach: () => { detached = true; } }]]),
  };
  assert.equal(detachLiveStore(sessions, "session-a"), true);
  assert.equal(detached, true);
  assert.equal(detachLiveStore(sessions, "session-missing"), false);
  assert.equal(detachLiveStore(undefined, "session-a"), false);
  assert.equal(detachLiveStore({}, "session-a"), false);
});

test("detachWorkspaces uses the sessionIds getter and detachSession", async () => {
  const calls = [];
  const ws = {
    get sessionIds() {
      return ["session-a", "session-b"];
    },
    async detachSession(id) {
      calls.push(id);
    },
  };
  const registry = { list: () => [ws] };
  assert.equal(await detachWorkspaces(registry, "session-a"), 1);
  assert.deepEqual(calls, ["session-a"]);
  // unknown session -> untouched
  assert.equal(await detachWorkspaces(registry, "session-x"), 0);
  assert.deepEqual(calls, ["session-a"]);
  // missing registry -> 0
  assert.equal(await detachWorkspaces(undefined, "session-a"), 0);
});

test("artifactDirs prefers the persistence location and scans the session root", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-cleaner-test-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    await mkdir(join(root, "sessions", "--test--", "session-a"), { recursive: true });
    const persistence = {
      async stat(id) {
        if (id !== "session-a") return undefined;
        return {
          header: { id },
          revision: "r1",
          location: {
            kind: "jsonl",
            path: join(root, "sessions", "--other--", "session-a", "session.v4.jsonl.zstd"),
          },
        };
      },
    };
    const dirs = await artifactDirs("session-a", persistence);
    assert.equal(dirs.length, 2);
    assert.ok(dirs.includes(join(root, "sessions", "--test--", "session-a")));
    assert.ok(dirs.includes(join(root, "sessions", "--other--", "session-a")));
    // a stat failure must not break the scan
    const failing = { stat: async () => { throw new Error("boom"); } };
    const fallback = await artifactDirs("session-a", failing);
    assert.deepEqual(fallback, [join(root, "sessions", "--test--", "session-a")]);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    await rm(root, { recursive: true, force: true });
  }
});

test("removeArtifacts deletes only the matching session directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-cleaner-test-"));
  const proj = join(root, "sessions", "--test--");
  await mkdir(join(proj, "session-keep"), { recursive: true });
  await mkdir(join(proj, "session-delete"), { recursive: true });
  await writeFile(join(proj, "session-delete", "session.v4.jsonl.zstd"), "x");

  // point the module at the temp root
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = root;

  try {
    assert.equal(await removeArtifacts("session-delete"), 1);
    assert.equal(await removeArtifacts("session-delete"), 0); // idempotent
    const rest = await readdir(proj);
    assert.deepEqual(rest, ["session-keep"]);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    await rm(root, { recursive: true, force: true });
  }
});

test("removeArtifacts never recurses outside the session's own directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-cleaner-test-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    // A bogus persistence location pointing at a directory whose basename is
    // not the session id must be ignored.
    const victim = join(root, "sessions", "--test--", "session-victim");
    await mkdir(victim, { recursive: true });
    const persistence = {
      async stat() {
        return { location: { kind: "jsonl", path: join(victim, "session.v4.jsonl.zstd") } };
      },
    };
    assert.equal(await removeArtifacts("session-other", persistence), 0);
    assert.deepEqual(await readdir(join(root, "sessions", "--test--")), ["session-victim"]);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    await rm(root, { recursive: true, force: true });
  }
});

test("sameOrigin accepts same-host and header-less requests, rejects cross-site", () => {
  assert.equal(sameOrigin({ headers: { host: "127.0.0.1:3080" } }), true);
  assert.equal(
    sameOrigin({ headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" } }),
    true,
  );
  assert.equal(
    sameOrigin({ headers: { host: "127.0.0.1:3080", origin: "https://evil.example" } }),
    false,
  );
  assert.equal(sameOrigin({ headers: { host: "127.0.0.1:3080", origin: "not a url" } }), false);
});
