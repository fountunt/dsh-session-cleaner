// dsh-session-cleaner client half:
//  a "delete" item appended to the sidebar session row ⋮ menu (v0.2.1).
//  (v0.2.0 的会话头部操作区按钮已移除：删除只应出现在左侧会话列表的
//  ⋮ 菜单里，不应与权限/模型选择混在一起。)
// Loaded by the web app's module loader as /plugins/dsh-session-cleaner/client.js.
//
// The row ⋮ menu is rendered by the upstream ui-workspace component with a
// hardcoded item list and no public slot, so the client half augments the
// opened menu in the DOM: it watches for [role="menu"] and pairs it STRICTLY
// with the session row that was just clicked ([role="treeitem"]). A menu that
// opens anywhere else (the "+" button, model pickers, context menus, …) is
// never paired, so the delete item can only ever appear on conversation rows.
// The session id is resolved by matching the row title against the session
// list; ambiguous titles skip injection for safety.
window.__ModuleLoader__.load({
	id: "dsh-session-cleaner",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const zh = {
			delete: "删除此会话",
			confirm: "确定删除此会话？删除后不可恢复。",
			deleting: "删除中…",
			failed: "删除失败：",
			running: "会话正在运行，无法删除"
		};
		const en = {
			delete: "Delete session",
			confirm: "Delete this session? This cannot be undone.",
			deleting: "Deleting…",
			failed: "Delete failed: ",
			running: "Session is running and cannot be deleted"
		};

		const inject = ["sessions"];

		const log = (...args) => {
			try {
				console.debug("[dsh-session-cleaner]", ...args);
			} catch {
				/* console unavailable */
			}
		};

		// ------------------------------------------------------------- row ⋮ menu item

		const MENU_MARKER = "data-session-cleaner-menu";

		/** POST the session delete endpoint; throws with the server's message on failure. */
		async function deleteSessionViaApi(sessionId) {
			const res = await fetch("/api-ext/session.delete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId })
			});
			const body = await res.json().catch(() => ({}));
			if (!body.ok) throw new Error(body.error?.message ?? "delete failed");
			return body.value;
		}

		/** Current UI language, used for the DOM-injected menu item text. */
		function uiLang() {
			const lang = document.documentElement.lang || navigator.language || "en";
			return lang.toLowerCase().startsWith("zh") ? "zh" : "en";
		}

		/**
		 * Fetch the visible session catalog (title -> [{id, running}]) through
		 * the host RPC so the injected menu item can resolve a row's session id
		 * from its title.
		 */
		async function fetchSessionCatalog() {
			const res = await fetch("/api/session.list", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					type: "client-request",
					rpcId: "session-cleaner-" + Math.random().toString(36).slice(2),
					method: "session.list",
					payload: {}
				})
			});
			if (!res.ok) throw new Error("session.list HTTP " + res.status);
			const body = await res.json();
			const items = body?.result?.value?.items ?? [];
			const catalog = new Map();
			for (const item of items) {
				if (item.blank || item.origin === "subagent") continue;
				const title = item.projections?.values?.title;
				if (typeof title !== "string" || title === "") continue;
				if (!catalog.has(title)) catalog.set(title, []);
				catalog.get(title).push({ id: item.sessionId, running: item.running === true });
			}
			log("catalog:", catalog.size, "titles");
			return catalog;
		}

		/** Resolve the row's session: the row's title text must match exactly one session. */
		function resolveSession(rowEl, catalog) {
			const spans = rowEl.querySelectorAll("span");
			for (const span of spans) {
				const text = span.textContent?.trim() ?? "";
				if (text === "") continue;
				const entries = catalog.get(text);
				if (entries !== undefined && entries.length === 1) return entries[0];
			}
			return undefined;
		}

		/** Append the delete item to an open row menu. */
		function augmentMenu(menuEl, rowEl, catalog, ctx) {
			if (menuEl.querySelector(`[${MENU_MARKER}]`) !== null) return;
			const session = resolveSession(rowEl, catalog);
			if (session === undefined) {
				log("skip: cannot resolve session for row", rowEl);
				return;
			}
			log("augment menu for", session.id, session.running ? "(running)" : "");
			const lang = uiLang();
			const dict = lang === "zh" ? zh : en;
			const running = session.running === true;
			const item = document.createElement("button");
			item.type = "button";
			item.setAttribute("role", "menuitem");
			item.setAttribute(MENU_MARKER, "1");
			item.textContent = "🗑 " + dict.delete;
			item.title = running ? dict.running : dict.delete;
			item.disabled = running;
			item.style.cssText = [
				"display:flex",
				"align-items:center",
				"gap:8px",
				"width:100%",
				"padding:6px 12px",
				"border:none",
				"background:none",
				"color:var(--dsw-alias-danger, #e5484d)",
				"font:inherit",
				"font-size:13px",
				"text-align:left",
				"cursor:" + (running ? "default" : "pointer"),
				"opacity:" + (running ? "0.45" : "1"),
				"border-top:1px solid var(--dsw-alias-hairline, rgba(128,128,128,.25))",
				"margin-top:4px"
			].join(";");
			item.addEventListener("mouseenter", () => {
				if (!running) item.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))";
			});
			item.addEventListener("mouseleave", () => {
				item.style.background = "none";
			});
			item.addEventListener("click", async (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (running) return;
				if (!window.confirm(dict.confirm)) return;
				try {
					await deleteSessionViaApi(session.id);
					log("deleted", session.id);
					await ctx.sessions.refresh();
				} catch (error) {
					window.alert(dict.failed + (error instanceof Error ? error.message : String(error)));
				}
			});
			menuEl.appendChild(item);
		}

		/** Install the ⋮ menu augmentation. */
		function installRowMenuAugmentation(ctx) {
			// Strict one-shot pairing: the delete item may only ever appear in
			// the ⋮ menu of a session row. The previous "last row" fallback
			// kept a stale row around forever, which leaked the item into
			// every other menu on the page ("+", model pickers, …) — gone.
			const PAIR_WINDOW_MS = 800;
			let pendingRow = null;
			let pendingUntil = 0;

			// Capture phase: remember the row that was just clicked, before
			// the menu opens. Clicks outside a session row never create a
			// pending pairing.
			document.addEventListener("click", (event) => {
				const target = event.target;
				if (target instanceof Element) {
					const row = target.closest('[role="treeitem"]');
					if (row !== null) {
						pendingRow = row;
						pendingUntil = Date.now() + PAIR_WINDOW_MS;
					}
				}
			}, true);

			/**
			 * A portaled menu (no treeitem ancestor) may use the pending row
			 * only when all of these hold: the click was recent, the row is
			 * still in the document, and — if the row exposes aria-haspopup
			 * triggers — one of them is currently expanded.
			 */
			function pendingRowAcceptsMenu(rowEl, now) {
				if (now > pendingUntil) return false;
				if (!document.contains(rowEl)) return false;
				const triggers = rowEl.querySelectorAll("[aria-haspopup]");
				if (triggers.length === 0) return true; // unknown markup: rely on the window
				for (const trigger of triggers) {
					if (trigger.getAttribute("aria-expanded") === "true") return true;
				}
				return false;
			}

			const maybeAugment = (menuEl) => {
				const now = Date.now();
				let rowEl = menuEl.closest('[role="treeitem"]');
				if (rowEl === null) {
					// Portaled menu: pair only with a fresh, still-open row click.
					if (pendingRow !== null && pendingRowAcceptsMenu(pendingRow, now)) {
						rowEl = pendingRow;
					}
				}
				if (rowEl === null) {
					log("menu without row", menuEl);
					return;
				}
				// One-shot: a pairing is consumed immediately and can never
				// leak into a later menu.
				pendingRow = null;
				pendingUntil = 0;
				fetchSessionCatalog()
					.then((c) => augmentMenu(menuEl, rowEl, c, ctx))
					.catch((error) => log("catalog failed:", String(error?.message ?? error)));
			};
			const observer = new MutationObserver((mutations) => {
				for (const mutation of mutations) {
					for (const node of mutation.addedNodes) {
						if (node.nodeType !== 1) continue;
						if (node.matches?.('[role="menu"]') === true) maybeAugment(node);
						node.querySelectorAll?.('[role="menu"]').forEach(maybeAugment);
					}
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });
			document.querySelectorAll('[role="menu"]').forEach(maybeAugment);
			log("menu observer installed");
			ctx.effect(() => () => observer.disconnect(), "session-cleaner: menu observer");
		}

		// ---------------------------------------------------------------------- entry

		function apply(ctx) {
			log("apply");
			// 侧边栏 ⋮ 菜单增强：删除入口的唯一位置。
			try {
				installRowMenuAugmentation(ctx);
			} catch (error) {
				log("menu augmentation failed:", String(error?.message ?? error));
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
