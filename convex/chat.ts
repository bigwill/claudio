/**
 * chat.send: a producer note (plan §4). routeNote decides where it goes: a
 * "@keys design …" or "@me …" note starts a measured design; anything else is
 * a note to the musicians it names, with your octave for the agents' snapshot
 * and the reaction budget (1 for a note to one musician, 0 otherwise).
 * Draining the addressed musicians' inboxes into band turns is slice 5.
 */
import { ConvexError, v } from "convex/values";

import { mutation } from "./_generated/server";
import { postChat } from "./model/chat";
import { musiciansOf } from "./model/jam";
import { routeNote } from "../src/shared/route";
import { startDesign } from "./model/design";
import { vRenderSpec } from "./validators";

export const send = mutation({
  args: {
    jamId: v.id("jams"),
    text: v.string(),
    octave: v.number(),
    /** The render spec for a design route (the browser mints it: it knows the sample rate). */
    spec: v.optional(vRenderSpec),
  },
  /** The note's chat seq, or null when the note started a design. */
  returns: v.union(v.null(), v.number()),
  handler: async (ctx, { jamId, text, octave, spec }) => {
    const band = await musiciansOf(ctx, jamId);
    const route = routeNote(
      text.trim(),
      band.map((m) => ({ id: m._id, name: m.name, role: m.role, kind: m.kind })),
    );
    if (route.kind === "refuse") throw new ConvexError(route.why);
    if (route.kind === "design") {
      // A design note is logged as a system row by startDesign, never as a
      // producer row: otherwise the musician would also answer it as a note
      // once the design ended, and could tweak over the sound just designed.
      if (!spec) throw new ConvexError("This client can't start a design (no render spec).");
      await startDesign(ctx, route.musicianId, { kind: "prompt", text: route.prompt }, spec);
      return null;
    }
    return await postChat(ctx, jamId, {
      kind: "producer",
      text: text.trim(),
      to: route.to,
      octave: Math.round(octave),
      reactionBudget: route.to.length === 1 ? 1 : 0,
    });
  },
});
