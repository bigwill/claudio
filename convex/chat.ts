/**
 * chat.send: a producer note (plan §4). Parses @mentions into musician ids,
 * stores your octave for the agents' snapshot, sets the reaction budget
 * (1 for a note to one musician, 0 otherwise), and writes through postChat.
 * Draining the addressed musicians' inboxes into band turns is slice 5.
 */
import { ConvexError, v } from "convex/values";

import { mutation } from "./_generated/server";
import { postChat } from "./model/chat";
import { musiciansOf } from "./model/jam";
import { parseMentions } from "./model/mentions";

export const send = mutation({
  args: { jamId: v.id("jams"), text: v.string(), octave: v.number() },
  returns: v.number(),
  handler: async (ctx, { jamId, text, octave }) => {
    const body = text.trim();
    if (!body) throw new ConvexError("empty note");
    const band = await musiciansOf(ctx, jamId);
    const { to } = parseMentions(
      body,
      band.map((m) => ({ id: m._id, name: m.name, role: m.role, kind: m.kind })),
    );
    return await postChat(ctx, jamId, {
      kind: "producer",
      text: body,
      to,
      octave: Math.round(octave),
      reactionBudget: to.length === 1 ? 1 : 0,
    });
  },
});
