/**
 * `?spike=1`: the band engine on its own (plan slice 1).
 *
 * Three hard-coded band parts plus your live channel, so the engine can be
 * heard ("the kit grooves and your keys feel instant") and driven by
 * e2e/spike.spec.ts through `window.__band` and `window.__spike`.
 *
 * Keys: Space start/stop · 1–4 focus (you, drums, bass, keys) · V swap the
 * focused part's variant · G glass keys sound · M mute focused ·
 * A–; and Q–P play your part (D minor) · Z/X octave.
 * URL: ?spike=1&bpm=96&bars=4
 */

import * as Tone from "tone";

import { degreeToMidi, type DrumHit, type Pattern, type PitchedNote } from "../shared/pattern";
import { DEFAULT_PRESET, type ClaudioPreset } from "../shared/preset";
import { renderPreset, specForPrompt } from "./audio";
import { BandEngine, loadKick, type ChannelId } from "./audio/engine";
import type { Harmony, PartRef, TrackId } from "./audio/sequencer";

// --- sounds ------------------------------------------------------------------

const preset = (name: string, p: Partial<ClaudioPreset>): ClaudioPreset => ({ ...DEFAULT_PRESET, name, ...p });

const SOUNDS: Record<string, ClaudioPreset> = {
  "rubber-bass": preset("Rubber Bass", {
    harmonicity: 1,
    modulationIndex: 5,
    ampEnv: { attack: 0.004, decay: 0.3, sustain: 0.5, release: 0.1 },
    modEnv: { attack: 0.004, decay: 0.14, sustain: 0.15, release: 0.1 },
    gain: 0.9,
  }),
  "spike-ep": preset("Spike EP", {
    harmonicity: 1,
    modulationIndex: 3,
    carrierFm: { ratio: 14, index: 0.4 },
    ampEnv: { attack: 0.004, decay: 1.2, sustain: 0.2, release: 0.5 },
    modEnv: { attack: 0.004, decay: 0.5, sustain: 0.1, release: 0.4 },
    gain: 0.7,
  }),
  "glass-ep": preset("Glass EP", {
    harmonicity: 3.5,
    modulationIndex: 7,
    carrierFm: { ratio: 7, index: 1 },
    ampEnv: { attack: 0.004, decay: 1.5, sustain: 0.15, release: 0.8 },
    modEnv: { attack: 0.004, decay: 0.3, sustain: 0.05, release: 0.5 },
    gain: 0.6,
  }),
  "soft-pad": preset("Soft Pad", {
    harmonicity: 2,
    modulationIndex: 2,
    carrierWave: "triangle",
    ampEnv: { attack: 0.03, decay: 0.6, sustain: 0.7, release: 0.6 },
    modEnv: { attack: 0.2, decay: 1, sustain: 0.5, release: 0.6 },
    gain: 0.6,
  }),
};

// --- parts -------------------------------------------------------------------

const kit = (spec: Record<string, number[]>, accents: number[] = []): Pattern => ({
  lengthBars: 1,
  notes: Object.entries(spec).flatMap(([voice, steps]) =>
    steps.map((step): DrumHit => ({ step, voice: voice as DrumHit["voice"], vel: voice === "kick" ? 0.95 : 0.7, accent: accents.includes(step) })),
  ),
});
const notes = (list: Array<[step: number, deg: number, len: number, accent?: boolean]>): Pattern => ({
  lengthBars: 1,
  notes: list.map(([step, deg, len, accent]): PitchedNote => ({ step, deg, len, vel: 0.75, accent: !!accent, tie: false })),
});
const chord = (steps: number[], len: number) => steps.flatMap((s) => [0, 2, 4].map((d): [number, number, number] => [s, d, len]));

const VARIANTS: Record<TrackId, Record<string, Pattern>> = {
  drums: {
    a: kit({ kick: [0, 8, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12], openhat: [14] }, [0]),
    busy: kit({ kick: [0, 3, 6, 8, 11], snare: [4, 12], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15], openhat: [14] }, [0, 4, 8, 12]),
  },
  bass: {
    a: notes([[0, 0, 3, true], [6, 0, 2], [8, 0, 3], [14, 4, 2]]),
    busy: notes([[0, 0, 1, true], [2, 0, 1], [4, 7, 1], [6, 0, 1], [8, 0, 1, true], [10, 4, 1], [12, 0, 1], [14, 2, 1]]),
  },
  keys: {
    a: notes(chord([0], 3).concat(chord([6], 2), chord([12], 2))),
    busy: notes(chord([2, 6, 10, 14], 1)),
  },
};
const variantOrder = ["a", "busy"];

// --- page --------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const harmony: Harmony = {
  bpm: Number(params.get("bpm") ?? 96),
  keyPc: 2,
  scale: "minor",
  progression: [0, 5, 2, 6],
  bars: ([1, 2, 4] as const).find((b) => b === Number(params.get("bars"))) ?? 4,
};

document.title = "Claudio · engine spike";
document.head.insertAdjacentHTML(
  "beforeend",
  `<style>
    body{margin:0;background:#101114;color:#d8d8dc;font:13px/1.4 ui-monospace,Menlo,monospace}
    .spike{max-width:980px;margin:0 auto;padding:16px}
    .lane{display:grid;grid-template-columns:220px 1fr;gap:12px;align-items:center;padding:8px;border-bottom:1px solid #26272c}
    .lane.focus{background:#1a1c22}
    .lane.muted .grid{opacity:.35}
    .grid{display:grid;grid-template-columns:repeat(16,1fr);gap:2px}
    .cell{height:26px;background:#1c1d22;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#9aa}
    .cell.on{background:#2f4a6b;color:#e8f0ff}.cell.acc{font-weight:700;background:#3e6390}
    .cell.play{outline:2px solid #f0c040}
    .status{color:#8a8f99;font-size:12px}
    #flood{max-height:120px;overflow:auto;color:#667;font-size:11px;margin-top:12px}
    kbd{background:#24262c;border-radius:3px;padding:0 4px}
  </style>`,
);
document.body.innerHTML = `<div class="spike">
  <h2>Engine spike · D minor · <span id="bpm"></span> bpm · <span id="bars"></span> bars</h2>
  <p class="status" id="hint"><kbd>Space</kbd> start/stop · <kbd>1</kbd>–<kbd>4</kbd> focus · <kbd>V</kbd> variant · <kbd>G</kbd> glass keys · <kbd>M</kbd> mute · <kbd>A</kbd>–<kbd>;</kbd> <kbd>Q</kbd>–<kbd>P</kbd> play · <kbd>Z</kbd>/<kbd>X</kbd> octave</p>
  <div id="lanes"></div>
  <p class="status">g <span id="g">–</span> · missed steps <span id="missed">0</span> · you: octave <span id="oct">4</span></p>
  <div id="flood"></div>
</div>`;
document.getElementById("bpm")!.textContent = String(harmony.bpm);
document.getElementById("bars")!.textContent = String(harmony.bars);

const LANES: ChannelId[] = ["you", "drums", "bass", "keys"];
const lanesEl = document.getElementById("lanes")!;
for (const id of LANES) {
  lanesEl.insertAdjacentHTML(
    "beforeend",
    `<div class="lane" id="lane-${id}" data-testid="lane-${id}">
      <div><b>${LANES.indexOf(id) + 1} ${id}</b><div class="status" id="st-${id}"></div></div>
      <div class="grid" id="grid-${id}">${'<div class="cell"></div>'.repeat(16)}</div>
    </div>`,
  );
}

const state = {
  variant: { drums: "a", bass: "a", keys: "a" } as Record<TrackId, string>,
  keysSound: "spike-ep",
  focus: "drums" as ChannelId,
  muted: new Set<ChannelId>(),
  octave: 4,
};

function partFor(track: TrackId, variant: string): PartRef {
  const sound = track === "drums" ? null : track === "bass" ? "rubber-bass" : state.keysSound;
  return { id: sound && track === "keys" ? `${track}:${variant}:${sound}` : `${track}:${variant}`, sound, role: track, pattern: VARIANTS[track][variant] };
}

function drawGrid(id: ChannelId): void {
  const cells = document.getElementById(`grid-${id}`)!.children;
  const pattern = id === "you" ? null : VARIANTS[id][state.variant[id]];
  for (let i = 0; i < 16; i++) {
    const c = cells[i] as HTMLElement;
    const here = pattern?.notes.filter((n) => n.step === i) ?? [];
    c.classList.toggle("on", here.length > 0);
    c.classList.toggle("acc", here.some((n) => n.accent));
    c.textContent = here.map((n) => ("voice" in n ? n.voice[0] : String(n.deg))).join("");
  }
}

function drawStatus(): void {
  for (const id of LANES) {
    const el = document.getElementById(`lane-${id}`)!;
    el.classList.toggle("focus", state.focus === id);
    el.classList.toggle("muted", state.muted.has(id));
    const st = document.getElementById(`st-${id}`)!;
    if (id === "you") {
      st.textContent = `LIVE · ${SOUNDS["soft-pad"].name}${state.muted.has(id) ? " · muted" : ""}`;
      continue;
    }
    const n = engine.landsIn(id);
    const sound = id === "drums" ? "Kit" : id === "bass" ? SOUNDS["rubber-bass"].name : SOUNDS[state.keysSound].name;
    st.textContent = `${sound} · ${state.variant[id]}${n !== null && engine.running ? ` · lands in ${Math.ceil(n / 4)} beats` : ""}${state.muted.has(id) ? " · muted" : ""}`;
  }
}

let lastPlay = -1;
function onStep(g: number): void {
  const s = ((g % 16) + 16) % 16;
  for (const id of LANES) {
    const cells = document.getElementById(`grid-${id}`)!.children;
    if (lastPlay >= 0) cells[lastPlay].classList.remove("play");
    cells[s].classList.add("play");
  }
  lastPlay = s;
  document.getElementById("g")!.textContent = String(g);
  document.getElementById("missed")!.textContent = String(engine.missedSteps);
  drawStatus();
}

// --- engine --------------------------------------------------------------------

const kick = await loadKick();
const engine = new BandEngine({ harmony, kick, yourSound: SOUNDS["soft-pad"], spy: true, onStep });

function stageTrack(track: TrackId, variant: string): void {
  if (!VARIANTS[track][variant]) throw new Error(`no variant ${variant} for ${track}`);
  state.variant[track] = variant;
  const part = partFor(track, variant);
  engine.stage(track, part, part.sound ? SOUNDS[part.sound] : null);
  drawGrid(track);
  drawStatus();
}
for (const t of ["drums", "bass", "keys"] as TrackId[]) stageTrack(t, "a");
for (const id of LANES) drawGrid(id);

// --- keys ----------------------------------------------------------------------

const HOME = ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon"];
const TOP = ["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP"];
const sounding = new Map<string, number>();

function degreeFor(code: string): number | null {
  const h = HOME.indexOf(code);
  if (h >= 0) return h;
  const t = TOP.indexOf(code);
  return t >= 0 ? t + 7 : null;
}

async function toggleTransport(): Promise<void> {
  await Tone.start();
  if (engine.running) engine.stop();
  else engine.start();
  drawStatus();
}

window.addEventListener(
  "keydown",
  (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const deg = degreeFor(e.code);
    if (deg !== null) {
      e.preventDefault();
      if (e.repeat || sounding.has(e.code)) return;
      void Tone.start();
      const midi = degreeToMidi(harmony.keyPc, harmony.scale, deg, state.octave);
      sounding.set(e.code, midi);
      engine.liveAttack(midi);
      return;
    }
    if (e.repeat) return;
    const focusKeys: Record<string, ChannelId> = { Digit1: "you", Digit2: "drums", Digit3: "bass", Digit4: "keys" };
    if (e.code === "Space") void toggleTransport();
    else if (focusKeys[e.code]) state.focus = focusKeys[e.code];
    else if (e.code === "KeyZ") state.octave = Math.max(1, state.octave - 1);
    else if (e.code === "KeyX") state.octave = Math.min(6, state.octave + 1);
    else if (e.code === "KeyM") {
      const m = !state.muted.has(state.focus);
      if (m) state.muted.add(state.focus);
      else state.muted.delete(state.focus);
      engine.setMuted(state.focus, m);
    } else if (e.code === "KeyV" && state.focus !== "you") {
      const t = state.focus;
      stageTrack(t, variantOrder[(variantOrder.indexOf(state.variant[t]) + 1) % variantOrder.length]);
    } else if (e.code === "KeyG") {
      state.keysSound = state.keysSound === "spike-ep" ? "glass-ep" : "spike-ep";
      stageTrack("keys", state.variant.keys);
    } else return;
    e.preventDefault();
    document.getElementById("oct")!.textContent = String(state.octave);
    drawStatus();
  },
  { capture: true },
);

window.addEventListener(
  "keyup",
  (e) => {
    const midi = sounding.get(e.code);
    if (midi === undefined) return;
    e.preventDefault();
    sounding.delete(e.code);
    engine.liveRelease(midi);
  },
  { capture: true },
);

// --- test hooks ----------------------------------------------------------------

async function onsetTest() {
  const sampleRate = 44100;
  const bpm = 120;
  const steps = [0, 8];
  // Onset = where the sound starts: the first sample above 2% of the peak.
  // Kicks are 1s apart and the sample is 0.91s long, so each starts from silence.
  const peakOf = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const firstAbove = (x: Float32Array, from: number, to: number, t: number) => {
    for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) if (Math.abs(x[i]) > t) return i;
    return null;
  };
  const k = kick.getChannelData(0);
  const kickOffsetSec = (firstAbove(k, 0, k.length, 0.02 * peakOf(k)) ?? 0) / kick.sampleRate;

  const rendered = await Tone.Offline(
    async (ctx) => {
      const eng = new BandEngine({
        harmony: { bpm, keyPc: 2, scale: "minor", progression: [0], bars: 1 },
        kick,
        yourSound: SOUNDS["soft-pad"],
        context: ctx,
      });
      eng.stage(
        "drums",
        { id: "onset", sound: null, role: "drums", pattern: { lengthBars: 1, notes: steps.map((step): DrumHit => ({ step, voice: "kick", vel: 1, accent: false })) } },
        null,
      );
      eng.start(0);
    },
    (60 / bpm) * 4,
    1,
    sampleRate,
  );
  const x = rendered.getChannelData(0);
  const stepSec = 60 / bpm / 4;
  const expected = steps.map((s) => Math.round((s * stepSec + kickOffsetSec) * sampleRate));
  const win = Math.round(0.04 * sampleRate);
  const t = 0.02 * peakOf(x);
  const found = expected.map((e) => firstAbove(x, e - win / 4, e + win, t));
  return { sampleRate, expected, found };
}

Object.assign(window, {
  __band: {
    get g() {
      return engine.g;
    },
    get missedSteps() {
      return engine.missedSteps;
    },
    get running() {
      return engine.running;
    },
    promotions: engine.promotions,
    calls: engine.calls,
    landsIn: (t: TrackId) => engine.landsIn(t),
    lastG: () => engine.lastG(),
  },
  __spike: {
    ready: true,
    stage: (t: TrackId, v: string) => stageTrack(t, v),
    flood(rows: number) {
      const el = document.getElementById("flood")!;
      for (let i = 0; i < rows; i++) el.insertAdjacentHTML("beforeend", `<div>chat row ${el.childElementCount + 1}: bass, busier please</div>`);
    },
    redraw(times: number) {
      for (let i = 0; i < times; i++) for (const id of LANES) drawGrid(id);
      drawStatus();
    },
    async designRender() {
      const t0 = performance.now();
      await renderPreset(SOUNDS["glass-ep"], specForPrompt());
      return performance.now() - t0;
    },
    now: () => engine.context.currentTime,
    onsetTest,
  },
});
