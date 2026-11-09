// dsh-session-cleaner client half (v2.0.0): a "Delete session" row in the
// sidebar session ⋮ menu.
//
// DeepSeek Harness >= 0.2.2 renders that menu from a first-class slot —
// `sidebar.workspaces.session.menu.item` — so no DOM scraping is needed: the
// slot hands each entry its own `sessionId` and the `useMenuOpenState` hook.
// The HTTP call goes to the host half's `POST /api-ext/session.delete` route,
// and the sidebar list is refreshed through `ctx.sessions.refresh()`.
window.__ModuleLoader__.load({
	id: "dsh-session-cleaner",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const NS = "sessionCleaner";
		const SLOT = "sidebar.workspaces.session.menu.item";
		const ROUTE = "/api-ext/session.delete";
		const CLASS = "session-cleaner-menu-item";

		const dicts = {
			en: {
				delete: "Delete session",
				confirm: "Delete this session? This cannot be undone.",
				failed: "Delete failed: ",
				running: "Session is running and cannot be deleted",
				current: "Close this conversation before deleting it"
			},
			zh: {
				delete: "删除此会话",
				confirm: "确定删除此会话？删除后不可恢复。",
				failed: "删除失败：",
				running: "会话正在运行，无法删除",
				current: "请先关闭此对话再删除"
			}
		};

		const log = (...args) => {
			try {
				console.debug("[dsh-session-cleaner]", ...args);
			} catch {
				/* console unavailable */
			}
		};

		/** POST the host half's delete route; throws with the server's message. */
		async function requestDelete(sessionId) {
			const response = await fetch(ROUTE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({ sessionId })
			});
			const body = await response.json().catch(() => ({}));
			if (body?.ok !== true) {
				throw new Error(body?.error?.message ?? "delete failed (" + response.status + ")");
			}
			return body.value;
		}

		const CSS = [
			"." + CLASS + "{",
			"display:flex;align-items:center;gap:8px;width:100%;",
			"padding:6px 12px;border:none;background:none;",
			"color:var(--dsw-alias-state-error-primary, #e5484d);",
			"font:inherit;font-size:13px;line-height:20px;text-align:left;",
			"cursor:pointer;border-radius:var(--dsw-radius-sm, 6px);",
			"}",
			"." + CLASS + ":hover:not(:disabled){",
			"background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12));",
			"}",
			"." + CLASS + ":disabled{",
			"color:var(--dsw-alias-label-dimmed, rgba(128,128,128,.6));",
			"cursor:default;",
			"}"
		].join("\n");

		/**
		 * One session-row menu entry. The sidebar menu supplies the row's
		 * `sessionId`, the session-status and session-list selector hooks, and the
		 * menu's open-state pair. It is disabled while a turn runs and while the
		 * conversation is open in the main view, so the active view is never pulled
		 * out from under the user.
		 */
		function DeleteSessionItem(props) {
			const sessionId = props.sessionId;
			const useStatus = typeof props.useSessionStatus === "function" ? props.useSessionStatus : () => false;
			const useList = typeof props.useSessions === "function" ? props.useSessions : () => false;
			const useOpenState =
				typeof props.useMenuOpenState === "function" ? props.useMenuOpenState : () => [true, () => {}];
			const t = props.t;

			const openState = useOpenState();
			const running = useStatus((statuses) => {
				const status = statuses?.get?.(sessionId) ?? statuses?.[sessionId];
				return status?.running === true;
			});
			const retained = useList((sessions) => {
				const row = sessions?.byId?.[sessionId];
				return (row?.retainedBy?.mainView ?? 0) > 0;
			});
			const blocked = running === true || retained === true;
			const title = running === true ? t("running") : retained === true ? t("current") : t("delete");

			const onClick = async () => {
				openState[1]?.(false);
				if (blocked) return;
				if (!window.confirm(t("confirm"))) return;
				try {
					await requestDelete(sessionId);
					log("deleted", sessionId);
					await props.refresh?.();
				} catch (error) {
					window.alert(t("failed") + (error instanceof Error ? error.message : String(error)));
				}
			};

			return react.createElement(
				"button",
				{
					type: "button",
					role: "menuitem",
					title,
					disabled: blocked,
					className: CLASS,
					onClick
				},
				"🗑 " + t("delete")
			);
		}

		function apply(ctx) {
			log("apply");
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, "en", dicts.en), "session-cleaner: locale en");
			ctx.effect(() => ctx.locale.register(NS, "zh", dicts.zh), "session-cleaner: locale zh");
			ctx.effect(
				() => {
					const style = document.createElement("style");
					style.textContent = CSS;
					document.head.appendChild(style);
					return () => style.remove();
				},
				"session-cleaner: styles"
			);

			const refresh = () => (typeof ctx.sessions?.refresh === "function" ? ctx.sessions.refresh() : undefined);
			const Item = (props) => DeleteSessionItem({ ...props, t, refresh });

			ctx.slots.inject(SLOT, () =>
				ctx.slots.register({ name: SLOT, id: "session-cleaner.delete", order: 1000 }, Item)
			);
			log("menu item registered on", SLOT);
		}

		exports.apply = apply;
		exports.inject = ["sessions", "locale", "slots"];
		return module.exports;
	}
});
