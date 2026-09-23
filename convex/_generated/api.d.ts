/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent from "../agent.js";
import type * as crons from "../crons.js";
import type * as fakeClaude from "../fakeClaude.js";
import type * as model_chat from "../model/chat.js";
import type * as model_design from "../model/design.js";
import type * as model_drain from "../model/drain.js";
import type * as model_history from "../model/history.js";
import type * as model_messages from "../model/messages.js";
import type * as model_tools from "../model/tools.js";
import type * as prompt from "../prompt.js";
import type * as render from "../render.js";
import type * as spikes from "../spikes.js";
import type * as testing from "../testing.js";
import type * as turn from "../turn.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  crons: typeof crons;
  fakeClaude: typeof fakeClaude;
  "model/chat": typeof model_chat;
  "model/design": typeof model_design;
  "model/drain": typeof model_drain;
  "model/history": typeof model_history;
  "model/messages": typeof model_messages;
  "model/tools": typeof model_tools;
  prompt: typeof prompt;
  render: typeof render;
  spikes: typeof spikes;
  testing: typeof testing;
  turn: typeof turn;
  validators: typeof validators;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
