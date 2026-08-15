/**
 * UI + the drain loop.
 *
 * The whole client is driven by one union: every endpoint returns a `Step`, and
 * `drain()` keeps rendering-and-reporting for as long as the agent keeps asking
 * for renders. A chat turn ("brighter") flows through the identical path.
 */

import type { ClaudioPreset } from "../shared/preset";
import { looksLikeSessionId, type SessionSnapshot, type Step } from "../shared/protocol";
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
  renderIdle,
  setLivePreset,
  type TargetAnalysis,
} from "./audio";

/** Plain JSON fetch. The app is open — no key, no gate. */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return fetch(path, { ...init, headers });
}

// --- session addressing ----------------------------------------------------

/**
 * Sessions live at /<SESSION_ID>, so a run is bookmarkable and shareable and
 * survives a reload. The id is minted server-side on first upload; until then
 * the app sits at / with no session at all.
 */
function sessionIdFromUrl(): string | null {
  const seg = location.pathname.split("/").filter(Boolean)[0];
  return seg && looksLikeSessionId(seg) ? seg : null;
}

function putSessionInUrl(id: string): void {
  history.replaceState({}, "", `/${id}`);
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
  loadedPresetId: null as string | null,
  busy: false,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const app = () => document.getElementById("app")!;

// --- rendering -------------------------------------------------------------

function shell(): void {
  app().innerHTML = `
    <h1>Claudio</h1>
    <p class="sub">Upload a sound. An agent reverse-engineers it into an FM patch, then you talk to it.</p>

    <div class="layout">
      <aside class="rail">
        <div class="panel hidden" id="attemptspanel">
          <div class="row" style="margin-bottom:6px;justify-content:space-between">
            <span class="tag">iterations</span>
            <span class="muted" style="font-size:12px">click one to load it</span>
          </div>
          <div id="attempts"></div>
        </div>
      </aside>

      <section>
        <div class="panel">
          <div id="drop">Drop a WAV here, or click to choose
            <input id="file" type="file" accept="audio/*" class="hidden" />
          </div>
          <div id="targetinfo" class="row muted hidden" style="margin-top:12px"></div>
        </div>

        <div class="panel" id="statuspanel">
          <div class="row"><span class="tag">status</span><span id="status" class="muted">Waiting for a sample.</span></div>
        </div>

        <div class="panel" id="kbpanel">
          <div class="row" style="justify-content:space-between;margin-bottom:8px">
            <span class="row" style="gap:8px">
              <span class="tag">play</span>
              <span id="nowplaying" class="muted" style="font-size:12px">init patch</span>
            </span>
            <span class="muted" style="font-size:12px">
              click the keys, or type — <code>A S D F&hellip;</code> naturals, <code>W E T Y U</code> sharps ·
              <code>Z</code>/<code>X</code> shifts octave · chords work
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
        </div>
      </section>
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

/**
 * The standard tracker/DAW two-row layout: home row is the white keys, the row
 * above holds the sharps, positioned so they sit where the black keys actually
 * are. Note the gaps — there is deliberately no binding above D (E/F have no
 * black key between them) or above G (likewise B/C), which is what makes the
 * shape feel like a keyboard rather than an arbitrary strip of buttons.
 *
 *   w   e       t   y   u       o   p
 *  C#  D#      F#  G#  A#     C#' D#'
 * a   s   d   f   g   h   j   k   l   ;
 * C   D   E   F   G   A   B   C'  D'  E'
 */
const KEY_MAP: Record<string, number> = {
  // white
  a: 0, s: 2, d: 4, f: 5, g: 7, h: 9, j: 11, k: 12, l: 14, ";": 16,
  // black
  w: 1, e: 3, t: 6, y: 8, u: 10, o: 13, p: 15,
};

/** Reverse lookup so each drawn key can print the letter that plays it. */
const LABEL_FOR_SEMITONE = new Map<number, string>(
  Object.entries(KEY_MAP).map(([k, semi]) => [semi, k === ";" ? ";" : k.toUpperCase()]),
);

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
    const label = LABEL_FOR_SEMITONE.get(i) ?? "";
    if (BLACK.has(i % 12)) {
      // Straddles the gap between the previous white key and the next one.
      blacks.push(
        `<div class="key black" data-midi="${midi}" style="left:calc(${whiteIndex} * var(--kw) - var(--kw) * 0.3)">` +
          `<span>${label}</span></div>`,
      );
    } else {
      whites.push(`<div class="key white" data-midi="${midi}"><span>${label}</span></div>`);
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
  noteOff(midi);
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
      noteOff(); // release everything — the old midi numbers are gone
      buildKeyboard();
      return;
    }
    const semi = KEY_MAP[k];
    if (semi === undefined) return;
    press(k, octaveBase + semi);
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

function setStatus(text: string, tone: "muted" | "good" | "working" = "muted"): void {
  const el = $("status");
  const panel = $("statuspanel");
  if (!el) return;
  // Animated dots, so waiting *feels* like waiting rather than reading as a
  // frozen sentence.
  el.innerHTML =
    escapeHtml(text) + (tone === "working" ? '<span class="dots"><i></i><i></i><i></i></span>' : "");
  el.className = tone === "good" ? "" : "muted";
  if (tone === "good") el.style.color = "var(--good)";
  else el.style.removeProperty("color");
  panel?.classList.toggle("working", tone === "working");
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
      const pending = d === null;
      const pct = pending ? 0 : Math.max(0, Math.min(100, 100 - d));
      const isBest = !pending && d === best;
      const isLoaded = state.loadedPresetId === a.presetId;
      return `
        <div class="attempt ${pending ? "working" : ""}" data-load="${a.presetId}" style="cursor:pointer">
          <div class="row" style="justify-content:space-between">
            <div><strong>${i + 1}. ${escapeHtml(a.preset.name)}</strong>
              ${isBest ? '<span class="tag" style="color:var(--good);border-color:var(--good)">best</span>' : ""}
              ${isLoaded ? '<span class="tag" style="color:var(--accent);border-color:var(--accent)">loaded</span>' : ""}
            </div>
            <span class="dist">${pending ? "" : d.toFixed(1)}</span>
          </div>
          <div class="muted" style="font-size:13px">${escapeHtml(a.rationale)}</div>
          <div class="bar"><i style="width:${pct}%"></i></div>
        </div>`;
    })
    .join("");

  // Any attempt is loadable at any time, finished or not — the user may simply
  // like one and want to keep playing it.
  list.querySelectorAll<HTMLElement>("[data-load]").forEach((el) => {
    el.addEventListener("click", async () => {
      const a = state.attempts.find((x) => x.presetId === el.dataset.load);
      if (a) await loadPreset(a.preset, a.presetId, { audition: true });
    });
  });
}

/**
 * Make a preset the audible one.
 *
 * Waits for render-idle first: `Tone.Offline` swaps the GLOBAL Tone context
 * while it runs, so constructing the live voice mid-render would build it in
 * the offline context and it would never be heard.
 */
async function loadPreset(
  preset: ClaudioPreset,
  presetId: string | null,
  opts: { audition?: boolean } = {},
): Promise<void> {
  await renderIdle();
  state.current = preset;
  state.loadedPresetId = presetId;
  setLivePreset(preset);
  const label = $("nowplaying");
  if (label) label.textContent = preset.name;
  renderAttempts();
  if (opts.audition) {
    await ensureAudio();
    playNote(midiForTarget(), 0.9, 1.5);
  }
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
    setStatus(`Analyzing ${file.name}`, "working");
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

    setStatus("Listening to your sample, sketching a patch", "working");
    // A fresh upload is a fresh session, so the old URL keeps its own history.
    state.sessionId = await apiClient.createSession();
    putSessionInUrl(state.sessionId);
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
    setStatus(`Rendering “${preset.name}” · ${iterationsRemaining} left`, "working");

    try {
      const { features, diff } = await evaluatePreset(preset, state.target!);
      const a = state.attempts.find((x) => x.presetId === presetId);
      if (a) { a.distance = diff.distance; a.features = features; }
      // Load it the moment it has been rendered, so the newest patch is always
      // playable — the user may like an in-progress one and want to keep it.
      await loadPreset(preset, presetId);
      setStatus(`distance ${diff.distance.toFixed(1)} — ${diff.verdict}`, "working");
      step = await apiClient.submitAnalysis(sessionId, presetId, features, diff);
    } catch (err) {
      // A bad preset must not wedge the session — report it and let the agent
      // self-correct rather than throwing out of the loop.
      setStatus(`Render failed, telling the agent: ${String(err)}`);
      step = await apiClient.submitRenderError(sessionId, presetId, String(err));
    }
  }

  if (step.kind === "done") {
    await loadPreset(step.preset, step.presetId);
    setStatus(
      `Done — “${step.preset.name}”${step.distance !== null ? ` at distance ${step.distance.toFixed(1)}` : ""}.`,
      "good",
    );
    logChat("agent", step.text);
    renderChips(step.suggestions);
    $("chatpanel")?.classList.remove("hidden");
  } else if (step.kind === "message") {
    if (step.preset) await loadPreset(step.preset, null);
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
    setStatus("Thinking", "working");
    await drain(await apiClient.chat(state.sessionId, msg));
  } catch (err) {
    setStatus(`Failed: ${String(err)}`);
  } finally {
    state.busy = false;
  }
}

// --- boot ------------------------------------------------------------------

/**
 * Rebuild the UI from a session's stored history.
 *
 * The uploaded AUDIO is not recoverable — we never persist it, only the feature
 * vector it produced. That is enough to keep iterating (renders are specced
 * from the features), but the target itself can no longer be auditioned, so we
 * don't offer a button that would silently do nothing.
 */
async function restoreSession(id: string): Promise<void> {
  let snap: SessionSnapshot;
  try {
    snap = await apiClient.snapshot(id);
  } catch {
    setStatus("Could not load that session — drop a sample to start a new one.");
    return;
  }
  if (!snap?.target || !snap.history?.length) {
    setStatus("That session is empty — drop a sample to begin.");
    return;
  }

  state.sessionId = id;
  state.target = {
    features: snap.target,
    info: snap.targetInfo ?? { filename: "restored", durationSec: 0, sampleRate: snap.target.sampleRate },
    // No audio: reconstructed sessions can render and diff, but not play the target.
    prepared: { data: new Float32Array(0), sampleRate: snap.target.sampleRate },
  };
  state.attempts = snap.history.map((a) => ({
    presetId: a.presetId,
    preset: a.preset,
    rationale: a.rationale,
    distance: a.distance,
    features: a.features,
  }));
  renderAttempts();

  const info = $("targetinfo");
  if (info) {
    info.classList.remove("hidden");
    info.innerHTML =
      `<span class="tag">target</span> ${escapeHtml(snap.targetInfo?.filename ?? "restored session")} · ` +
      `${snap.target.f0Hz.toFixed(1)} Hz · ${snap.target.durationMs} ms ` +
      `<span class="muted">(audio not stored — reload can't replay it)</span>`;
  }

  const best =
    state.attempts.find((a) => a.presetId === snap.bestPresetId) ??
    state.attempts[state.attempts.length - 1];
  if (best) await loadPreset(best.preset, best.presetId);
  $("chatpanel")?.classList.remove("hidden");
  setStatus(`Restored ${state.attempts.length} iteration(s). Play it, or keep tweaking.`, "good");
}

async function boot(): Promise<void> {
  shell();
  bindTypingKeyboard();
  try {
    const res = await api("/api/ping");
    const info = (await res.json()) as { hasAnthropicKey?: boolean };
    if (!info.hasAnthropicKey) {
      setStatus("Worker has no ANTHROPIC_API_KEY set — the agent loop will fail until it's added.");
      return;
    }
    const existing = sessionIdFromUrl();
    if (existing) await restoreSession(existing);
  } catch (err) {
    setStatus(`Could not reach the API: ${String(err)}`);
  }
}

boot().catch((e) => {
  const el = $("boot");
  if (el) el.textContent = `boot failed: ${String(e)}`;
});
