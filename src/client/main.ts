/**
 * UI, and the reconciliation loop that replaced drain().
 *
 * The old client was driven by one union: every endpoint returned a `Step`, and
 * `drain()` kept rendering-and-reporting for as long as the agent kept asking.
 * That worked because exactly one browser was ever involved.
 *
 * Now the server owns the loop and the browser subscribes. Every view function
 * below is a pure function of the latest snapshot, `reconcile()` is synchronous,
 * and the only asynchronous thing the client decides for itself is whether it is
 * the browser on the hook to render the current proposal (see reconcile.ts).
 */

import type { ClaudioPreset } from "../shared/preset";
import {
  HEARTBEAT_MS,
  looksLikeSessionId,
  newSessionId,
  sanitizeNickname,
} from "../shared/protocol";
import {
  analyzeTarget,
  decodePreparedAudio,
  encodePreparedAudio,
  ensureAudio,
  noteOff,
  noteOn,
  playBuffer,
  playNote,
  renderIdle,
  setLivePreset,
  specForPrompt,
  specForTarget,
  type PreparedAudio,
} from "./audio";
import * as backend from "./convex";
import type { AttemptView, ChatView, Snapshot } from "./convex";
import { me } from "./identity";
import { iAmPlaying, maybeRender, msUntilLeaseExpiry, notePlaying, playingUntil } from "./reconcile";

/**
 * One-click ways in, for someone with no sample to hand. Each runs the ordinary
 * prompt path, so the agent designs it fresh and you get its rationale.
 *
 * Chosen to span the engine rather than to be eight kinds of bell: non-integer
 * vs integer harmonicity, the two ends of the envelope range (pad and kick),
 * and — in "gritty acid lead" — the sawtooth-modulator substitution that stands
 * in for the operator feedback this engine doesn't have.
 */
const STARTER_PROMPTS = [
  "glassy bell",
  "rubber bass",
  "metallic pluck",
  "warm electric piano",
  "hollow wooden flute",
  "gritty acid lead",
  "icy shimmering pad",
  "thumpy kick drum",
];

// --- session addressing ----------------------------------------------------

function sessionIdFromUrl(): string | null {
  const seg = location.pathname.split("/").filter(Boolean)[0];
  return seg && looksLikeSessionId(seg) ? seg : null;
}

function putSessionInUrl(id: string): void {
  history.replaceState({}, "", `/${id}`);
}

// --- state -----------------------------------------------------------------

const state = {
  slug: null as string | null,
  /** The newest snapshot. Every view reads from this, never from ad-hoc fields. */
  snap: { session: null, attempts: [], peers: [], loaded: false } as Snapshot,
  /**
   * The target's audio, if this browser has it. Uploaders have it from the file;
   * everyone else fetches it. Kept out of `snap` because it is a big buffer with
   * a completely different lifecycle from the reactive document.
   */
  targetAudio: null as PreparedAudio | null,
  targetAudioFor: null as string | null,
  current: null as ClaudioPreset | null,
  loadedPresetId: null as string | null,
  /** A preset the user chose from the rail — suppresses auto-loading newer ones. */
  pinnedPresetId: null as string | null,
  /** The newest render this tab has declined to auto-load, offered instead. */
  offeredPresetId: null as string | null,
  followLatest: true,
  expanded: new Set<string>(),
  /** Chat rows whose chips this tab has used — so they don't resurrect. */
  usedChips: new Set<string>(),
  starting: false,
  transientError: null as string | null,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const app = () => document.getElementById("app")!;

let detach: (() => void) | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let leaseTimer: ReturnType<typeof setTimeout> | null = null;

// --- rendering -------------------------------------------------------------

function shell(): void {
  app().innerHTML = `
    <header class="topbar">
      <div class="brand">Claud<span>io</span></div>
      <p class="sub muted">FM sound design</p>
      <div class="spacer"></div>
      <div id="peers" class="peers"></div>
      <span id="sessionlabel" class="muted mono"></span>
      <button id="share" class="chip tiny hidden">copy link</button>
    </header>

    <div class="layout">
      <aside class="rail">
        <div class="panel" id="attemptspanel">
          <div class="row" style="margin-bottom:6px;justify-content:space-between">
            <span class="tag">iterations</span>
            <span class="muted" style="font-size:12px">click to load</span>
          </div>
          <div id="attempts"><p class="muted" style="font-size:13px">Nothing yet.</p></div>
        </div>
      </aside>

      <section class="stage">
        <div class="stage-scroll">
          <div class="panel" id="startpanel">
            <div id="drop">Drop a WAV here, or click to choose
              <input id="file" type="file" accept="audio/*" class="hidden" />
            </div>
            <div class="or"><span>or describe it</span></div>
            <div class="row">
              <input id="promptbox" type="text" style="flex:1"
                     placeholder="a glassy bell · dark rubbery bass · metallic pluck with a long tail" />
              <button id="promptgo">Design it</button>
            </div>
            <div id="starters" class="row" style="margin-top:10px"></div>
          </div>

          <div id="targetinfo" class="row muted hidden" style="margin-top:12px"></div>

          <div class="statusbar" id="statuspanel">
            <span class="tag">status</span>
            <span id="status" class="muted">Waiting for a sample.</span>
          </div>

          <div class="panel hidden" id="chatpanel">
            <div id="chips" class="row" style="margin-bottom:10px"></div>
            <div class="row">
              <input id="chat" type="text" placeholder="glassier · more punch · hollow it out" style="flex:1" />
              <button id="send">Send</button>
            </div>
            <div id="chatlog" class="muted" style="margin-top:10px"></div>
          </div>
        </div>

        <div class="dock">
          <div class="row" style="justify-content:space-between;margin-bottom:8px">
            <span class="row" style="gap:8px">
              <span class="tag">playing</span>
              <span id="nowplaying" style="font-size:13px">init patch</span>
            </span>
            <span class="muted" style="font-size:12px">
              <code>A S D F&hellip;</code> naturals · <code>W E T Y U</code> sharps ·
              <code>Z</code>/<code>X</code> octave
            </span>
          </div>
          <div id="keyboard"></div>
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

  const attempts = $("attempts");
  attempts?.addEventListener("scroll", () => {
    const atBottom = attempts.scrollHeight - attempts.scrollTop - attempts.clientHeight < 24;
    state.followLatest = atBottom;
  });

  const starters = $("starters");
  if (starters) {
    starters.innerHTML = STARTER_PROMPTS.map(
      (p, i) => `<button class="chip" data-starter="${i}">${escapeHtml(p)}</button>`,
    ).join("");
    starters.querySelectorAll<HTMLButtonElement>("[data-starter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const text = STARTER_PROMPTS[Number(btn.dataset.starter)];
        const box = $<HTMLInputElement>("promptbox");
        if (box && text) box.value = text;
        startFromPrompt();
      });
    });
  }

  $("promptgo")?.addEventListener("click", () => startFromPrompt());
  $<HTMLInputElement>("promptbox")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") startFromPrompt();
  });

  $("send")?.addEventListener("click", () => sendChat());
  $<HTMLInputElement>("chat")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
    if (e.key === "Escape") (e.target as HTMLInputElement).blur();
  });

  $("share")?.addEventListener("click", async () => {
    const btn = $("share")!;
    try {
      await navigator.clipboard.writeText(location.href);
      btn.textContent = "copied ✓";
      setTimeout(() => (btn.textContent = "copy link"), 1200);
    } catch {
      btn.textContent = "copy failed";
      setTimeout(() => (btn.textContent = "copy link"), 1200);
    }
  });
}

// --- keyboard --------------------------------------------------------------

const BLACK = new Set([1, 3, 6, 8, 10]);

/**
 * The standard tracker/DAW two-row layout: home row is the white keys, the row
 * above holds the sharps, positioned so they sit where the black keys actually
 * are. Note the gaps — there is deliberately no binding above D (E/F have no
 * black key between them) or above G (likewise B/C), which is what makes the
 * shape feel like a keyboard rather than an arbitrary strip of buttons.
 */
const KEY_MAP: Record<string, number> = {
  // white
  a: 0, s: 2, d: 4, f: 5, g: 7, h: 9, j: 11, k: 12, l: 14, ";": 16,
  // black
  w: 1, e: 3, t: 6, y: 8, u: 10, o: 13, p: 15,
};

const KB_SEMITONES = Math.max(...Object.values(KEY_MAP)) + 1;

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

/**
 * Note-on now waits for render-idle.
 *
 * It didn't have to before: you only ever rendered as a consequence of your own
 * action, so you were never playing during one. In a shared session another
 * contributor's turn can hand THIS tab a render at any moment, and Tone.Offline
 * swaps the global context while it runs — a voice built during that window
 * belongs to the offline context and is simply never heard.
 */
async function press(id: string, midi: number, el?: HTMLElement | null): Promise<void> {
  if (held.has(id)) return;
  held.set(id, midi);
  (el ?? keyEl(midi))?.classList.add("on");
  notePlaying();
  await ensureAudio();
  await renderIdle();
  // The key may have been released during the await.
  if (!held.has(id)) return;
  noteOn(midi, 0.9);
}

function release(id: string): void {
  const midi = held.get(id);
  if (midi === undefined) return;
  held.delete(id);
  keyEl(midi)?.classList.remove("on");
  notePlaying();
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

// --- views (pure functions of the snapshot) --------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function pip(color: string | null): string {
  return `<span class="pip" style="background:${escapeHtml(color ?? "#888")}"></span>`;
}

function nameOf(clientId: string | null): string {
  if (!clientId) return "someone";
  if (clientId === me.id) return "you";
  const peer = state.snap.peers.find((p) => p.clientId === clientId);
  if (peer) return peer.nickname;
  // They've left, but their work is still on screen — find them in the chat log.
  const row = state.snap.session?.chat.find((c) => c.authorClientId === clientId);
  return row?.nickname ?? "someone";
}

function colorOf(clientId: string | null): string | null {
  if (!clientId) return null;
  const peer = state.snap.peers.find((p) => p.clientId === clientId);
  if (peer) return peer.color;
  return state.snap.session?.chat.find((c) => c.authorClientId === clientId)?.color ?? null;
}

function renderPeers(): void {
  const el = $("peers");
  if (!el) return;
  const peers = state.snap.peers;
  if (!state.slug || peers.length === 0) { el.innerHTML = ""; return; }

  const owner = state.snap.session?.render?.ownerClientId ?? null;
  const mine = peers.find((p) => p.clientId === me.id);
  const others = peers.filter((p) => p.clientId !== me.id);
  const shown = others.slice(0, 5);
  const overflow = others.length - shown.length;

  const youPip = pip(mine?.color ?? me.color);
  const parts = [
    `<span class="peer you" title="you">${youPip}` +
      `<input id="nickname" class="name-edit" value="${escapeHtml(me.nickname)}" maxlength="16" spellcheck="false" />` +
      `</span>`,
    ...shown.map(
      (p) =>
        `<span class="peer" title="${escapeHtml(p.nickname)}${p.clientId === owner ? " — rendering" : ""}">` +
        `<span class="pip${p.clientId === owner ? " rendering" : ""}" style="background:${escapeHtml(p.color)}"></span>` +
        `<span class="pname">${escapeHtml(p.nickname)}</span></span>`,
    ),
  ];
  if (overflow > 0) parts.push(`<span class="muted">+${overflow}</span>`);
  el.innerHTML = parts.join("");

  const input = $<HTMLInputElement>("nickname");
  input?.addEventListener("change", () => {
    const stored = me.rename(input.value);
    // Reflect what was ACTUALLY stored — sanitizing can shorten or replace it,
    // and the box must not disagree with what the room sees.
    input.value = stored;
    void beat();
  });
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.value = me.nickname; input.blur(); }
  });
}

function renderSessionLabel(): void {
  const label = $("sessionlabel");
  const share = $("share");
  if (!label || !share) return;
  if (!state.slug) { label.textContent = ""; share.classList.add("hidden"); return; }
  label.textContent = state.slug;
  share.classList.remove("hidden");
}

function renderStartPanel(): void {
  const panel = $("startpanel");
  if (!panel) return;
  const s = state.snap.session;
  const started = !!s && (s.target !== null || s.promptText !== null || state.snap.attempts.length > 0);
  // Once a session is under way its start controls disappear for EVERYONE. A
  // joiner's first instinct is otherwise to drop their own WAV into a room
  // somebody else is working in, and the server would (correctly) refuse.
  panel.classList.toggle("hidden", started);
}

function renderTargetRow(): void {
  const el = $("targetinfo");
  if (!el) return;
  const s = state.snap.session;
  if (!s || (s.target === null && s.promptText === null)) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");

  if (s.target === null) {
    el.innerHTML = `<span class="tag">prompt</span> ${escapeHtml(s.promptText ?? "")}`;
    return;
  }

  const info = s.targetInfo;
  const head =
    `<span class="tag">target</span> ${escapeHtml(info?.filename ?? "sample")} · ` +
    `${s.target.f0Hz.toFixed(1)} Hz · ${s.target.durationMs} ms `;

  if (state.targetAudio) {
    el.innerHTML = `${head}<button id="playtarget">▶︎ target</button>`;
    $("playtarget")?.addEventListener("click", async () => {
      await ensureAudio();
      await renderIdle();
      playBuffer(state.targetAudio!);
    });
  } else if (s.hasTargetAudio) {
    el.innerHTML = `${head}<span class="muted">(loading audio…)</span>`;
  } else {
    // Sessions started before audio was stored, or an upload that failed.
    el.innerHTML = `${head}<span class="muted">(audio wasn't stored — it can't be replayed here)</span>`;
  }
}

function setStatus(text: string, tone: "muted" | "good" | "working" = "muted"): void {
  const el = $("status");
  if (!el) return;
  // Animated dots, so waiting *feels* like waiting rather than reading as a
  // frozen sentence.
  el.innerHTML =
    escapeHtml(text) + (tone === "working" ? '<span class="dots"><i></i><i></i><i></i></span>' : "");
  el.className = tone === "good" ? "" : "muted";
  if (tone === "good") el.style.color = "var(--good)";
  else el.style.removeProperty("color");
}

function renderStatus(): void {
  if (state.transientError) return setStatus(state.transientError);

  const s = state.snap.session;
  if (!state.slug) return setStatus("Waiting for a sample.");
  if (!state.snap.loaded) return setStatus("Joining", "working");
  if (!s) return setStatus("No such session — start a new one above.");

  const q = s.queuedCount > 0 ? ` · ${s.queuedCount} queued` : "";

  switch (s.status) {
    case "idle":
      if (s.lastError) return setStatus(s.lastError);
      return setStatus(state.snap.attempts.length ? `Ready.${q}` : "Waiting for a sample.");
    case "thinking": {
      const who = nameOf(s.turnStartedBy);
      return setStatus(`Thinking about ${who === "you" ? "your" : `${who}'s`} message${q}`, "working");
    }
    case "awaiting_render": {
      const attempt = state.snap.attempts.find((a) => a.presetId === s.render?.presetId);
      const name = attempt?.preset.name ?? "the patch";
      const left = Math.max(0, s.maxIterations - s.iteration);
      const owner = s.render?.ownerClientId ?? null;
      if (owner === me.id) return setStatus(`Rendering “${name}” here · ${left} left${q}`, "working");
      if (msUntilLeaseExpiry(state.snap) > 0) {
        return setStatus(`${nameOf(owner)} is rendering “${name}”${q}`, "working");
      }
      return setStatus(`${nameOf(owner)} dropped out — picking up “${name}”${q}`, "working");
    }
    case "done": {
      const best = state.snap.attempts.find((a) => a.presetId === s.bestPresetId);
      const dist = best?.distance;
      return setStatus(
        `Done — “${best?.preset.name ?? ""}”` +
          (dist !== null && dist !== undefined ? ` at distance ${dist.toFixed(1)}` : "") +
          q,
        "good",
      );
    }
    default:
      return setStatus(s.lastError ?? "Ready.");
  }
}

function renderAttempts(): void {
  const panel = $("attemptspanel");
  const list = $("attempts");
  if (!panel || !list) return;
  const attempts = state.snap.attempts;
  if (attempts.length === 0) return;
  panel.classList.remove("hidden");

  const s = state.snap.session;
  const best = attempts.reduce<number | null>(
    (m, a) => (a.distance !== null && (m === null || a.distance < m) ? a.distance : m),
    null,
  );

  list.innerHTML = attempts
    .map((a, i) => {
      const d = a.distance;
      const scored = d !== null;
      const pending = s?.status === "awaiting_render" && s.render?.presetId === a.presetId;
      const pct = scored ? Math.max(0, Math.min(100, 100 - d)) : 0;
      const isBest = scored && d === best;
      const isLoaded = state.loadedPresetId === a.presetId;
      const isOffered = state.offeredPresetId === a.presetId;

      // The .working sweep now means "somebody, somewhere is rendering this",
      // which is a strictly better meaning for the same pixels than "I am".
      const byline = renderByline(a, pending, s?.render?.ownerClientId ?? null);

      return `
        <div class="attempt ${pending ? "working" : ""}" data-load="${a.presetId}" style="cursor:pointer">
          <div class="row" style="justify-content:space-between">
            <div><strong>${i + 1}. ${escapeHtml(a.preset.name)}</strong>
              ${isBest ? '<span class="tag" style="color:var(--good);border-color:var(--good)">best</span>' : ""}
              ${a.isFinal ? '<span class="tag">final</span>' : ""}
              ${isLoaded ? '<span class="tag" style="color:var(--accent);border-color:var(--accent)">loaded</span>' : ""}
            </div>
            <span class="dist">${scored ? d.toFixed(1) : ""}</span>
          </div>
          <div class="byline">${byline}</div>
          <div class="why${state.expanded.has(a.presetId) ? " open" : ""}">${escapeHtml(a.rationale)}</div>
          <button class="morelink" data-expand="${a.presetId}">${
            state.expanded.has(a.presetId) ? "less" : "more"
          }</button>
          <button class="morelink" data-fork="${a.presetId}" title="Start a new session from this patch">fork</button>
          ${isOffered ? `<button class="chip tiny" data-offer="${a.presetId}">new — load it</button>` : ""}
          ${pending || scored ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ""}
        </div>`;
    })
    .join("");

  list.querySelectorAll<HTMLButtonElement>("[data-expand]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      // The whole row loads the preset on click; expanding must not do that too.
      e.stopPropagation();
      const id = btn.dataset.expand!;
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      renderAttempts();
    });
  });

  list.querySelectorAll<HTMLButtonElement>("[data-fork]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      // The row itself loads the preset on click; forking must not also do that.
      e.stopPropagation();
      void forkFrom(btn.dataset.fork!);
    });
  });

  list.querySelectorAll<HTMLButtonElement>("[data-offer]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const a = state.snap.attempts.find((x) => x.presetId === btn.dataset.offer);
      if (!a) return;
      state.offeredPresetId = null;
      state.pinnedPresetId = null;
      await loadPreset(a.preset, a.presetId);
    });
  });

  list.querySelectorAll<HTMLElement>("[data-load]").forEach((el) => {
    el.addEventListener("click", async () => {
      const a = state.snap.attempts.find((x) => x.presetId === el.dataset.load);
      if (!a) return;
      // An explicit choice pins it: nobody else's turn should yank it away.
      state.pinnedPresetId = a.presetId;
      state.offeredPresetId = null;
      await loadPreset(a.preset, a.presetId, { audition: true });
    });
  });

  if (state.followLatest) list.scrollTop = list.scrollHeight;
}

function renderByline(
  a: AttemptView,
  pending: boolean,
  owner: string | null,
): string {
  const asked = a.askedByClientId
    ? `${pip(colorOf(a.askedByClientId))}${escapeHtml(nameOf(a.askedByClientId))} asked`
    : "";
  let measured = "";
  if (pending) {
    measured = owner
      ? ` · ${pip(colorOf(owner))}${escapeHtml(nameOf(owner))} rendering…`
      : " · waiting for a browser";
  } else if (a.measuredByClientId) {
    measured = ` · ${pip(colorOf(a.measuredByClientId))}measured by ${escapeHtml(nameOf(a.measuredByClientId))}`;
  }
  return asked + measured;
}

function renderChat(): void {
  const el = $("chatlog");
  const panel = $("chatpanel");
  if (!el || !panel) return;
  const rows = (state.snap.session?.chat ?? []).filter((c) => c.status !== "cancelled");
  if (rows.length === 0 && state.snap.attempts.length === 0) return;
  panel.classList.remove("hidden");

  el.innerHTML = rows
    .map((m, i) => {
      const mine = m.authorClientId === me.id;
      const cls = [
        "turn",
        m.kind === "agent" ? "agent" : m.kind === "system" ? "system" : "you",
        mine ? "mine" : "",
        m.status === "queued" ? "queued" : "",
      ]
        .filter(Boolean)
        .join(" ");
      // Fade with age, but to a much higher floor than the solo version used:
      // with several authors you genuinely need to read back to see who said
      // what and what is still waiting.
      const opacity = m.status === "queued" ? "1" : Math.max(0.6, 1 - i * 0.08).toFixed(2);
      const who =
        m.kind === "agent"
          ? "agent"
          : m.kind === "system"
            ? "·"
            : `${pip(m.color)}${escapeHtml(mine ? "you" : (m.nickname ?? "someone"))}`;
      const badge =
        m.status === "queued"
          ? ` <span class="tag">queued</span>${mine ? ` <button class="morelink" data-cancel="${m.id}">cancel</button>` : ""}`
          : "";
      return `<div class="${cls}" style="opacity:${opacity}">
        <span class="who">${who}${badge}</span>
        <p>${escapeHtml(m.text)}</p>
      </div>`;
    })
    .join("");

  el.querySelectorAll<HTMLButtonElement>("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.slug) void backend.cancelQueued(state.slug, btn.dataset.cancel!);
    });
  });
}

function renderChips(): void {
  const row = $("chips");
  if (!row) return;
  const rows = state.snap.session?.chat ?? [];
  // Newest agent row that offered chips and that this tab hasn't used.
  const src = rows.find(
    (c: ChatView) => c.kind === "agent" && c.suggestions.length > 0 && !state.usedChips.has(c.id),
  );
  if (!src) { row.innerHTML = ""; return; }

  row.innerHTML = src.suggestions
    .map((s, i) => `<button class="chip" data-i="${i}">${escapeHtml(s)}</button>`)
    .join("");
  row.querySelectorAll<HTMLButtonElement>(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const text = src.suggestions[Number(btn.dataset.i)];
      // Chips are shared now, so mark this row used LOCALLY — otherwise the next
      // snapshot brings them straight back, and two people clicking the same chip
      // would each queue the same instruction.
      state.usedChips.add(src.id);
      renderChips();
      if (text) sendChat(text);
    });
  });
}

// --- audio ------------------------------------------------------------------

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

function midiForTarget(): number {
  const f0 = state.snap.session?.target?.f0Hz ?? 220;
  return Math.round(69 + 12 * Math.log2(f0 / 440));
}

/**
 * Auto-load the newest measured preset — unless that would be rude.
 *
 * In a shared session someone else's turn can produce a new patch at any moment,
 * and silently swapping the timbre out from under someone's hands is the fastest
 * way to make an instrument feel untrustworthy. So: never while they are playing,
 * and never over a preset they explicitly chose from the rail. Offer it instead,
 * ON the rail row, where the evidence that something new exists already is.
 */
function maybeAutoLoad(): void {
  const attempts = state.snap.attempts;
  const newest = attempts[attempts.length - 1];
  if (!newest) return;
  if (state.loadedPresetId === newest.presetId) { state.offeredPresetId = null; return; }
  // Not yet measured and not rendering here — wait for it to become real.
  const pending = state.snap.session?.render?.presetId === newest.presetId;
  if (pending && newest.features === null) return;

  const pinnedElsewhere = state.pinnedPresetId !== null && state.pinnedPresetId !== newest.presetId;
  if (pinnedElsewhere || iAmPlaying() || held.size > 0) {
    state.offeredPresetId = newest.presetId;
    return;
  }
  state.offeredPresetId = null;
  void loadPreset(newest.preset, newest.presetId);
}

/** Pull the shared target audio down once, so joiners can hear the sample too. */
async function ensureTargetAudio(): Promise<void> {
  const s = state.snap.session;
  if (!s || !state.slug) return;
  if (!s.hasTargetAudio || !s.target) return;
  if (state.targetAudioFor === state.slug) return;
  state.targetAudioFor = state.slug;

  const url = await backend.targetAudioUrl(state.slug);
  if (!url) return;
  try {
    const res = await fetch(url);
    const bytes = await res.arrayBuffer();
    state.targetAudio = decodePreparedAudio(bytes, s.target.sampleRate);
    renderTargetRow();
  } catch {
    state.targetAudioFor = null; // let a later snapshot retry
  }
}

// --- reconciliation ---------------------------------------------------------

/**
 * The whole client loop, and it is synchronous.
 *
 * Everything asynchronous is dispatched behind a guard and re-enters here when
 * it finishes. That one rule is what replaced `state.busy`: the same snapshot can
 * arrive any number of times and this is a no-op every time after the first.
 */
function reconcile(snap: Snapshot): void {
  state.snap = snap;

  renderPeers();
  renderSessionLabel();
  renderStartPanel();
  renderTargetRow();
  renderAttempts();
  renderChat();
  renderChips();
  renderStatus();

  void ensureTargetAudio();
  maybeAutoLoad();
  maybeRender(snap, { loadPreset, reconcile: () => reconcile(state.snap) });
  scheduleLeaseWake(snap);
}

/**
 * A lease lapsing is NOT a database write, so no subscription will ever fire for
 * it. If this tab might need to take a render over, it has to watch the clock
 * itself — otherwise a dead render owner stalls the session until something
 * unrelated happens to change the document.
 */
function scheduleLeaseWake(snap: Snapshot): void {
  if (leaseTimer) clearTimeout(leaseTimer);
  const s = snap.session;
  if (!s || s.status !== "awaiting_render" || !s.render) return;
  if (s.render.ownerClientId === me.id) return;
  const wait = Math.max(0, msUntilLeaseExpiry(snap)) + 250;
  leaseTimer = setTimeout(() => reconcile(state.snap), wait);
}

// --- actions ----------------------------------------------------------------

async function start(file: File): Promise<void> {
  if (state.starting) return;
  state.starting = true;
  try {
    state.transientError = null;
    setStatus(`Analyzing ${file.name}`, "working");
    const target = await analyzeTarget(file);
    state.targetAudio = target.prepared;

    const slug = newSessionId();
    await backend.createSession(slug);
    // We analyzed the file here, so we already hold the audio — carrying it past
    // attach()'s reset avoids downloading back what we are about to upload.
    attach(slug, { targetAudio: true });

    setStatus("Storing the sample so everyone can hear it", "working");
    const audioId = await backend.uploadTargetAudio(encodePreparedAudio(target.prepared));

    setStatus("Listening to your sample, sketching a patch", "working");
    await backend.setTarget({
      slug,
      features: target.features,
      info: target.info,
      spec: specForTarget(target),
      audioId,
    });
  } catch (err) {
    state.transientError = `Failed: ${String(err)}`;
    renderStatus();
  } finally {
    state.starting = false;
  }
}

async function startFromPrompt(): Promise<void> {
  const box = $<HTMLInputElement>("promptbox");
  const prompt = box?.value.trim();
  if (!prompt || state.starting) return;
  box?.blur();

  state.starting = true;
  try {
    state.transientError = null;
    state.targetAudio = null;
    setStatus(`Designing “${prompt}”`, "working");

    const slug = newSessionId();
    await backend.createSession(slug);
    attach(slug);
    await backend.startFromPrompt({ slug, prompt, spec: specForPrompt() });
  } catch (err) {
    state.transientError = `Failed: ${String(err)}`;
    renderStatus();
  } finally {
    state.starting = false;
  }
}

/**
 * Take a patch somewhere else.
 *
 * A shared session can't be restarted — setTarget and startFromPrompt wipe the
 * conversation, which in a room full of people would delete everyone's work, so
 * the server refuses them once a session is under way. Forking is the way out
 * that doesn't destroy anything: a new room, seeded with this target and this
 * preset, where you get your own turns and nobody has to queue behind you.
 */
async function forkFrom(presetId: string): Promise<void> {
  if (!state.slug) return;
  setStatus("Forking…", "working");
  const newSlug = await backend.forkSession(state.slug, newSessionId(), presetId);
  // null means the mutation failed and already reported itself.
  if (!newSlug) return;
  // The fork points at the SAME stored audio, so carry the decoded buffer over
  // rather than downloading it again.
  attach(newSlug, { targetAudio: state.targetAudio !== null });
}

/**
 * Send, or queue. Never blocked.
 *
 * The old client refused while busy. With several people in a room somebody is
 * almost always mid-turn, so refusing would mean an input that is dead most of
 * the time — and an input that is dead most of the time is one people stop
 * trusting. The server decides whether this becomes a turn or a queued row.
 */
async function sendChat(preset?: string): Promise<void> {
  const input = $<HTMLInputElement>("chat");
  if (!state.slug) return;
  const msg = (preset ?? input?.value ?? "").trim();
  if (!msg) return;
  if (input && !preset) input.value = "";
  // Hand the keyboard back to the instrument. bindTypingKeyboard ignores
  // keystrokes while an input has focus, so leaving focus in the box means the
  // next thing you play types instead — right when you want to hear the change.
  input?.blur();
  // Asking for a change means you want to hear it: stop pinning an older patch.
  state.pinnedPresetId = null;
  state.transientError = null;
  await backend.sendChat(state.slug, msg, state.loadedPresetId);
}

// --- boot -------------------------------------------------------------------

function beat(): Promise<void> {
  const id = state.snap.session?.sessionId;
  if (!id) return Promise.resolve();
  return backend.heartbeat(id, playingUntil());
}

/**
 * Point this tab at a session.
 *
 * Called on boot, and again on every fork — so it has to leave no trace of the
 * previous session behind. `carry.targetAudio` is the one exception: a fork
 * references the same stored audio object, so re-downloading it would be waste.
 */
function attach(slug: string, carry: { targetAudio?: boolean } = {}): void {
  detach?.();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (leaseTimer) clearTimeout(leaseTimer);

  // Per-session view state, all of it keyed to a session that is no longer this
  // one. Leaving any of it behind shows the new room someone else's decisions.
  state.expanded.clear();
  state.usedChips.clear();
  state.pinnedPresetId = null;
  state.offeredPresetId = null;
  state.loadedPresetId = null;
  state.transientError = null;
  if (carry.targetAudio && state.targetAudio) {
    state.targetAudioFor = slug;
  } else {
    state.targetAudio = null;
    state.targetAudioFor = null;
  }

  state.slug = slug;
  putSessionInUrl(slug);
  state.snap = { session: null, attempts: [], peers: [], loaded: false };
  renderStatus();

  detach = backend.subscribeSession(slug, reconcile, (message) => {
    state.transientError = message;
    renderStatus();
  });

  heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_MS);
  void beat();
}

function boot(): void {
  shell();
  bindTypingKeyboard();
  backend.setErrorReporter((message) => {
    state.transientError = message;
    renderStatus();
  });

  // Registered ONCE, not per attach: these read the current session out of
  // state, so re-registering them on every fork would just stack duplicate
  // handlers that all do the same thing.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void beat();
  });
  window.addEventListener("pagehide", () => {
    const id = state.snap.session?.sessionId;
    if (id) backend.leave(id);
  });

  // The front page has nothing to do with any session, so it paints immediately.
  // Gating it behind a WebSocket handshake would make the most common entry into
  // the app slower for no reason at all.
  renderStatus();

  const existing = sessionIdFromUrl();
  if (existing) attach(existing);
}

boot();
