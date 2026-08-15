export { SessionDO } from "./session";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Shared-secret gate on /api/*. Not real auth — just a cheap door so a shared
 * *.workers.dev link isn't an open endpoint spending the Anthropic key.
 * Accepts ?k=<secret> or an X-App-Key header.
 *
 * If APP_SECRET is unset (e.g. first deploy, before `wrangler secret put`),
 * the gate is open — otherwise you can't deploy your way out of a locked door.
 */
function authorized(request: Request, env: Env): boolean {
  const expected = env.APP_SECRET;
  if (!expected) return true;
  const url = new URL(request.url);
  const provided = url.searchParams.get("k") ?? request.headers.get("x-app-key");
  return provided === expected;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Safety net: run_worker_first should mean we only see /api/*, but if the
    // routing config ever drifts, hand non-API requests to the asset server
    // rather than 404ing the whole site.
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (!authorized(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }

    if (url.pathname === "/api/ping") {
      const stub = env.SESSION.getByName("ping");
      const pong = await stub.ping();
      return json({
        ok: true,
        durableObject: pong,
        hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY),
        secretGate: env.APP_SECRET ? "enabled" : "open",
      });
    }

    return json({ error: "not found", path: url.pathname }, 404);
  },
} satisfies ExportedHandler<Env>;
