# dsh-session-cleaner

[English](README.md) | [中文](README.zh.md)

Delete DeepSeek Harness sessions from a **running** web runtime — files, live
store, and workspace records — without restarting the host.

The official web API only offers `workspace.archiveSession` (hide); there is no
`session.delete`. This bundle closes that gap.

## Compatibility

| Plugin | DeepSeek Harness |
| --- | --- |
| 2.0.0 | 0.2.2 and newer (built and tested on 0.2.2-rc.1) |
| 1.0.2 and older | 0.1.x – 0.2.1 |

Version 2.0.0 targets the current plugin API: the session-row menu is now a
first-class slot (`sidebar.workspaces.session.menu.item`), so the client half no
longer scrapes the DOM or calls the old `session.list` RPC envelope.

## Install

```sh
dsh plugin --profile <profile> add dsh-session-cleaner            # from npm
dsh plugin --profile <profile> add github:fountunt/dsh-session-cleaner   # from git

# or from a local checkout
dsh plugin --profile <profile> add file:/path/to/dsh-session-cleaner
```

You can also install the package directory from the Plugin Manager. Restart the
host afterwards; a running instance does not hot-load new host bundles.

## Usage

### Web UI

The client half adds a **🗑 "Delete session" item** at the bottom of the
sidebar session row ⋮ menu. The item is greyed out when the session is running
or when its conversation is open in the main view.

Click, confirm, and the session is deleted and the sidebar refreshes. Sessions
opened earlier in the UI (idle agents) are stopped first, then deleted.

### API

The plugin registers one route on the web server:

```http
POST /api-ext/session.delete
Content-Type: application/json

{ "sessionId": "session-1bb8d361-ea6b-4b92-bab2-c858c92e8822" }
```

Same-origin calls work from the browser console of the harness page:

```js
await fetch("/api-ext/session.delete", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sessionId: "session-1bb8d361-ea6b-4b92-bab2-c858c92e8822" }),
}).then(r => r.json());
```

Response envelope:

```json
{ "ok": true, "value": { "detached": true, "agentDisposed": false, "workspaces": 1, "files": 1 } }
{ "ok": false, "error": { "code": "refused", "message": "..." } }
{ "ok": false, "error": { "code": "not-found", "message": "..." } }
```

- `detached` — the session was live and is no longer in the in-memory store
  (this is what makes the row disappear immediately, without a restart).
- `agentDisposed` — an idle agent was unloaded before the files were removed.
- `workspaces` — how many workspace records the session was detached from.
- `files` — how many on-disk artifact directories were removed.

Requests carrying an `Origin` header for another host are refused with
`403 forbidden`; header-less calls (curl, the CLI) are accepted.

## Safety

- A session whose agent is **running** is **refused** — a turn is never torn
  down. The UI keeps the item disabled for that row.
- An idle agent (the session was opened in the UI) is unloaded through its own
  fiber first, so its persistence writer closes before the artifacts vanish.
- Deletion is irreversible: artifacts, workspace membership, and the live entry
  are all removed. The derived projection cache
  (`$DSH_HOME/storages/session_projcache`) may keep a harmless stale row; it is
  only consulted for a session whose log still exists.

## How it works

`session.list` is served from the live `SessionStore` plus a disk scan, so a
deleted log would otherwise linger as a "ghost" row until the host restarts.
The host half:

1. unloads an idle agent's fiber (ordered teardown of the agent, its persistence
   writer, and its session attachment);
2. detaches the session from the live `SessionStore` (the store's own detach
   entry);
3. removes the session id from every workspace record (`detachSession`);
4. deletes the session's artifact directory — resolved from
   `ctx.sessionPersistence.stat(id).location.path` when available, and from a
   `$DSH_HOME/sessions/*/<sessionId>` scan as a fallback.

## Development

```sh
pnpm install                     # peer: @deepseek-ai/cordis ~4.1
node --test "test/*.test.js"     # unit tests
```

## License

MIT
