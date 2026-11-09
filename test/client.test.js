// Unit tests for the client half: the sidebar ⋮ menu entry and its delete flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "client.js"), "utf8");

/** Load client.js into a fake browser page and return its module factory. */
function loadClient() {
  let registration;
  const appended = [];
  const fakeDocument = {
    documentElement: { lang: "en" },
    createElement: (tag) => ({ tag, textContent: "", remove() {} }),
    head: { appendChild: (node) => appended.push(node) },
  };
  const fakeWindow = { __ModuleLoader__: { load: (value) => (registration = value) } };
  const run = new Function("window", "document", "navigator", "console", source);
  run(fakeWindow, fakeDocument, { language: "en" }, console);
  assert.equal(registration.id, "dsh-session-cleaner");
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
  };
  return { exports: registration.factory(() => react), appended, win: fakeWindow };
}

/** A fake plugin context capturing the slot registration. */
function fakeCtx(overrides = {}) {
  const registrations = [];
  const locale = {
    bind: () => (key) => (key === "delete" ? "Delete session" : key),
    register: () => () => {},
  };
  return {
    registrations,
    ctx: {
      effect: (factory) => {
        factory();
        return () => {};
      },
      locale,
      slots: {
        inject: (_name, callback) => callback(),
        register: (options, component) => {
          registrations.push({ options, component });
          return () => {};
        },
      },
      sessions: { refresh: async () => {} },
      ...overrides,
    },
  };
}

test("client registers the delete item on the session menu slot", () => {
  const { exports } = loadClient();
  const { ctx, registrations } = fakeCtx();
  exports.apply(ctx);
  assert.deepEqual(exports.inject, ["sessions", "locale", "slots"]);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options.name, "sidebar.workspaces.session.menu.item");
  assert.equal(registrations[0].options.id, "session-cleaner.delete");
  assert.equal(typeof registrations[0].component, "function");
});

test("menu item renders a menuitem button and disables itself for running sessions", () => {
  const { exports } = loadClient();
  const { ctx, registrations } = fakeCtx();
  exports.apply(ctx);
  const Item = registrations[0].component;

  const idle = Item({
    sessionId: "session-a",
    displayTitle: "A",
    useSessionStatus: () => false,
    useSessions: () => false,
    useMenuOpenState: () => [true, () => {}],
  });
  assert.equal(idle.type, "button");
  assert.equal(idle.props.role, "menuitem");
  assert.equal(idle.props.disabled, false);
  assert.match(idle.children.join(""), /Delete session/);

  const running = Item({
    sessionId: "session-a",
    displayTitle: "A",
    useSessionStatus: (selector) => selector(new Map([["session-a", { running: true }]])),
    useSessions: () => false,
    useMenuOpenState: () => [true, () => {}],
  });
  assert.equal(running.props.disabled, true);
  assert.equal(running.props.title, "running");

  const open = Item({
    sessionId: "session-a",
    displayTitle: "A",
    useSessionStatus: () => false,
    useSessions: (selector) => selector({ byId: { "session-a": { retainedBy: { mainView: 1 } } } }),
    useMenuOpenState: () => [true, () => {}],
  });
  assert.equal(open.props.disabled, true);
  assert.equal(open.props.title, "current");
});

test("clicking the idle item posts the session id, closes the menu, and refreshes", async () => {
  const { exports, win } = loadClient();
  let refreshed = 0;
  const { ctx, registrations } = fakeCtx({
    sessions: { refresh: async () => { refreshed += 1; } },
  });
  exports.apply(ctx);
  const Item = registrations[0].component;

  let menuOpen = true;
  const requests = [];
  const confirmations = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return { status: 200, async json() { return { ok: true, value: { files: 1 } }; } };
  };
  Object.assign(win, {
    confirm: (text) => { confirmations.push(text); return true; },
    alert: () => assert.fail("alert must not fire"),
  });

  const element = Item({
    sessionId: "session-b",
    displayTitle: "B",
    useSessionStatus: () => false,
    useSessions: () => false,
    useMenuOpenState: () => [menuOpen, (open) => { menuOpen = open; }],
  });
  await element.props.onClick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api-ext/session.delete");
  assert.deepEqual(requests[0].body, { sessionId: "session-b" });
  assert.equal(menuOpen, false);
  assert.equal(confirmations.length, 1);
  assert.equal(refreshed, 1);
  delete globalThis.fetch;
});

test("a refused delete surfaces the server message through alert", async () => {
  const { exports, win } = loadClient();
  let alerted = "";
  const { ctx, registrations } = fakeCtx();
  exports.apply(ctx);
  const Item = registrations[0].component;

  globalThis.fetch = async () => ({
    status: 200,
    async json() {
      return { ok: false, error: { code: "refused", message: "session is running" } };
    },
  });
  Object.assign(win, { confirm: () => true, alert: (text) => { alerted = text; } });
  const element = Item({
    sessionId: "session-c",
    displayTitle: "C",
    useSessionStatus: () => false,
    useSessions: () => false,
    useMenuOpenState: () => [true, () => {}],
  });
  await element.props.onClick();
  assert.match(alerted, /session is running/);
  delete globalThis.fetch;
});
