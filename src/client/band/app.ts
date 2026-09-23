/**
 * The band UI (plan §7): the producer's screen. Lanes down (one playhead
 * column crosses every grid), the design rail in the strip, chat on the right.
 *
 * Data flows one way. Convex subscriptions feed `render()` and `reconcile()`;
 * reconcile stages each strip's newest part in the engine (which lands it at
 * the next bar line); the engine owns all sound. Keys go through the pure
 * `routeKey`. Nothing here is written at keystroke or audio rate except the
 * producer's own mutations.
 */

import * as Tone from "tone";

import { BandEngine, loadKick, type ChannelId } from "../audio/engine";
import type { Harmony, PartRef, TrackId } from "../audio/sequencer";
import { band, convexUrl, errorText, type ChatRow, type JamState, type LibraryRow, type Pip, type Strip } from "../convex";
import { DRUM_VOICES, ROLE_OCTAVE, STEPS_PER_BAR, degreeToMidi } from "../../shared/pattern";
import type { DrumHit, Pattern, PitchedNote, Scale } from "../../shared/pattern";
import { newSessionId } from "../../shared/protocol";
import { routeKey, type KeyAction, type Mode, type Strip as StripKey } from "./keys";
import { CSS } from "./styles";

// ---------------------------------------------------------------------------
// Address and options
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const SLUG_RE = /^[A-Za-z0-9]{6,24}$/;
let slug = location.pathname.split("/").filter(Boolean)[0] ?? "";
if (!SLUG_RE.test(slug)) {
  slug = newSessionId();
  history.replaceState({}, "", `/${slug}${location.search}`);
}
const createOpts = {
  bpm: params.get("bpm") ? Number(params.get("bpm")) : undefined,
  bars: ([1, 2, 4] as const).find((b) => b === Number(params.get("bars"))),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const ROLE_KEY: Record<Strip["role"], StripKey> = { producer: "you", drums: "drums", bass: "bass", keys: "keys" };
const KEY_ROLE: Record<StripKey, Strip["role"]> = { you: "producer", drums: "drums", bass: "bass", keys: "keys" };
const ORDER: Strip["role"][] = ["producer", "drums", "bass", "keys"];
const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const HOME_KEYS = ["A", "S", "D", "F", "G", "H", "J", "K", "L", ";"];

let state: JamState | null = null;
let chatRows: ChatRow[] = [];
const rails = new Map<string, Pip[]>();
const railSubs = new Map<string, () => void>();

const ui = {
  mode: "play" as Mode,
  focus: null as StripKey | null,
  octave: 4,
  /** key code → the live note it started */
  held: new Map<string, { midi: number; on: "you" | "bass" | "keys" } | { hit: true }>(),
  localMute: new Map<Strip["role"], boolean>(),
  solo: new Set<Strip["role"]>(),
  picker: null as null | { strip: StripKey; rows: LibraryRow[]; sel: number },
  overlay: false,
  /** What each band track is actually sounding (from engine promotions). */
  sounding: new Map<TrackId, string>(),
};

let engine: BandEngine | null = null;
let lastHarmony = "";
let lastYouSound: string | null = null;

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

document.title = "Claudio Band";
document.head.insertAdjacentHTML("beforeend", `<style>${CSS}</style>`);
document.body.innerHTML = `
<div class="app stopped" id="app">
  <header class="topbar">
    <span class="brand">Claudio <span>Band</span></span>
    <span class="slug" id="slug"></span>
    <span class="chip" id="phase" data-testid="phase"></span>
    <span class="tp"><kbd>Space</kbd><span id="tp"></span></span>
    <span class="ctl"><span class="box" id="bpm"></span><small>bpm</small></span>
    <span class="ctl"><span class="box" id="key"></span></span>
    <span class="prog" id="prog"></span>
    <span class="ctl"><span class="box" id="bars"></span></span>
    <span class="pos" id="pos">–</span>
    <span class="spacer"></span>
    <span class="tp">scenes
      <button class="scene" id="scene-A" data-testid="scene-A" data-active="false">A</button>
      <button class="scene" id="scene-B" data-testid="scene-B" data-active="false">B</button>
    </span>
    <span class="reacts" id="reacts"></span>
  </header>
  <div class="body">
    <div class="main">
      <div class="strips" id="strips"></div>
      <div class="loopbar"><span id="loopn">loop</span><span class="lb"><i id="lbfill" style="--p:0"></i></span><span id="loopnext"></span></div>
      <div class="dock">
        <span class="mode play" id="mode" data-testid="mode">PLAY</span>
        <span class="kbrow" id="kbrow"></span>
        <span class="dockinfo" id="dockinfo"></span>
        <span class="r"><span><kbd>B</kbd> library</span><span><kbd>?</kbd> keys</span></span>
      </div>
    </div>
    <aside class="chat">
      <div class="h">Band chat</div>
      <div class="rows" id="chatrows" data-testid="chat"></div>
      <div class="cin"><input id="chatin" data-testid="chat-input" placeholder="@bass busier… (Enter or /)" autocomplete="off" /></div>
    </aside>
  </div>
</div>
<div id="modal"></div>
<div id="toast"></div>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
$("slug").textContent = slug;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function stripsInOrder(): Strip[] {
  if (!state) return [];
  return ORDER.map((r) => state!.musicians.find((m) => m.role === r)!).filter(Boolean);
}

function mutedOf(m: Strip): boolean {
  return ui.localMute.get(m.role) ?? m.muted;
}

function renderTop(): void {
  if (!state) return;
  const j = state.jam;
  const phase = $("phase");
  phase.textContent = j.phase;
  phase.className = `chip ${j.phase}`;
  $("bpm").textContent = String(j.bpm);
  $("key").textContent = `${NOTE_NAMES[j.keyPc]} ${j.scale}`;
  $("bars").textContent = `${j.bars} bar${j.bars === 1 ? "" : "s"}`;
  $("prog").innerHTML = j.progression.map((d, i) => `<span data-bar="${i}">${chordName(j.keyPc, j.scale, d)}</span>`).join("");
  for (const name of ["A", "B"] as const) {
    const el = $(`scene-${name}`);
    el.classList.toggle("saved", j.scenesSaved[name]);
    el.dataset.active = String(j.activeScene === name);
  }
  const r = $("reacts");
  r.className = `reacts${j.reactive ? "" : " off"}`;
  r.innerHTML = `band reacts <i>●</i>`;
  renderTransport();
}

function renderTransport(): void {
  const running = engine?.running ?? false;
  $("app").classList.toggle("stopped", !running);
  $("tp").innerHTML = running ? `<span class="play">▶ playing</span>` : state?.jam.phase === "soundcheck" ? "start the jam" : "■ stopped";
}

function chordName(keyPc: number, scale: Scale, deg: number): string {
  const root = degreeToMidi(keyPc, scale, deg, 4) % 12;
  const third = (degreeToMidi(keyPc, scale, deg + 2, 4) - degreeToMidi(keyPc, scale, deg, 4) + 12) % 12;
  return `${NOTE_NAMES[root]}${third === 3 ? "m" : ""}`;
}

function renderStrips(): void {
  const host = $("strips");
  const strips = stripsInOrder();
  for (const [i, m] of strips.entries()) {
    let el = document.getElementById(`strip-${m.role}`);
    if (!el) {
      el = document.createElement("section");
      el.id = `strip-${m.role}`;
      el.dataset.testid = `strip-${ROLE_KEY[m.role] === "you" ? "you" : m.role}`;
      el.setAttribute("data-testid", el.dataset.testid);
      host.appendChild(el);
    }
    el.className = `strip ${m.role}${ui.focus === ROLE_KEY[m.role] ? " focus" : ""}${mutedOf(m) ? " muted" : ""}`;
    el.innerHTML = `
      <div class="shead">
        <div class="nm"><span class="num">${i + 1}</span><span class="who">${esc(m.name)}</span>
          <button class="snd" data-pick="${m.role}" ${m.role === "drums" ? "disabled" : ""}>${esc(m.part.sound?.name ?? "Kit")}</button>
          <span class="ms"><span class="${mutedOf(m) ? "on" : ""}">M</span><span class="${ui.solo.has(m.role) ? "on" : ""}">S</span></span>
        </div>
        <span class="pill" data-pill="${m.role}"></span>
        <div class="rail" data-rail="${m.role}">${railHtml(m)}</div>
      </div>
      <div class="gwrap">${m.role === "producer" ? liveHtml() : gridHtml(m)}</div>`;
  }
  updatePills();
}

function railHtml(m: Strip): string {
  const pips = rails.get(m._id) ?? [];
  const track = m.role === "producer" ? null : (m.role as TrackId);
  const sounding = track && engine?.running ? ui.sounding.get(track) : undefined;
  const cur = sounding ? Number(sounding) : m.part.basedOn;
  const caption = pips.find((p) => p.basedOn === m.part.basedOn)?.caption ?? m.part.label;
  return (
    pips
      .map((p) => {
        const cls = p.basedOn === cur ? "cur" : p.basedOn === m.part.basedOn ? "stg" : "";
        return `<button class="pip ${cls}" data-jump="${m.role}:${p.basedOn}" title="${esc(p.caption)}">${p.label}</button>`;
      })
      .join("") + `<span class="rlabel">${esc(caption)}</span>`
  );
}

function gridHtml(m: Strip): string {
  const j = state!.jam;
  const cols = j.bars * STEPS_PER_BAR;
  const partSteps = m.part.lengthBars * STEPS_PER_BAR;
  const rows: Array<{ label: string; on: (ps: number) => "" | "on" | "acc" | "sus" }> = [];
  if (m.role === "drums") {
    const hits = m.part.notes as DrumHit[];
    for (const voice of DRUM_VOICES) {
      rows.push({
        label: voice === "openhat" ? "oh" : voice.slice(0, 2),
        on: (ps) => {
          const h = hits.find((x) => x.step === ps && x.voice === voice);
          return h ? (h.accent ? "acc" : "on") : "";
        },
      });
    }
  } else {
    const notes = m.part.notes as PitchedNote[];
    const degs = [...new Set(notes.map((n) => n.deg))].sort((a, b) => b - a).slice(0, 8);
    for (const deg of degs.length ? degs : [0]) {
      rows.push({
        label: String(deg),
        on: (ps) => {
          const start = notes.find((n) => n.deg === deg && n.step === ps);
          if (start) return start.accent ? "acc" : "on";
          return notes.some((n) => n.deg === deg && ps > n.step && ps < n.step + n.len) ? "sus" : "";
        },
      });
    }
  }
  let html = `<div class="grid" data-grid="${m.role}" style="--cols:${cols}">`;
  for (const r of rows) {
    html += `<span class="rl">${r.label}</span>`;
    for (let c = 0; c < cols; c++) {
      const kind = r.on(c % partSteps);
      const bar = c % 16 === 0 ? " b16" : c % 4 === 0 ? " b4" : "";
      html += `<span class="c${bar}${kind ? ` on${kind === "on" ? "" : ` ${kind}`}` : ""}"></span>`;
    }
  }
  return html + `<span class="ph"></span></div>`;
}

function liveHtml(): string {
  const keys = [...ui.held.entries()].filter(([, h]) => "midi" in h && h.on === "you");
  const phase = state?.jam.phase;
  const text =
    phase === "soundcheck" && ui.focus && ui.focus !== "you"
      ? `the keyboard plays <b>${ui.focus}</b> (soundcheck audition)`
      : `play along on the home row · octave ${ui.octave}`;
  return `<div class="live">${keys.map(([, h]) => `<span class="k dn">${noteName((h as { midi: number }).midi)}</span>`).join("")}<span class="hint">${text}</span></div>`;
}

const noteName = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

function updatePills(): void {
  for (const m of stripsInOrder()) {
    const el = document.querySelector<HTMLElement>(`[data-pill="${m.role}"]`);
    if (!el) continue;
    let cls = "";
    let text = "idle";
    if (m.role === "producer") {
      cls = "live";
      text = state?.jam.phase === "jam" ? "LIVE" : "soundcheck";
    } else if (m.activeDesignId) {
      cls = "designing";
      text = `designing · iter ${m.design?.iteration ?? 0}`;
    } else if (m.status === "thinking") {
      cls = "thinking";
      text = "thinking…";
    } else {
      const n = engine?.running ? engine.landsIn(m.role as TrackId) : null;
      if (n !== null && n !== undefined) {
        cls = "staged";
        text = `lands in ${Math.max(1, Math.ceil(n / 4))} beat${Math.ceil(n / 4) === 1 ? "" : "s"}`;
      } else text = `idle · ${m.part.source}`;
    }
    el.className = `pill ${cls}`;
    el.innerHTML = cls === "thinking" || cls === "designing" ? `<span class="dots"><i></i><i></i><i></i></span>${text}` : text;
  }
}

function renderDock(): void {
  const mode = $("mode");
  mode.textContent = ui.mode.toUpperCase();
  mode.className = `mode ${ui.mode}`;
  if (!state) return;
  const j = state.jam;
  const on = playTarget();
  const octave = on === "you" ? ui.octave : on === "drums" ? 4 : ROLE_OCTAVE[on] + (ui.octave - 4);
  $("kbrow").innerHTML = HOME_KEYS.map((k, d) => {
    const label = on === "drums" ? (DRUM_VOICES[d]?.slice(0, 2) ?? "") : NOTE_NAMES[degreeToMidi(j.keyPc, j.scale, d, octave) % 12];
    const down = [...ui.held.keys()].includes(k === ";" ? "Semicolon" : `Key${k}`);
    return `<span class="key${d === 0 ? " root" : ""}${down ? " dn" : ""}"><b>${esc(k)}</b><small>${esc(label)}</small></span>`;
  }).join("");
  $("dockinfo").innerHTML = `keys → <b>${on}</b> · ${NOTE_NAMES[j.keyPc]} ${j.scale} · oct ${ui.octave} (Z/X)`;
}

function renderChat(): void {
  if (!state) return;
  const names = new Map(state.musicians.map((m) => [m._id as string, m.name]));
  const rows = [...chatRows].sort((a, b) => a.seq - b.seq);
  $("chatrows").innerHTML = rows
    .map((r) => {
      const to = r.to.length ? r.to.map((id) => `@${names.get(id) ?? "?"}`).join(" ") : "@all";
      if (r.kind === "producer") return `<div class="msg"><span class="a" style="color:var(--you)">you</span><span class="to">→ ${esc(to)}:</span> ${esc(r.text)}</div>`;
      if (r.kind === "musician") {
        const who = names.get(r.fromMusicianId ?? "") ?? "band";
        return `<div class="msg reply"><span class="a">${esc(who)}</span>${esc(r.text)}</div>`;
      }
      return `<div class="msg ${r.kind}">${esc(r.text)}</div>`;
    })
    .join("");
  const box = $("chatrows");
  box.scrollTop = box.scrollHeight;
}

function renderModal(): void {
  const host = $("modal");
  if (ui.picker) {
    const p = ui.picker;
    host.innerHTML = `<div class="modal"><div class="card" data-testid="picker"><h3>Library · ${esc(p.strip)}</h3>${p.rows
      .map(
        (r, i) =>
          `<div class="pick${i === p.sel ? " sel" : ""}" data-pickrow="${i}"><span>${esc(r.name)}</span><small>${esc(r.origin)} · ${esc(r.source)}</small></div>`,
      )
      .join("")}<p class="hint">↑/↓ then Enter · Esc closes</p></div></div>`;
  } else if (ui.overlay) {
    const rows: Array<[string, string]> = [
      ["A – ;  ·  Q – P", "play (the home row is the scale; the top row is an octave up)"],
      ["Z / X", "octave down / up"],
      ["Space", "start / stop (the first press starts the jam)"],
      ["1 – 4", "focus: you, drums, bass, keys"],
      ["Enter or /", "chat to the focused musician"],
      ["← / →", "step back / forward on the focused strip's history"],
      ["Shift + ← / →", "oldest / newest version"],
      ["M / N", "mute / solo the focused strip"],
      ["B", "library: pick a sound for the focused strip"],
      ["V", "ask the focused musician for a variation"],
      ["[ / ]", "recall scene A / B   ·   Shift saves"],
      ["\\", "band reacts on / off"],
      [", / .", "tempo −2 / +2"],
      ["Esc", "leave chat or the picker; clear the focus"],
    ];
    host.innerHTML = `<div class="modal"><div class="card" data-testid="overlay"><h3>Keys</h3><div class="keymap">${rows
      .map(([k, v]) => `<kbd>${esc(k)}</kbd><span>${esc(v)}</span>`)
      .join("")}</div></div></div>`;
  } else host.innerHTML = "";
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string): void {
  $("toast").innerHTML = `<div class="toast" data-testid="toast">${esc(text)}</div>`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").innerHTML = ""), 2600);
}

function renderAll(): void {
  renderTop();
  renderStrips();
  renderDock();
  renderModal();
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function harmonyOf(s: JamState): Harmony {
  return { bpm: s.jam.bpm, keyPc: s.jam.keyPc, scale: s.jam.scale as Scale, progression: [...s.jam.progression], bars: s.jam.bars };
}

async function ensureEngine(s: JamState): Promise<void> {
  if (engine) return;
  const you = s.musicians.find((m) => m.role === "producer")!;
  const kick = await loadKick();
  if (engine) return;
  engine = new BandEngine({
    harmony: harmonyOf(s),
    kick,
    yourSound: you.part.sound!.preset,
    spy: params.has("spy"),
    onStep,
  });
  lastHarmony = JSON.stringify(harmonyOf(s));
  lastYouSound = you.part.libraryId;
}

/** Stage what the database says each strip plays; the engine lands it at the next bar line. */
function reconcile(s: JamState): void {
  if (!engine) return;
  const h = JSON.stringify(harmonyOf(s));
  if (h !== lastHarmony) {
    lastHarmony = h;
    engine.setHarmony(harmonyOf(s));
  }
  for (const m of s.musicians) {
    if (m.role === "producer") {
      if (m.part.libraryId !== lastYouSound && m.part.sound) {
        lastYouSound = m.part.libraryId;
        engine.setYourSound(m.part.sound.preset);
      }
    } else {
      const ref: PartRef = {
        id: String(m.part.basedOn),
        sound: m.part.libraryId,
        role: m.role as TrackId,
        pattern: { lengthBars: m.part.lengthBars, notes: m.part.notes } as Pattern,
      };
      engine.stage(m.role as TrackId, ref, m.part.sound?.preset ?? null);
    }
    const local = ui.localMute.get(m.role);
    if (local !== undefined && local === m.muted) ui.localMute.delete(m.role);
    engine.setMuted(channelOf(m.role), mutedOf(m));
  }
}

const channelOf = (role: Strip["role"]): ChannelId => (role === "producer" ? "you" : role);

let lastStepDraw = -1;
function onStep(g: number): void {
  if (!state || !engine) return;
  const cols = state.jam.bars * STEPS_PER_BAR;
  const s = ((g % cols) + cols) % cols;
  for (const el of document.querySelectorAll<HTMLElement>(".grid")) el.style.setProperty("--s", String(s));
  $("pos").textContent = `${Math.floor(s / 16) + 1}.${Math.floor((s % 16) / 4) + 1}`;
  $("lbfill").style.setProperty("--p", String((s + 1) / cols));
  const toBar = 16 - (s % 16);
  $("loopnext").textContent = `next bar line in ${Math.ceil(toBar / 4)} beat${Math.ceil(toBar / 4) === 1 ? "" : "s"}`;
  for (const el of document.querySelectorAll<HTMLElement>("#prog span")) el.classList.toggle("on", Number(el.dataset.bar) === Math.floor(s / 16) % state.jam.progression.length);
  // What each track is sounding: from the engine's promotions.
  let changed = false;
  for (let i = engine.promotions.length - 1; i >= Math.max(0, engine.promotions.length - 8); i--) {
    const p = engine.promotions[i];
    if (ui.sounding.get(p.track) !== p.id && !seenPromotion.has(i)) {
      seenPromotion.add(i);
      ui.sounding.set(p.track, p.id);
      changed = true;
    }
  }
  updatePills();
  if (changed || lastStepDraw < 0) {
    for (const m of stripsInOrder()) {
      const rail = document.querySelector<HTMLElement>(`[data-rail="${m.role}"]`);
      if (rail) rail.innerHTML = railHtml(m);
    }
  }
  lastStepDraw = g;
}
const seenPromotion = new Set<number>();

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** What the keyboard plays: in soundcheck the focused (armed) strip, in the jam always you. */
function playTarget(): StripKey {
  if (state?.jam.phase === "soundcheck" && ui.focus) return ui.focus;
  return "you";
}

function focusedStrip(): Strip | null {
  if (!state || !ui.focus) return null;
  return state.musicians.find((m) => m.role === KEY_ROLE[ui.focus!]) ?? null;
}

async function act(a: KeyAction): Promise<void> {
  if (!state) return;
  const j = state.jam;
  switch (a.kind) {
    case "note-on": {
      void Tone.start();
      if (!engine) return;
      const on = playTarget();
      if (on === "drums") {
        const voice = DRUM_VOICES[a.degree];
        if (voice) engine.liveHit(voice);
        ui.held.set(a.code, { hit: true });
      } else {
        const octave = on === "you" ? ui.octave : ROLE_OCTAVE[on] + (ui.octave - 4);
        const midi = degreeToMidi(j.keyPc, j.scale as Scale, a.degree, octave);
        engine.liveAttack(midi, 0.85, on);
        ui.held.set(a.code, { midi, on });
      }
      renderDock();
      refreshLive();
      return;
    }
    case "note-off": {
      const h = ui.held.get(a.code);
      ui.held.delete(a.code);
      if (h && "midi" in h) engine?.liveRelease(h.midi, h.on);
      renderDock();
      refreshLive();
      return;
    }
    case "transport": {
      await Tone.start();
      if (!engine) return;
      if (engine.running) engine.stop();
      else {
        if (j.phase === "soundcheck") {
          try {
            await band.start(j._id);
          } catch (e) {
            toast(errorText(e));
            return;
          }
        }
        engine.start();
      }
      renderTransport();
      return;
    }
    case "focus":
      // Esc closes the ? overlay first, before it clears the focus.
      if (a.strip === null && ui.overlay) {
        ui.overlay = false;
        renderModal();
        return;
      }
      ui.focus = a.strip;
      break;
    case "octave":
      ui.octave = Math.min(6, Math.max(1, ui.octave + a.delta));
      break;
    case "chat-open": {
      setMode("chat");
      const input = $<HTMLInputElement>("chatin");
      input.value = a.prefill;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    case "mode":
      setMode(a.mode);
      return;
    case "history": {
      const m = focusedStrip();
      if (m) await run(band.history(m._id, a.move));
      return;
    }
    case "mute": {
      const m = focusedStrip();
      if (!m || !engine) return;
      const next = !mutedOf(m);
      ui.localMute.set(m.role, next); // local-first: the channel mutes now
      engine.setMuted(channelOf(m.role), next);
      renderStrips();
      await run(band.setMuted(m._id, next));
      return;
    }
    case "solo": {
      const m = focusedStrip();
      if (!m || !engine) return;
      if (ui.solo.has(m.role)) ui.solo.delete(m.role);
      else ui.solo.add(m.role);
      engine.setSolo(channelOf(m.role), ui.solo.has(m.role));
      break;
    }
    case "picker-open": {
      const m = focusedStrip();
      if (!m) return;
      if (m.role === "drums") return toast("Drums play the kit; there's no sound to pick.");
      const rows = await band.library(m.role === "producer" ? "pitched" : (m.role as "bass" | "keys"));
      const cur = rows.findIndex((r) => r._id === m.part.libraryId);
      ui.picker = { strip: a.strip, rows, sel: Math.max(0, cur) };
      setMode("picker");
      return;
    }
    case "picker-move":
      if (ui.picker && ui.picker.rows.length) {
        ui.picker.sel = (ui.picker.sel + a.delta + ui.picker.rows.length) % ui.picker.rows.length;
        renderModal();
      }
      return;
    case "picker-choose": {
      const p = ui.picker;
      const m = focusedStrip();
      setMode("play");
      if (p && m && p.rows[p.sel]) await run(band.pick(m._id, p.rows[p.sel]._id));
      return;
    }
    case "scene-recall":
      await run(band.recallScene(j._id, a.scene));
      return;
    case "scene-save":
      await run(band.saveScene(j._id, a.scene));
      toast(`Saved scene ${a.scene}`);
      return;
    case "reacts-toggle":
      await run(band.setReactive(j._id, !j.reactive));
      return;
    case "bpm":
      await run(band.setBpm(j._id, j.bpm + a.delta));
      return;
    case "overlay":
      ui.overlay = !ui.overlay;
      renderModal();
      return;
    case "vary":
      // Slice 5 sends "@<strip> give me a variation" as a chat note, which the
      // musician answers with a new part. Until band turns exist, say so.
      toast(`Asking ${a.strip} for a variation arrives with the band's turns (slice 5).`);
      return;
    case "undo":
    case "cancel":
      toast("Undo and cancel arrive in wave 2.");
      return;
    case "hint":
      toast(a.text);
      return;
    case "swallow":
      return;
  }
  renderStrips();
  renderDock();
}

async function run(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    toast(errorText(e));
  }
}

function setMode(mode: Mode): void {
  if (mode !== "play") {
    for (const [code, h] of [...ui.held]) {
      ui.held.delete(code);
      if ("midi" in h) engine?.liveRelease(h.midi, h.on);
    }
  }
  if (mode !== "picker") ui.picker = null;
  if (mode !== "chat") $<HTMLInputElement>("chatin").blur();
  ui.mode = mode;
  ui.overlay = false;
  renderDock();
  renderModal();
}

function refreshLive(): void {
  const you = document.querySelector("#strip-producer .gwrap");
  if (you) you.innerHTML = liveHtml();
}

for (const type of ["keydown", "keyup"] as const) {
  window.addEventListener(
    type,
    (e) => {
      const a = routeKey(
        { type, code: e.code, key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, repeat: e.repeat },
        ui.mode,
        ui.focus,
      );
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      void act(a);
    },
    { capture: true },
  );
}

$<HTMLInputElement>("chatin").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !state) return;
  e.preventDefault();
  const input = e.currentTarget as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  void run(band.send(state.jam._id, text, ui.octave)); // Enter sends and stays in chat
});
$<HTMLInputElement>("chatin").addEventListener("focus", () => {
  if (ui.mode !== "chat") setMode("chat");
});
// Clicking anywhere else takes focus from the chat box: that also leaves chat,
// or every key would keep "typing" into a box that no longer has focus.
$<HTMLInputElement>("chatin").addEventListener("blur", () => {
  if (ui.mode === "chat") setMode("play");
});

document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const pick = t.closest<HTMLElement>("[data-pick]");
  if (pick && !pick.hasAttribute("disabled")) {
    ui.focus = ROLE_KEY[pick.dataset.pick as Strip["role"]];
    void act({ kind: "picker-open", strip: ui.focus });
    return;
  }
  const jump = t.closest<HTMLElement>("[data-jump]");
  if (jump && state) {
    const [role, basedOn] = jump.dataset.jump!.split(":");
    const m = state.musicians.find((x) => x.role === role);
    if (m) void run(band.history(m._id, { kind: "jump", version: Number(basedOn) }));
    return;
  }
  const row = t.closest<HTMLElement>("[data-pickrow]");
  if (row && ui.picker) {
    ui.picker.sel = Number(row.dataset.pickrow);
    void act({ kind: "picker-choose" });
    return;
  }
  const scene = t.closest<HTMLElement>(".scene");
  if (scene && state) void act({ kind: "scene-recall", scene: scene.id === "scene-A" ? "A" : "B" });
  if (t.closest(".modal") && !t.closest(".card")) setMode("play");
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

Object.assign(window, {
  __band: {
    ready: false,
    get g() {
      return engine?.g ?? -1;
    },
    get missedSteps() {
      return engine?.missedSteps ?? 0;
    },
    get running() {
      return engine?.running ?? false;
    },
    get promotions() {
      return engine?.promotions ?? [];
    },
    get calls() {
      return engine?.calls ?? [];
    },
    now: () => engine?.context.currentTime ?? 0,
    view: () =>
      state && {
        phase: state.jam.phase,
        activeScene: state.jam.activeScene,
        strips: state.musicians.map((m) => ({ role: m.role, sound: m.part.sound?.name ?? null, basedOn: m.part.basedOn, muted: m.muted })),
      },
  },
});

function showConnection(text: string): void {
  if (state) return;
  $("strips").innerHTML = `<p class="hint" data-testid="connecting" style="padding:24px">${esc(text)}</p>`;
}

async function boot(): Promise<void> {
  showConnection("Connecting to the band…");
  const slow = setTimeout(
    () => showConnection(`Still can't reach the backend at ${convexUrl}. Is \`npx convex dev\` running on the machine serving this page?`),
    6000,
  );
  try {
    await band.create(slug, createOpts);
  } catch (e) {
    clearTimeout(slow);
    showConnection(`Couldn't create the jam: ${errorText(e)}`);
    return;
  }
  clearTimeout(slow);
  band.onState(slug, async (s) => {
    if (!s) return;
    if (!state) $("strips").innerHTML = "";
    state = s;
    await ensureEngine(s);
    reconcile(s);
    for (const m of s.musicians) {
      if (railSubs.has(m._id)) continue;
      railSubs.set(
        m._id,
        band.onRail(m._id, (pips) => {
          rails.set(m._id, pips);
          const el = document.querySelector<HTMLElement>(`[data-rail="${m.role}"]`);
          if (el && state) el.innerHTML = railHtml(state.musicians.find((x) => x._id === m._id)!);
        }),
      );
    }
    if (!chatSub) chatSub = band.onChat(s.jam._id, (rows) => {
      chatRows = rows;
      renderChat();
    });
    renderAll();
    (window as unknown as { __band: { ready: boolean } }).__band.ready = true;
  });
}
let chatSub: (() => void) | null = null;

void boot();
export {};
