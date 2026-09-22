/**
 * The backstop.
 *
 * Everything else in this design advances because a browser did something. That
 * is fine until nobody's browser does — an action that died silently, a lease
 * whose one-shot job failed, a session whose last tab closed mid-turn. The DO
 * could only heal lazily, when someone next sent a message; a cron heals a
 * session with nobody watching, which multiplayer actually needs.
 */

import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";
import { WATCHDOG_INTERVAL_MS } from "../src/shared/protocol";

const crons = cronJobs();

crons.interval(
  "reclaim stalled turns and renders",
  { seconds: WATCHDOG_INTERVAL_MS / 1000 },
  internal.turn.watchdog,
  {},
);

export default crons;
