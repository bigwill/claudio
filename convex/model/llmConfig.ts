/**
 * Per-kind model config (plan §4). Each timeout sits below its lease, so the
 * action's own abort fires before the watchdog reclaims the turn under it.
 */
export const LLM = {
  /** Band turns: a musician answering notes. Fast, strict tools, forced tool use. */
  band: { model: "claude-sonnet-5", timeoutMs: 30_000, leaseMs: 45_000, maxTokens: 8000, effort: "low" },
  /** Design jobs: the measured sound-design loop. DESIGN_MODEL=claude-opus-5 falls back. */
  design: { model: "claude-opus-5-5", timeoutMs: 90_000, leaseMs: 150_000, maxTokens: 16000 },
} as const;

export type LlmKind = keyof typeof LLM;
