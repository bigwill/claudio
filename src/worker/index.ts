export { SessionDO } from "./session";

import { newSessionId } from "../shared/protocol";
import type {
  ChatRequest,
  CreateSessionResponse,
  SetTargetRequest,
  Step,
  SubmitAnalysisRequest,
  SubmitRenderErrorRequest,
} from "../shared/protocol";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const errorStep = (message: string, retryable = false): Step => ({
  kind: "error",
  message,
  retryable,
});

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("Body must be valid JSON.");
  }
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

    // The app is intentionally open — no auth gate. Low expected volume, and
    // the Anthropic key stays server-side either way.
    if (url.pathname === "/api/ping") {
      const stub = env.SESSION.getByName("ping");
      const pong = await stub.ping();
      return json({
        ok: true,
        durableObject: pong,
        hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY),
      });
    }

    // POST /api/session — mint a session id. The DO is created lazily on first use.
    if (url.pathname === "/api/session") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const body: CreateSessionResponse = { sessionId: newSessionId() };
      return json(body);
    }

    // /api/session/:id[/action]
    const parts = url.pathname.split("/").filter(Boolean); // ["api","session",id,action?]
    if (parts[0] === "api" && parts[1] === "session" && parts[2]) {
      const sessionId = parts[2];
      const action = parts[3];
      const session = env.SESSION.getByName(sessionId);

      try {
        if (!action) {
          if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
          // The DO reports its own internal hex id; the caller cares about the
          // short id that's in the URL.
          return json({ ...(await session.snapshot()), sessionId });
        }

        if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

        switch (action) {
          case "target": {
            const body = await readJson<SetTargetRequest>(request);
            if (!body?.features || !body?.info) {
              return json(errorStep("Missing features or info."), 400);
            }
            return json(await session.setTarget(body.features, body.info));
          }
          case "analysis": {
            const body = await readJson<SubmitAnalysisRequest>(request);
            if (!body?.presetId || !body?.features || !body?.diff) {
              return json(errorStep("Missing presetId, features or diff."), 400);
            }
            return json(await session.submitAnalysis(body.presetId, body.features, body.diff));
          }
          case "render-error": {
            const body = await readJson<SubmitRenderErrorRequest>(request);
            if (!body?.presetId) return json(errorStep("Missing presetId."), 400);
            return json(await session.submitRenderError(body.presetId, String(body.message ?? "")));
          }
          case "chat": {
            const body = await readJson<ChatRequest>(request);
            if (!body?.message?.trim()) return json(errorStep("Missing message."), 400);
            return json(await session.chat(body.message));
          }
          default:
            return json({ error: "not found", path: url.pathname }, 404);
        }
      } catch (err) {
        // Stale presetId, wrong status, bad JSON — client-side problems. Always
        // answer with a Step so the client's drain loop can render it.
        return json(errorStep(err instanceof Error ? err.message : String(err)), 409);
      }
    }

    return json({ error: "not found", path: url.pathname }, 404);
  },
} satisfies ExportedHandler<Env>;
