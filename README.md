# dsh-session-cleaner

[English](README.md) | [中文](README.zh.md)

Delete DeepSeek Harness sessions from a **running** web runtime — files, live
store, and workspace records — without restarting `dsh web`.

The official web API only offers `workspace.archiveSession` (hide); there is no
`session.delete`. This bundle closes that gap.

## Install

```sh
dsh plugin --profile web add dsh-session-cleaner            # from npm
dsh plugin --profile web add github:fountunt/dsh-session-cleaner   # from git

# or from a local checkout
dsh plugin --profile web add file:/path/to/dsh-session-cleaner
```

Then restart `dsh web` (a running instance does not hot-load new bundles).

## Usage

### Web UI (v0.2.1+)

The client half adds a **🗑 "Delete session" item** at the bottom of the
sidebar session row ⋮ menu — the item is skipped when the row title is
ambiguous.

> Note: the v0.2.0 delete button in the conversation **header action area**
> was removed — session deletion belongs in the sidebar session list only,
> not mixed into the header permission/model controls.

Click, confirm, and the session is deleted and the sidebar refreshes. The
item is disabled while the session is running, and sessions with an
attached agent are refused by the server — the current conversation can never
be deleted.

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

Response envelope (mirrors the host's RPC style):

```json
{ "ok": true, "value": { "detached": true, "workspaces": 1, "files": 1 } }
{ "ok": false, "error": { "code": "refused", "message": "..." } }
```

- `detached` — the session was removed from the in-memory live store (this is
  what makes it disappear from the sidebar immediately, without a restart).
- `workspaces` — how many workspace records the session was detached from.
- `files` — how many on-disk artifact directories were removed.

## Safety

- Sessions with an attached agent (running or idle) are **refused** — the
  current conversation can never be deleted through this endpoint.
- Deletion is irreversible: artifacts, workspace membership, and the live
  entry are all removed. The session-projection cache may keep a harmless
  stale row until the next restart.

## How it works

`session.list` is served from the live `SessionStore` plus a disk scan. Cold
sessions get *prepared into the live store* while being listed, so after their
files are deleted they linger as "ghosts" until the server restarts. This
plugin removes the live entry (the store's own detach path), detaches the
session from workspace records, and deletes the on-disk artifact directory —
so the row disappears immediately and permanently.

## Development

```sh
pnpm install        # peer: @deepseek-ai/cordis
node --test test/   # unit tests
```

## License

MIT
