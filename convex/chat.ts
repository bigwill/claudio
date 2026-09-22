/**
 * Multi-author chat, which is also the queue.
 *
 * Sending never fails because the session is busy. That is the whole point of
 * decision "queue, don't reject": with several people in a room, someone is
 * almost always mid-turn, and an input that goes dead is an input people stop
 * trusting. A message sent during a turn becomes a queued row — visible,
 * attributed, cancellable — and is folded into the next turn rather than made to
 * wait behind the entire refine loop.
 */

import { ConvexError, v } from "convex/values";

import { mutation } from "./_generated/server";
import { addChat, beginTurn, isBusy } from "./model/turn";
import { appendMessage, healBlocks, tailMessage } from "./model/messages";
import { bySlug } from "./model/sessions";
import { reassignOrAbandonRender } from "./model/turn";
import {
  MAX_QUEUED_PER_CLIENT,
  MAX_QUEUED_PER_SESSION,
  sanitizeNickname,
} from "../src/shared/protocol";

const vAuthor = v.object({
  clientId: v.string(),
  nickname: v.string(),
  color: v.string(),
});

export const send = mutation({
  args: {
    slug: v.string(),
    author: vAuthor,
    text: v.string(),
    /** Which preset the sender was looking at — context for a message read later. */
    aboutPresetId: v.union(v.null(), v.string()),
  },
  returns: v.object({ queued: v.boolean() }),
  handler: async (ctx, args) => {
    const session = await bySlug(ctx, args.slug);
    if (!session) throw new ConvexError({ code: "no-session" });

    const text = args.text.trim().slice(0, 2000);
    if (!text) throw new ConvexError({ code: "empty-message" });

    // Sanitized HERE, not just at render time: this string is spliced into the
    // prompt as `[nickname]`, and the model is told that brackets delimit the
    // speaker — so an unsanitized name could forge one.
    const nickname = sanitizeNickname(args.author.nickname);
    const now = Date.now();

    // Loading the session document is what puts it in this mutation's OCC read
    // set, and the read set is what makes two simultaneous sends serialize: one
    // commits, the other re-runs against fresh state and sees a busy session.
    let busy = isBusy(session, now);

    /**
     * A chat message can force-close a render whose lease has lapsed.
     *
     * This is the user's own manual unstick, and it is the multiplayer form of
     * what SessionDO.chat() did on a mid-render reload: rather than demanding a
     * measurement nobody is going to send, answer the tool call and move on.
     * Without it, a stuck render in a session where nobody else is present has no
     * user-triggerable escape at all.
     */
    if (session.status === "awaiting_render" && now >= session.renderLeaseUntil) {
      await reassignOrAbandonRender(ctx, session, now);
      const after = (await ctx.db.get(session._id))!;
      busy = isBusy(after, now);
    }

    const current = (await ctx.db.get(session._id))!;

    if (busy) {
      const queued = await ctx.db
        .query("chat")
        .withIndex("by_session_status_seq", (q) =>
          q.eq("sessionId", current._id).eq("status", "queued"),
        )
        .collect();

      // Caps are about runaway cost, not pacing: an abandoned session must not be
      // able to keep the agent talking to an empty room.
      if (queued.length >= MAX_QUEUED_PER_SESSION) {
        throw new ConvexError({
          code: "queue-full",
          message: "There are already several messages waiting — give the agent a moment.",
        });
      }
      if (
        queued.filter((q) => q.authorClientId === args.author.clientId).length >=
        MAX_QUEUED_PER_CLIENT
      ) {
        throw new ConvexError({
          code: "queue-full-you",
          message: "You already have messages waiting. Cancel one, or wait for this turn.",
        });
      }

      await addChat(ctx, current, {
        kind: "user",
        status: "queued",
        text,
        authorClientId: args.author.clientId,
        nickname,
        color: args.author.color,
        aboutPresetId: args.aboutPresetId,
      });
      return { queued: true };
    }

    await addChat(ctx, current, {
      kind: "user",
      status: "sent",
      text,
      authorClientId: args.author.clientId,
      nickname,
      color: args.author.color,
      aboutPresetId: args.aboutPresetId,
    });

    // Same `[name]` prefix as the queued path. Attribution has to be consistent
    // for exactly the messages the model sees most, or it learns the convention
    // is optional.
    const tail = await tailMessage(ctx, current._id);
    await appendMessage(ctx, current, {
      role: "user",
      content: [...healBlocks(tail), { type: "text", text: `[${nickname}] ${text}` }],
    });

    // tool_choice "auto": "what does modEnv do?" deserves a text answer, not a
    // forced preset.
    await beginTurn(ctx, current, {
      by: args.author.clientId,
      force: false,
      isFirstProposal: false,
      now,
    });
    return { queued: false };
  },
});

/** Withdraw your own queued message. Advisory ownership — attribution, not auth. */
export const cancelQueued = mutation({
  args: { slug: v.string(), chatId: v.id("chat"), clientId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.chatId);
    if (!row || row.status !== "queued") return null;
    if (row.authorClientId !== args.clientId) return null;
    await ctx.db.patch(args.chatId, { status: "cancelled" });
    return null;
  },
});
