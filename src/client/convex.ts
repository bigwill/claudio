/**
 * The only module that talks to Convex (plan §7). The band UI's queries and
 * mutations are added here in slice 3.
 */
import { ConvexClient } from "convex/browser";

const url = import.meta.env.VITE_CONVEX_URL as string | undefined;
if (!url) throw new Error("VITE_CONVEX_URL is not set — run `npx convex dev` to configure a deployment.");

export const convex = new ConvexClient(url);
