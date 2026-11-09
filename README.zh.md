# dsh-session-cleaner

[English](README.md) | [中文](README.zh.md)

从**运行中的** DeepSeek Harness Web 运行时删除会话——文件、内存 live store、工作区记录，无需重启宿主。

官方 Web API 只有 `workspace.archiveSession`（隐藏），没有 `session.delete`。本 bundle 补上这个缺口。

## 兼容性

| 插件版本 | DeepSeek Harness |
| --- | --- |
| 2.0.0 | 0.2.2 及更新版本（基于 0.2.2-rc.1 开发与验证） |
| 1.0.2 及更早 | 0.1.x – 0.2.1 |

2.0.0 适配当前插件 API：会话行菜单已经是官方 slot（`sidebar.workspaces.session.menu.item`），客户端不再抓取 DOM，也不再使用旧的 `session.list` RPC 报文格式。

## 安装

```sh
dsh plugin --profile <profile> add dsh-session-cleaner            # 从 npm
dsh plugin --profile <profile> add github:fountunt/dsh-session-cleaner   # 从 git

# 或使用本地 checkout
dsh plugin --profile <profile> add file:/path/to/dsh-session-cleaner
```

也可以在「插件管理」里直接安装本地包目录。安装后需重启宿主；运行中的实例不会热加载新的宿主 bundle。

## 使用

### Web UI

客户端在侧边栏会话行的 **⋮ 菜单底部**添加 **🗑「删除此会话」**。会话正在运行、或该对话正在主视图打开时，菜单项为灰色禁用状态。

点击、确认后，会话被删除并刷新侧边栏。之前在 UI 中打开过的会话（挂着空闲 agent）会先被停掉，再删除。

### API

插件在 Web 服务器上注册一个路由：

```http
POST /api-ext/session.delete
Content-Type: application/json

{ "sessionId": "session-1bb8d361-ea6b-4b92-bab2-c858c92e8822" }
```

同源调用可直接在 Harness 页面的浏览器控制台执行：

```js
await fetch("/api-ext/session.delete", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sessionId: "session-1bb8d361-ea6b-4b92-bab2-c858c92e8822" }),
}).then(r => r.json());
```

响应格式：

```json
{ "ok": true, "value": { "detached": true, "agentDisposed": false, "workspaces": 1, "files": 1 } }
{ "ok": false, "error": { "code": "refused", "message": "..." } }
{ "ok": false, "error": { "code": "not-found", "message": "..." } }
```

- `detached` — 会话原本在 live store 中，现已被移除（这就是它立刻从侧边栏消失、无需重启的原因）。
- `agentDisposed` — 删除文件前卸载了一个空闲 agent。
- `workspaces` — 从多少个工作区记录中摘除了该会话。
- `files` — 删除了多少个磁盘上的会话目录。

带有其它宿主 `Origin` 头的请求会被拒绝（`403 forbidden`）；不带该头的调用（curl、CLI）照常接受。

## 安全性

- agent 正在**运行**的会话会被**拒绝**——绝不打断正在执行的回合，UI 中该行菜单项保持禁用。
- 空闲 agent（会话在 UI 中打开过）会先通过它自己的 fiber 卸载，保证持久化写入端在文件消失前关闭。
- 删除不可逆：文件、工作区成员关系、live 条目都会被移除。派生投影缓存（`$DSH_HOME/storages/session_projcache`）可能保留一条无害的过期记录，它只会被仍存在日志的会话读取。

## 工作原理

`session.list` 由 live `SessionStore` 加磁盘扫描共同提供，所以仅删除日志会让该行以「幽灵」形式残留到宿主重启。宿主端依次：

1. 卸载空闲 agent 的 fiber（有序拆除 agent、持久化写入端与会话挂载）；
2. 将会话从 live `SessionStore` 中 detach（走 store 自身的 detach 入口）；
3. 从每个工作区记录中摘除会话 id（`detachSession`）；
4. 删除会话的磁盘目录——优先使用 `ctx.sessionPersistence.stat(id).location.path`，取不到时回退到 `$DSH_HOME/sessions/*/<sessionId>` 扫描。

## 开发

```sh
pnpm install                     # peer: @deepseek-ai/cordis ~4.1
node --test "test/*.test.js"     # 单元测试
```

## 许可证

MIT
