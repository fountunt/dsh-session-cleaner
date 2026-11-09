// dsh-session-cleaner — delete sessions from a running DeepSeek Harness web runtime.
//
// Registers one HTTP route on the webServer service:
//   POST /api-ext/session.delete   body: { "sessionId": "session-..." }
//
// Deletion is safe and irreversible:
//   1. refuses sessions whose agent is running a turn;
//   2. unloads an idle agent's fiber first, so its persistence writer closes
//      before the artifacts disappear;
//   3. detaches the session from the live SessionStore (the in-memory registry
//      that keeps "ghost" rows visible after the files are gone);
//   4. removes the session from every workspace record;
//   5. deletes the on-disk artifact directory under $DSH_HOME/sessions.
//
// The response mirrors the host's JSON envelope:
//   { "ok": true,  "value": { "detached": true, "agentDisposed": true,
//                             "workspaces": 1, "files": 1 } }
//   { "ok": false, "error": { "code": "refused", "message": "..." } }
//
// This file targets DeepSeek Harness >= 0.2.2: `ctx.sessions` exposes
// `get()`/`list()` around the store, `ctx.workspaceRegistry` entities keep
// `sessionIds` + `detachSession()`, and `ctx.sessionPersistence.stat()` reports
// the exact artifact location. Every access is guarded, so an older host
// degrades to the filesystem scan instead of failing to load.

import { rm, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const name = "dsh-session-cleaner";

/** `webServer` is required; the other services are resolved optionally. */
export const inject = ["webServer"];

const ROUTE_PATH = "/api-ext/session.delete";
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const BODY_LIMIT = 1 << 20;

function sessionsRoot() {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions");
}

async function readJsonBody(req, limit = BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, body, status = 200) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

/**
 * The route mutates state, so refuse a cross-site browser POST. Requests
 * without an Origin header (curl, the harness CLI) are allowed.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin === "") return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Whether the host still holds this session in its live store. */
function hasLiveEntry(sessions, sessionId) {
  const store = sessions?.store;
  return store?.has?.(sessionId) === true;
}

/**
 * Detach the session from the live SessionStore entry registry, when present.
 * `sessions.store` is the store's own `Map` of entries; each entry exposes the
 * detach disposer returned by `SessionStore.enter()`. Guarded for hosts whose
 * store is not reachable.
 */
function detachLiveStore(sessions, sessionId) {
  const entry = sessions?.store?.get?.(sessionId);
  if (entry?.detach === undefined) return false;
  entry.detach();
  return true;
}

/** Remove the session id from every workspace record that lists it. */
async function detachWorkspaces(workspaceRegistry, sessionId) {
  if (workspaceRegistry?.list === undefined) return 0;
  let removed = 0;
  for (const ws of workspaceRegistry.list()) {
    // `sessionIds` is a getter on the workspace entity (already filtered to
    // sessions whose stored cwd matches the workspace path).
    const ids = ws?.sessionIds;
    if (!Array.isArray(ids) || !ids.includes(sessionId)) continue;
    await ws.detachSession?.(sessionId);
    removed += 1;
  }
  return removed;
}

/** Candidate artifact directories for one session, exact location first. */
async function artifactDirs(sessionId, persistence) {
  const dirs = new Set();
  try {
    const snapshot = await persistence?.stat?.(sessionId);
    const file = snapshot?.location?.path;
    // The reported path is the log file; the session owns its directory.
    if (typeof file === "string" && file !== "") {
      const dir = dirname(file);
      if (basename(dir) === sessionId) dirs.add(dir);
    }
  } catch {
    // persistence unavailable — fall back to the directory scan
  }
  let projects;
  try {
    projects = await readdir(sessionsRoot(), { withFileTypes: true });
  } catch {
    return [...dirs]; // root absent — only the exact location may exist
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    dirs.add(join(sessionsRoot(), project.name, sessionId));
  }
  return [...dirs];
}

/** Delete the session's artifact directory under every project dir. */
async function removeArtifacts(sessionId, persistence) {
  let removed = 0;
  for (const dir of await artifactDirs(sessionId, persistence)) {
    // Never recurse into something that is not the session's own directory.
    if (basename(dir) !== sessionId) continue;
    try {
      await readdir(dir);
    } catch {
      continue; // absent (or already removed) — not this session's directory
    }
    try {
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // a locked artifact stays behind; the caller reports the count
    }
  }
  return removed;
}

/**
 * Dispose an idle agent's fiber (the Agent exposes its owning Context; the
 * fiber's `_unload()` runs the agent-loop effect cleanup in reverse order,
 * including the ordered teardown of the agent, its persistence writer, and its
 * session attachment).
 * @returns true when the fiber was unloaded (or the agent exposed no fiber).
 */
async function disposeAgentFiber(agent) {
  const fiber = agent?.ctx?.fiber;
  if (fiber?._unload === undefined) return false;
  try {
    await fiber._unload();
    return true;
  } catch {
    return false;
  }
}

export function apply(ctx) {
  const webServer = ctx.webServer;
  if (webServer === undefined) throw new Error("dsh-session-cleaner needs the webServer service");

  const optional = (service) => (typeof ctx.get === "function" ? ctx.get(service) : ctx[service]);

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: ROUTE_PATH,
        handler: async (req, res) => {
          if (req.method !== "POST") {
            res.writeHead(405, { allow: "POST" });
            res.end();
            return;
          }
          if (!sameOrigin(req)) {
            sendJson(res, {
              ok: false,
              error: { code: "forbidden", message: "cross-origin requests are refused" },
            }, 403);
            return;
          }

          let payload;
          try {
            payload = await readJsonBody(req);
          } catch (error) {
            sendJson(res, {
              ok: false,
              error: { code: "bad-request", message: String(error?.message ?? error) },
            });
            return;
          }
          const sessionId = payload?.sessionId;
          if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
            sendJson(res, {
              ok: false,
              error: { code: "bad-request", message: "missing or invalid sessionId" },
            });
            return;
          }

          const sessions = optional("sessions");
          const agents = optional("agents");
          const workspaceRegistry = optional("workspaceRegistry");
          const persistence = optional("sessionPersistence");

          try {
            const wasLive = hasLiveEntry(sessions, sessionId);
            const agent = agents?.get?.(sessionId);
            if (agent?.status === "running") {
              sendJson(res, {
                ok: false,
                error: {
                  code: "refused",
                  message: `session "${sessionId}" is running; stop it before deleting`,
                },
              });
              return;
            }
            if (agent !== undefined) {
              const disposed = await disposeAgentFiber(agent);
              if (!disposed) {
                sendJson(res, {
                  ok: false,
                  error: {
                    code: "refused",
                    message: `session "${sessionId}" has an attached agent that could not be stopped`,
                  },
                });
                return;
              }
            }

            // Detach after the agent is gone: the store entry is what makes the
            // sidebar row survive the deleted files.
            const detachCalled = detachLiveStore(sessions, sessionId);
            const detached = detachCalled || (wasLive && !hasLiveEntry(sessions, sessionId));

            const workspaces = await detachWorkspaces(workspaceRegistry, sessionId);
            const files = await removeArtifacts(sessionId, persistence);

            if (!wasLive && workspaces === 0 && files === 0) {
              sendJson(
                res,
                {
                  ok: false,
                  error: { code: "not-found", message: `no session "${sessionId}" found` },
                },
                404,
              );
              return;
            }

            ctx.logger?.info?.(
              `dsh-session-cleaner: deleted ${sessionId} (agent=${agent !== undefined}, workspaces=${workspaces}, files=${files})`,
            );

            sendJson(res, {
              ok: true,
              value: { detached, agentDisposed: agent !== undefined, workspaces, files },
            });
          } catch (error) {
            ctx.logger?.warn?.(
              `dsh-session-cleaner: delete ${sessionId} failed: ${String(error?.message ?? error)}`,
            );
            sendJson(res, {
              ok: false,
              error: { code: "internal", message: String(error?.message ?? error) },
            });
          }
        },
      }),
    "session-cleaner: delete route",
  );
}

// Internals exported for unit tests (not part of the public surface).
export {
  artifactDirs,
  detachLiveStore,
  detachWorkspaces,
  disposeAgentFiber,
  removeArtifacts,
  sameOrigin,
};
