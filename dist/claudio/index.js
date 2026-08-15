import { DurableObject } from "cloudflare:workers";
//#region src/worker/session.ts
/**
* One Durable Object per sound-design session.
*
* Holds the paused Anthropic conversation between HTTP round trips: the agent's
* turn stops at a tool_use block, and can only be resumed once the browser has
* rendered + analyzed the proposed preset. `pendingToolUseId` is what survives
* that gap. See PLAN.md "The agent loop protocol".
*
* NOTE: currently a scaffold — schema + lifecycle only. RPC methods land next.
*/
var SessionDO = class extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (
           id INTEGER PRIMARY KEY CHECK(id = 1),
           json TEXT NOT NULL
         );`);
			this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           json TEXT NOT NULL
         );`);
		});
	}
	/** Liveness probe used by /api/ping so we exercise the DO binding end to end. */
	async ping() {
		return {
			ok: true,
			id: this.ctx.id.toString()
		};
	}
};
//#endregion
//#region src/worker/index.ts
var json = (body, status = 200) => new Response(JSON.stringify(body), {
	status,
	headers: { "content-type": "application/json" }
});
/**
* Shared-secret gate on /api/*. Not real auth — just a cheap door so a shared
* *.workers.dev link isn't an open endpoint spending the Anthropic key.
* Accepts ?k=<secret> or an X-App-Key header.
*
* If APP_SECRET is unset (e.g. first deploy, before `wrangler secret put`),
* the gate is open — otherwise you can't deploy your way out of a locked door.
*/
function authorized(request, env) {
	const expected = env.APP_SECRET;
	if (!expected) return true;
	return (new URL(request.url).searchParams.get("k") ?? request.headers.get("x-app-key")) === expected;
}
//#endregion
//#region \0virtual:cloudflare/worker-entry
var worker_entry_default = { async fetch(request, env, _ctx) {
	const url = new URL(request.url);
	if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
	if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
	if (url.pathname === "/api/ping") return json({
		ok: true,
		durableObject: await env.SESSION.getByName("ping").ping(),
		hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY),
		secretGate: env.APP_SECRET ? "enabled" : "open"
	});
	return json({
		error: "not found",
		path: url.pathname
	}, 404);
} };
//#endregion
export { SessionDO, worker_entry_default as default };
