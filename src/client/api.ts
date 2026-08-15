/** Typed wrappers over the Worker API. All of them return a `Step`. */

import type { FeatureDiff, FeatureSummary } from "../shared/features";
import {
  API,
  type CreateSessionResponse,
  type SessionSnapshot,
  type Step,
  type TargetInfo,
} from "../shared/protocol";
import { api } from "./main";

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await api(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new Error("unauthorized — check the app key");
  const parsed = (await res.json()) as T;
  if (!res.ok && !(parsed as { kind?: string })?.kind) {
    throw new Error(`${res.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

export async function createSession(): Promise<string> {
  const { sessionId } = await post<CreateSessionResponse>(API.createSession);
  return sessionId;
}

export function setTarget(
  sessionId: string,
  features: FeatureSummary,
  info: TargetInfo,
): Promise<Step> {
  return post<Step>(API.target(sessionId), { features, info });
}

export function submitAnalysis(
  sessionId: string,
  presetId: string,
  features: FeatureSummary,
  diff: FeatureDiff,
): Promise<Step> {
  return post<Step>(API.analysis(sessionId), { presetId, features, diff });
}

export function submitRenderError(
  sessionId: string,
  presetId: string,
  message: string,
): Promise<Step> {
  return post<Step>(API.renderError(sessionId), { presetId, message });
}

export function chat(sessionId: string, message: string): Promise<Step> {
  return post<Step>(API.chat(sessionId), { message });
}

export async function snapshot(sessionId: string): Promise<SessionSnapshot> {
  const res = await api(API.session(sessionId));
  return (await res.json()) as SessionSnapshot;
}
