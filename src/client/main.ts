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
  noteOff,
  noteOn,
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

    <div class="panel" id="kbpanel">
      <div class="row" style="justify-content:space-between;margin-bottom:8px">
        <span class="tag">play</span>
        <span class="muted" style="font-size:12px">
          click the keys, or use <code>A S D F G H J K</code> · <code>Z</code>/<code>X</code> to shift octave
        </span>
      </div>
      <div id="keyboard"></div>
    </div>

    <div class="panel hidden" id="chatpanel">
      <div id="chips" class="row" style="margin-bottom:10px"></div>
      <div class="row">
        <input id="chat" type="text" placeholder="glassier · more punch · hollow it out" style="flex:1" />
        <button id="send">Send</button>
      </div>
      <div id="chatlog" class="muted" style="margin-top:10px"></div>
    </div>`;

  buildKeyboard();

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

  $("send")?.addEventListener("click", () => sendChat());
  $<HTMLInputElement>("chat")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });
}

// --- keyboard --------------------------------------------------------------

/** Two octaves, so a patch can be judged in more than one register. */
const KB_SEMITONES = 24;
const BLACK = new Set([1, 3, 6, 8, 10]);
/** Home-row layout, white keys only — enough to noodle without learning a map. */
const TYPING_KEYS = ["a", "s", "d", "f", "g", "h", "j", "k", "l", ";"];

let octaveBase = 48; // C3
const held = new Map<string, number>();

function buildKeyboard(): void {
  const kb = $("keyboard");
  if (!kb) return;

  const whites: string[] = [];
  const blacks: string[] = [];
  let whiteIndex = 0;

  for (let i = 0; i < KB_SEMITONES; i++) {
    const midi = octaveBase + i;
    if (BLACK.has(i % 12)) {
      // Positioned against the preceding white key's slot.
      blacks.push(
        `<div class="key black" data-midi="${midi}" style="left:calc(${whiteIndex} * var(--kw) - var(--kw) * 0.3)"></div>`,
      );
    } else {
      const label = TYPING_KEYS[whiteIndex]?.toUpperCase() ?? "";
      whites.push(
        `<div class="key white" data-midi="${midi}"><span>${label}</span></div>`,
      );
      whiteIndex++;
    }
  }

  kb.innerHTML =
    `<div class="keys" style="--kw:calc(100% / ${whiteIndex})">${whites.join("")}${blacks.join("")}</div>` +
    `<div class="muted" style="font-size:12px;margin-top:6px">octave: C${Math.floor(octaveBase / 12) - 1}</div>`;

  kb.querySelectorAll<HTMLElement>(".key").forEach((el) => {
    const midi = Number(el.dataset.midi);
    const down = (e: Event) => {
      e.preventDefault();
      press(`m${midi}`, midi, el);
    };
    el.addEventListener("mousedown", down);
    el.addEventListener("touchstart", down, { passive: false });
    el.addEventListener("mouseup", () => release(`m${midi}`));
    el.addEventListener("mouseleave", () => release(`m${midi}`));
    el.addEventListener("touchend", () => release(`m${midi}`));
  });
}

function keyEl(midi: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.key[data-midi="${midi}"]`);
}

async function press(id: string, midi: number, el?: HTMLElement | null): Promise<void> {
  if (held.has(id)) return;
  held.set(id, midi);
  (el ?? keyEl(midi))?.classList.add("on");
  await ensureAudio();
  noteOn(midi, 0.9);
}

function release(id: string): void {
  const midi = held.get(id);
  if (midi === undefined) return;
  held.delete(id);
  keyEl(midi)?.classList.remove("on");
  // Monophonic: only release when nothing else is being held.
  if (held.size === 0) noteOff();
  else {
    const last = [...held.values()].pop()!;
    noteOn(last, 0.9);
  }
}

function bindTypingKeyboard(): void {
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;

    const k = e.key.toLowerCase();
    if (k === "z" || k === "x") {
      octaveBase = Math.min(84, Math.max(24, octaveBase + (k === "x" ? 12 : -12)));
      held.clear();
      noteOff();
      buildKeyboard();
      return;
    }
    const idx = TYPING_KEYS.indexOf(k);
    if (idx < 0) return;
    // Map the Nth white key back to a semitone offset.
    let seen = 0;
    for (let i = 0; i < KB_SEMITONES; i++) {
      if (BLACK.has(i % 12)) continue;
      if (seen === idx) { press(k, octaveBase + i); return; }
      seen++;
    }
  });
  window.addEventListener("keyup", (e) => release(e.key.toLowerCase()));
  window.addEventListener("blur", () => { held.clear(); noteOff(); });
}

// --- suggestion chips ------------------------------------------------------

function renderChips(suggestions: string[] | undefined): void {
  const row = $("chips");
  if (!row) return;
  if (!suggestions?.length) { row.innerHTML = ""; return; }
  row.innerHTML = suggestions
    .map((s, i) => `<button class="chip" data-i="${i}">${escapeHtml(s)}</button>`)
    .join("");
  row.querySelectorAll<HTMLButtonElement>(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const text = suggestions[Number(btn.dataset.i)];
      if (text) sendChat(text);
    });
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
    renderChips(step.suggestions);
    $("chatpanel")?.classList.remove("hidden");
  } else if (step.kind === "message") {
    if (step.preset) { state.current = step.preset; setLivePreset(step.preset); }
    setStatus("Ready.");
    logChat("agent", step.text);
    renderChips(step.suggestions);
    $("chatpanel")?.classList.remove("hidden");
  } else if (step.kind === "error") {
    setStatus(`Agent error: ${step.message}`);
  }
}

async function sendChat(preset?: string): Promise<void> {
  const input = $<HTMLInputElement>("chat");
  if (!state.sessionId || state.busy) return;
  const msg = (preset ?? input?.value ?? "").trim();
  if (!msg) return;
  if (input && !preset) input.value = "";
  renderChips([]); // chips are stale the moment one is used
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
  bindTypingKeyboard();
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
