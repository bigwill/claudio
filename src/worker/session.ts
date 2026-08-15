import { DurableObject } from "cloudflare:workers";

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
export class SessionDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS meta (
           id INTEGER PRIMARY KEY CHECK(id = 1),
           json TEXT NOT NULL
         );`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS messages (
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           json TEXT NOT NULL
         );`,
      );
    });
  }

  /** Liveness probe used by /api/ping so we exercise the DO binding end to end. */
  async ping(): Promise<{ ok: true; id: string }> {
    return { ok: true, id: this.ctx.id.toString() };
  }
}
