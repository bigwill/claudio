/**
 * UI + the drain loop.
 *
 * The whole client is driven by one union: every endpoint returns a `Step`, and
 * `drain()` keeps rendering-and-reporting for as long as the agent keeps asking
 * for renders. A chat turn ("brighter") flows through the identical path.
 */

import type { ClaudioPreset } from "../shared/preset";
import type { Step } from "../shared/protocol";
import type { FeatureSummary } from "../shared/features";
import * as apiClient from "./api";
import {
  analyzeTarget,
  ensureAudio,
  evaluatePreset,
  playBuffer,
  playNote,
  setLivePreset,
  type TargetAnalysis,
} from "./audio";

/** Plain JSON fetch. The app is open — no key, no gate. */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return fetch(path, { ...init, headers });
}

// --- state -----------------------------------------------------------------

interface AttemptView {
  presetId: string;
  preset: ClaudioPreset;
  rationale: string;
  distance: number | null;
  features: FeatureSummary | null;
}

const state = {
  sessionId: null as string | null,
  target: null as TargetAnalysis | null,
  attempts: [] as AttemptView[],
  current: null as ClaudioPreset | null,
  busy: false,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const app = () => document.getElementById("app")!;

// --- rendering -------------------------------------------------------------

function shell(): void {
  app().innerHTML = `
    <h1>Claudio</h1>
    <p class="sub">Upload a sound. An agent reverse-engineers it into an FM patch, then you talk to it.</p>

    <div class="panel">
      <div id="drop">Drop a WAV here, or click to choose
        <input id="file" type="file" accept="audio/*" class="hidden" />
      </div>
      <div id="targetinfo" class="row muted hidden" style="margin-top:12px"></div>
    </div>

    <div class="panel" id="statuspanel">
      <div class="row"><span class="tag">status</span><span id="status" class="muted">Waiting for a sample.</span></div>
    </div>

    <div class="panel hidden" id="attemptspanel">
      <div class="row" style="margin-bottom:6px"><span class="tag">iterations</span></div>
      <div id="attempts"></div>
    </div>

    <div class="panel hidden" id="chatpanel">
      <div class="row">
        <input id="chat" type="text" placeholder="brighter · more attack bite · less metallic" style="flex:1" />
        <button id="send">Send</button>
      </div>
      <div id="chatlog" class="muted" style="margin-top:10px"></div>
    </div>`;

  const drop = $("drop")!;
  const file = $<HTMLInputElement>("file")!;
  drop.addEventListener("click", () => file.click());
  file.addEventListener("change", () => file.files?.[0] && start(file.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (f) start(f);
  });

  $("send")?.addEventListener("click", sendChat);
  $<HTMLInputElement>("chat")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });
}

function setStatus(text: string, tone: "muted" | "good" = "muted"): void {
  const el = $("status");
  if (!el) return;
  el.textContent = text;
  el.className = tone === "good" ? "" : "muted";
  if (tone === "good") el.style.color = "var(--good)";
  else el.style.removeProperty("color");
}

function renderAttempts(): void {
  const panel = $("attemptspanel");
  const list = $("attempts");
  if (!panel || !list) return;
  if (state.attempts.length === 0) return;
  panel.classList.remove("hidden");

  const best = state.attempts.reduce<number | null>(
    (m, a) => (a.distance !== null && (m === null || a.distance < m) ? a.distance : m),
    null,
  );

  list.innerHTML = state.attempts
    .map((a, i) => {
      const d = a.distance;
      const pct = d === null ? 0 : Math.max(0, Math.min(100, 100 - d));
      const isBest = d !== null && d === best;
      return `
        <div class="attempt">
          <div class="row" style="justify-content:space-between">
            <div><strong>${i + 1}. ${escapeHtml(a.preset.name)}</strong>
              ${isBest ? '<span class="tag" style="color:var(--good);border-color:var(--good)">best</span>' : ""}
            </div>
            <div class="row">
              <span class="dist">${d === null ? "…" : d.toFixed(1)}</span>
              <button data-play="${a.presetId}">▶︎</button>
            </div>
          </div>
          <div class="muted" style="font-size:13px">${escapeHtml(a.rationale)}</div>
          <div class="bar"><i style="width:${pct}%"></i></div>
        </div>`;
    })
    .join("");

  list.querySelectorAll<HTMLButtonElement>("[data-play]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const a = state.attempts.find((x) => x.presetId === btn.dataset.play);
      if (!a) return;
      await ensureAudio();
      setLivePreset(a.preset);
      playNote(midiForTarget(), 0.9, 1.5);
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function midiForTarget(): number {
  const f0 = state.target?.features.f0Hz ?? 220;
  return Math.round(69 + 12 * Math.log2(f0 / 440));
}

function logChat(who: string, text: string): void {
  const el = $("chatlog");
  if (!el) return;
  el.innerHTML += `<div><strong>${escapeHtml(who)}:</strong> ${escapeHtml(text)}</div>`;
}

// --- the loop --------------------------------------------------------------

async function start(file: File): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  state.attempts = [];
  renderAttempts();

  try {
    setStatus(`Analyzing ${file.name}…`);
    const target = await analyzeTarget(file);
    state.target = target;

    const info = $("targetinfo")!;
    info.classList.remove("hidden");
    info.innerHTML =
      `<span class="tag">target</span> ${escapeHtml(file.name)} · ` +
      `${target.features.f0Hz.toFixed(1)} Hz · ${target.features.durationMs} ms ` +
      `<button id="playtarget">▶︎ target</button>`;
    $("playtarget")?.addEventListener("click", async () => {
      await ensureAudio();
      playBuffer(target.prepared);
    });

    setStatus("Asking the agent for a first preset…");
    state.sessionId = await apiClient.createSession();
    const step = await apiClient.setTarget(state.sessionId, target.features, target.info);
    await drain(step);
  } catch (err) {
    setStatus(`Failed: ${String(err)}`);
  } finally {
    state.busy = false;
  }
}

/**
 * Render → analyze → report, for as long as the agent keeps proposing.
 * A render failure is reported to the agent rather than thrown: an out-of-range
 * preset must not wedge the session, and the agent can self-correct.
 */
async function drain(step: Step): Promise<void> {
  const sessionId = state.sessionId!;

  while (step.kind === "render") {
    // Capture before the awaits: reassigning `step` inside try/catch loses the
    // narrowing, so the catch block can no longer see these fields.
    const { presetId, preset, iterationsRemaining } = step;

    state.current = preset;
    state.attempts.push({ presetId, preset, rationale: step.rationale, distance: null, features: null });
    renderAttempts();
    setStatus(`Rendering “${preset.name}” (${iterationsRemaining} left)…`);

    try {
      const { features, diff } = await evaluatePreset(preset, state.target!);
      const a = state.attempts.find((x) => x.presetId === presetId);
      if (a) { a.distance = diff.distance; a.features = features; }
      renderAttempts();
      setStatus(`distance ${diff.distance.toFixed(1)} — ${diff.verdict}`);
      step = await apiClient.submitAnalysis(sessionId, presetId, features, diff);
    } catch (err) {
      // A bad preset must not wedge the session — report it and let the agent
      // self-correct rather than throwing out of the loop.
      setStatus(`Render failed, telling the agent: ${String(err)}`);
      step = await apiClient.submitRenderError(sessionId, presetId, String(err));
    }
  }

  if (step.kind === "done") {
    state.current = step.preset;
    await ensureAudio().catch(() => {});
    setLivePreset(step.preset);
    setStatus(
      `Done — “${step.preset.name}”${step.distance !== null ? ` at distance ${step.distance.toFixed(1)}` : ""}.`,
      "good",
    );
    logChat("agent", step.text);
    $("chatpanel")?.classList.remove("hidden");
  } else if (step.kind === "message") {
    if (step.preset) { state.current = step.preset; setLivePreset(step.preset); }
    setStatus("Ready.");
    logChat("agent", step.text);
    $("chatpanel")?.classList.remove("hidden");
  } else if (step.kind === "error") {
    setStatus(`Agent error: ${step.message}`);
  }
}

async function sendChat(): Promise<void> {
  const input = $<HTMLInputElement>("chat");
  if (!input || !state.sessionId || state.busy) return;
  const msg = input.value.trim();
  if (!msg) return;
  input.value = "";
  logChat("you", msg);
  state.busy = true;
  try {
    setStatus("Thinking…");
    await drain(await apiClient.chat(state.sessionId, msg));
  } catch (err) {
    setStatus(`Failed: ${String(err)}`);
  } finally {
    state.busy = false;
  }
}

// --- boot ------------------------------------------------------------------

async function boot(): Promise<void> {
  shell();
  try {
    const res = await api("/api/ping");
    const info = (await res.json()) as { hasAnthropicKey?: boolean };
    if (!info.hasAnthropicKey) {
      setStatus("Worker has no ANTHROPIC_API_KEY set — the agent loop will fail until it's added.");
    }
  } catch (err) {
    setStatus(`Could not reach the API: ${String(err)}`);
  }
}

boot().catch((e) => {
  const el = $("boot");
  if (el) el.textContent = `boot failed: ${String(e)}`;
});
