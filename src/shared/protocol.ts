/**
 * Wire protocol between the browser and the Worker/Durable Object.
 *
 * The whole client loop is driven by ONE union: every endpoint returns a `Step`.
 * That unification is what keeps the client ~10 lines, and it means a chat turn
 * ("make it brighter") flows through the identical path as the refinement loop —
 * the agent answering with propose_preset just yields another {kind:"render"}.
 */

import type { ClaudioPreset } from "./preset";
import type { FeatureDiff, FeatureSummary } from "./features";

export type SessionStatus = "idle" | "thinking" | "awaiting_render" | "done" | "error";

export interface TargetInfo {
  filename: string;
  durationSec: number;
  sampleRate: number;
}

export interface Attempt {
  presetId: string;
  preset: ClaudioPreset;
  rationale: string;
  /** null until the browser has rendered + analyzed this preset. */
  features: FeatureSummary | null;
  distance: number | null;
}

/**
 * Suggested next moves, in the user's language ("glassier", "more punch").
 * Rendered as one-click chips so someone with both hands on the keyboard can
 * keep exploring without typing. Clicking one just sends it as a chat message,
 * so it needs no separate code path.
 */
export type Suggestions = string[];

/** How many chips to show, and what the agent is asked to produce. */
export const SUGGESTION_COUNT = 4;

export type Step =
  | {
      kind: "render";
      presetId: string;
      preset: ClaudioPreset;
      rationale: string;
      iteration: number;
      iterationsRemaining: number;
      /** Any prose the agent emitted alongside the tool call. */
      note: string;
    }
  | {
      kind: "message";
      text: string;
      preset: ClaudioPreset | null;
      iteration: number;
      suggestions?: Suggestions;
    }
  | {
      kind: "done";
      text: string;
      preset: ClaudioPreset;
      presetId: string;
      distance: number | null;
      suggestions?: Suggestions;
    }
  | {
      kind: "error";
      message: string;
      retryable: boolean;
    };

export interface SessionSnapshot {
  sessionId: string;
  status: SessionStatus;
  target: FeatureSummary | null;
  targetInfo: TargetInfo | null;
  iteration: number;
  maxIterations: number;
  history: Attempt[];
  bestPresetId: string | null;
}

// --- request bodies ---------------------------------------------------------

export interface CreateSessionResponse {
  sessionId: string;
}

export interface SetTargetRequest {
  features: FeatureSummary;
  info: TargetInfo;
}

export interface SubmitAnalysisRequest {
  presetId: string;
  features: FeatureSummary;
  diff: FeatureDiff;
}

export interface SubmitRenderErrorRequest {
  presetId: string;
  message: string;
}

export interface ChatRequest {
  message: string;
}

/** Default iteration budget for the closed refine loop. */
export const MAX_ITERATIONS = 3;

export const API = {
  createSession: "/api/session",
  session: (id: string) => `/api/session/${id}`,
  target: (id: string) => `/api/session/${id}/target`,
  analysis: (id: string) => `/api/session/${id}/analysis`,
  renderError: (id: string) => `/api/session/${id}/render-error`,
  chat: (id: string) => `/api/session/${id}/chat`,
} as const;
