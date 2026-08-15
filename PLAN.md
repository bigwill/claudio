# Claudio — Agent-Loop FM Sound Design Tool

## Context

`/Users/willstockwell/agent-workspace/claudio/develop` is an empty repo (one README, one commit, branch `develop`). We are building a **2-hour timeboxed prototype** of a browser-based FM synthesizer driven by a Claude agent loop.

The product idea: a user uploads an audio sample. The browser analyzes it via STFT into a compact feature summary. A Claude agent proposes a 4-operator FM preset. The browser renders that preset offline, extracts the *same* features, and reports a distance + per-feature diff back to the agent, which refines. After 2–3 iterations the user can keep tweaking the preset conversationally ("brighter", "more attack bite").

The interesting claim being tested is the **closed render-compare loop** — the agent isn't guessing once, it's getting numeric feedback on its own output and correcting. That is the part worth protecting inside the timebox.

### What this tool is actually for

**The artifact is a preset, not a match.** The user uploads a sample as a *starting point for exploration*; what they keep and use is the patch. Success is "I like this sound and I'm going to play it", not "the distance went below 12".

**The samples are usually not FM sounds.** The test corpus is Monopoly, JD-800, Juno-106, TR-808, upright bass DI, and hand percussion. A 4-op FM patch cannot become a PWM analog lead or a sampled shaker, and isn't meant to. The goal is to capture what makes a sound recognizable — brightness, movement, attack, harmonic character — in a patch that's worth playing on its own terms.

**"If it sounds good, it is good."** The distance is a *compass, not a score*: it tells the agent which way to walk, not when to be satisfied. A distance of 30 on a sound FM can't natively make is a success. Chasing the last few points at the cost of musicality is the wrong trade, and the agent is explicitly instructed to prefer the sound over the number — including finalizing an earlier attempt that sounded more coherent than the numerically-best one.

This shapes three things concretely: the system prompt (above), the `finalize` instruction (choose what you'd want to *play*), and chat mode (where the target is irrelevant and the user's ear is the only judge).

### Decisions already made (by the user)

| Decision | Choice |
|---|---|
| Synth | ~~4 operators, ~8 fixed algorithms~~ → **superseded**: use an existing library rather than hand-rolling. See "Synth engine" below — we get 4 operators, but a single fixed topology instead of 8 algorithms, and no operator feedback. |
| Agent loop | Closed loop with render-compare, 2–3 iterations |
| Deployment | Deployed to Cloudflare (Worker + static assets + Durable Object session) |
| Input | File upload (drag/drop); baked-in starter samples are a later nice-to-have |
| LLM | Anthropic API, `claude-opus-5`, key held as a Worker secret |
| Access | Shared-secret gate on `/api/*`, secret stored via `wrangler secret` |

### Environment findings

- Node v25.8.0, npm 11.19.0, `npx wrangler` 4.123.0 available.
- **Not authenticated to Cloudflare** — no `~/.wrangler` config dir. The user will need to run `! npx wrangler login` (interactive) before the deploy step.
- `ANTHROPIC_API_KEY` is not in the shell env. It goes in as a Worker secret (`wrangler secret put ANTHROPIC_API_KEY`), never in the client bundle.

### This plan is a deliverable

This document ships **in the repo** as `PLAN.md`, not just in the plan scratch dir. Step 0 of the build is to copy it to `/Users/willstockwell/agent-workspace/claudio/develop/PLAN.md` and commit it on `develop`; it gets updated in place as decisions change during the build, so the repo carries the reasoning alongside the code.

### Model choice

Per current Anthropic docs: use **`claude-opus-5`** (1M context, $5/$25 per MTok). Notes that shape the implementation:

- Thinking is **on by default** on `claude-opus-5` — `max_tokens` caps thinking *plus* response text, so size it generously (≥8K) or responses truncate mid-answer.
- `temperature`/`top_p`/`top_k` are **rejected** (400). Steer with prompting only.
- Assistant-turn prefills are **rejected** (400). Use tool definitions / `output_config.format` to constrain shape.
- Use `strict: true` on the preset tool so the emitted JSON validates exactly against our preset schema — but note strict schemas **cannot** express numeric ranges, so runtime clamping is still required.
- `output_config: {effort: "low"}` for the refine iterations to keep the loop responsive; `"medium"` for the first proposal, which does the most reasoning. Full request shape in the agent-loop section below.

### Synth engine: `tone@15.1.22`

**Do not hand-write the FM engine.** FM is solved; the prototype's value is in the upload→preset path and the agent-driven exploration loop. The engine is a means to an end and should consume as little of the 2 hours as possible.

Survey result (all checked against the live npm registry): **`tone@15.1.22`**, ~970k downloads/month, actively maintained, ships its own types throughout. `Tone.Offline` is exactly the render primitive this product needs, and `Tone.FMSynth` already speaks in `harmonicity`/`modulationIndex` — the vocabulary the agent thinks in. **Zero DSP code written.**

Rejected: **no installable Dexed/MSFA package exists** (checked `dexed`, `js-dx7`, `dx7-synth-js`, `@webaudiomodules/dexed` and six others — all 404, plus a full-text registry search). `hexterjs` is real and offline-capable but is GPL-2.0 (viral copyleft on a company prototype), dead since 2020, and its preset format is 155-byte packed DX7 SysEx — writing a JSON→SysEx packer for 6 ops × 21 params, debugged blind against a WASM blob, is *strictly more work than the hand-written engine we were told not to build*. `@grame/faustwasm` is a compiler, not an instrument.

**Plan B on file:** `@audio/synth-fm@0.2.1` is a pure function `fm(freq, opts) => Float32Array` — no context, no async — and it *does* have operator feedback. But it's v0.2 with 356 downloads/month, serial-chain-only, and has no sustain or per-op ADSR (so no note-on/note-off and no live playback). Keep it behind the same mapping interface as the swap if Tone's missing feedback blocks matching noisy samples.

### Getting 4 operators out of a "2-operator" synth

`Tone.FMSynth` is nominally 2-op. But its `oscillator` and `modulation` are `OmniOscillator`s, and `OmniOscillatorType` includes `"fmsine" | "fmsquare" | "fmsawtooth" | "fmtriangle"` — each of which is itself a 2-op `FMOscillator` with its own `harmonicity` and `modulationIndex`. So one `FMSynth` with both oscillators set to an `fm*` type is **effectively 4 operators, for free**:

```
  op4 ──(modulatorFm.index)──▶ op3 ──(modulationIndex)──┐
                               [modEnv: ADSR]           │
                                                        ├──▶ op1 ──▶ out
  op2 ──(carrierFm.index)───────────────────────────────┘   [ampEnv: ADSR]
```

Honest accounting: op2 and op4 have static indices with no envelope, so each is worth maybe "1.5 operators" of expressiveness. We get 4 oscillators, 3 independent modulation indices, 3 ratios, 2 ADSRs — plus per-operator waveform choice, which a real DX7 doesn't have.

### ⚠️ Two things this changes from what was originally agreed

**1. The 8 algorithms are dropped** in favour of a single fixed topology with continuous controls. This is a real departure from the earlier "4-op, ~8 algorithms" decision, so it's called out rather than buried.

The topology above is essentially DX7 algorithm 4 (double-stack into one carrier), the most generally useful FM shape — it covers bells, e-pianos, brass, plucks, basses, mallets. What's lost is multiple simultaneous carriers (additive/organ tones) and parallel modulators on one carrier.

Why it likely *helps*: discrete algorithm switching makes the diff→fix mapping **discontinuous**. The agent reads "harmonic 5 is 16 dB too quiet", flips `algorithm: 2 → 5`, and the whole spectrum lurches unpredictably. Continuous indices and ratios give a smooth, well-conditioned search space — which matters enormously when there are only **2–3 iterations** to converge. A smaller continuous space beats a larger discontinuous one at this iteration budget. Partial recovery is cheap if we're ahead: a `voiceMode: 'stack' | 'dual'` field running two `FMSynth`s in parallel (~8 lines) gets the multi-carrier shapes back.

**2. Operator feedback is gone.** Tone has no feedback anywhere — not on `FMOscillator`, not on `FMSynth`. This is the single biggest capability loss, because feedback is the normal way to get gritty/noisy FM timbres. **Substitution:** `modulatorWave: 'sawtooth' | 'square'` + `modulationIndex` above ~15 + a high non-integer `harmonicity` (7–11) produces a comparably dense spectrum. This substitution must appear in *both* the diff hint table and the system prompt, or the agent will keep reaching for a control that doesn't exist.

### The preset schema (the tool-call shape)

```ts
// src/shared/preset.ts
export type Wave = 'sine' | 'triangle' | 'square' | 'sawtooth';
export interface Adsr { attack: number; decay: number; sustain: number; release: number }
export interface InnerFm { ratio: number; index: number }

export interface ClaudioPreset {
  name: string;              // <= 40 chars, e.g. "Glassy Bell"
  harmonicity: number;       // 0.25..12 — integers harmonic, non-integers bell/metallic
  modulationIndex: number;   // 0..30 — 0 pure sine, 2-6 warm, 10-20 bright, 20+ aggressive
  carrierWave: Wave;         // op1
  modulatorWave: Wave;       // op3 — saw/square = dense, gritty, noise-adjacent
  carrierFm:   InnerFm;      // op2 -> op1. ratio 0.25..12, index 0..12 (0 = plain osc)
  modulatorFm: InnerFm;      // op4 -> op3. same ranges
  ampEnv: Adsr;              // op1 amplitude — the loudness shape you hear
  modEnv: Adsr;              // op3 amplitude == modulation index == THE BRIGHTNESS CONTOUR
  detune: number;            // cents, -100..100
  gain: number;              // 0..1
}
```

20 numbers, 2 enums, a name — ~200 tokens as JSON.

**The load-bearing design decision is describing `modEnv` to the agent as "the brightness contour."** In FM, modulator amplitude *is* modulation index *is* brightness. That gives a 1:1 correspondence between a diff field and a preset field: diff says `centroid.sustain` is 4.4 too low and falling too fast → agent edits `modEnv.decay` and `modEnv.sustain`. That direct mapping is what makes a 2–3 iteration loop converge. Every other schema choice is subordinate to preserving it.

**`clampPreset()` is mandatory, not optional** (~20 lines): coerce non-finite values, clamp every range, drop unknown keys, default unknown wave strings to `'sine'`. **An `AudioParam` assigned `NaN` throws and permanently poisons the node** — and the agent authors these values. Mirror the ranges as `minimum`/`maximum` in the tool's JSON Schema too, so the agent usually gets it right unaided (but never rely on that — strict schemas don't enforce numeric ranges).

The mapping function `presetToOptions()` builds Tone options **from a constructor object rather than by mutation**, which sidesteps the `OmniOscillator` trap where `harmonicity`/`modulationIndex` don't exist until `type` has been set to an `fm*` variant.

---

## Audio analysis layer

This is where the DSP effort actually goes. Three functions are the whole contract between the audio layer and the agent layer:

```ts
// src/audio/index.ts
analyzeTarget(file: File): Promise<TargetAnalysis>          // features -> Claude, audio stays local
evaluatePreset(preset, target): Promise<{ features, diff, buffer }>   // diff -> Claude
playNote(preset, midi, velocity): () => void                // live audition
```

### Feature summary (what Claude reads on turn 1)

A compact, gain-invariant, musician-legible JSON (~300–350 tokens). Not a spectrogram.

- `f0Hz`, `f0Confidence`, `f0DriftCents` — pitch, plus whether it's even pitched, plus vibrato/glide.
- `amp: { attackMs, decayMs, sustainLevel, releaseMs }`, `durationMs`.
- `inharmonicityCents` — 0 = harmonic, >30 = bell/metallic. Drives non-integer ratios.
- `noiseRatio`, `oddEvenBalance` — drives feedback and ratio choice.
- `frames[4]` — snapshots at **attack / early / sustain / release**, each with `rmsDb`, `centroidRatio` (brightness expressed in harmonic numbers), and `harmonicsDb[12]`.

**Key design choice: harmonic amplitudes are in dB relative to the loudest harmonic *in that frame*.** That makes them gain-invariant, so overall level can never leak into the spectral distance and Claude never reasons about absolute amplitude when it's reasoning about timbre. Four time anchors (not one, not a full spectrogram) is what captures "bright attack that dulls into a mellow sustain" — the single most FM-relevant shape — at negligible token cost.

STFT params: 2048-point FFT, 512 hop (75% overlap), Hann window, no resampling. f0 comes from a time-domain NSDF/YIN-lite estimator, **not** from FFT bins — at 21.5 Hz bin spacing an FFT f0 for a low sample is off by ~10%, which corrupts every harmonic index downstream.

### The diff (what actually steers the agent)

The scalar distance exists for the progress bar and the stop condition. The **diff** is what makes the loop converge, and its design rule is: *every entry names a direction to move and an FM control that would move it.*

```ts
FeatureDiff = {
  distance: number            // 0..100, <12 is a good match
  breakdown: { spectrum, envelope, pitch, noise }
  verdict: string             // one sentence
  priorities: string[]        // 3-5 ordered plain-English fixes — the agent reads this first
  scalars: ScalarDiff[]       // {name, target, got, delta, unit, direction, severity, hint}
  harmonics: HarmonicDiff[]   // {frame, h, targetDb, gotDb, deltaDb, hint}
}
```

`distance = 100 * (0.55*spectrum + 0.25*envelope + 0.10*pitch + 0.10*noise)`. Spectrum dominates because that is what FM parameters control and what "sounds like the sample" means. Pitch is weighted low because we render at the target's detected f0 anyway — it's only there to catch a wrong-octave carrier.

Hints come from a ~25-line lookup table translating numeric deltas into FM instructions, e.g. *"Harmonic 7 is 32 dB too quiet at the attack — raise the modulator's peak level"*, *"Target's brightness collapses within 300 ms; yours barely changes — shorten the modulator's decay"*, *"Target is inharmonic (41 cents) — use a non-integer modulator ratio."* A populated diff runs ~450 tokens and an FM programmer could act on it directly.

### Render-and-analyze path

Target and candidate go through **the identical** `prepare()`: mono-sum → peak-normalize → trim leading silence (−50 dBFS) and trailing (−60 dBFS) → re-normalize → cap at 4 s.

Trimming both is load-bearing: without it a target with 80 ms of pre-roll reports a phantom 80 ms attack error on every iteration and the agent chases it forever. Running the candidate through the same code path means any extractor bug affects both signals equally and cancels.

Render the candidate at the target's detected f0, for the target's trimmed duration (capped ~2.5s so the loop doesn't feel dead), **at the target's sample rate**, via `Tone.Offline`.

**`Tone.Offline` gotchas — verified by reading the implementation, not the docs:**

1. **It mutates the global Tone context** (`setContext(offline)` … `setContext(original)`). It is **not concurrency-safe** — overlapping calls stomp each other. Serialize every render through a promise queue. This is mandatory.
2. **Nodes must be constructed *inside* the callback** and connected with `.toDestination()`. A synth built outside belongs to the live context and renders pure silence — and it fails *silently*, which is why it costs 20 minutes when it happens.
3. **`channels` defaults to 2 and `sampleRate` defaults to the live context's rate.** Pass `1` and the target's rate explicitly, every time.
4. It returns a **`ToneAudioBuffer`**, not an `AudioBuffer` — use `.get()`.
5. **`portamento` must be 0 offline**, or the pitch glides into the note and corrupts the attack-frame harmonic analysis.
6. Good news: `OfflineContext` is built with `lookAhead: 0` and starts at `_currentTime = 0`, so `time = 0` is genuinely frame 0 — no lead-in to compensate for.
7. **Offline rendering needs no user gesture** — only the live context does (`Tone.start()`). So `analyzeTarget` and the first render can run before the user clicks anything, and the first preset is ready by the time they press play. Free UX win.

`decodeAudioData` resamples to the decoding context's rate — create one live `AudioContext` at startup, decode the upload with it, and use `buffer.sampleRate` everywhere after. Never hardcode 44100.

**Determinism smoke test, at ~minute 12 and not later:** render the same preset twice and assert `diffFeatures(a, b).distance === 0`. Tone should be deterministic here (phase defaults to 0, envelopes are scheduled AudioParam ramps, no randomness), but if it isn't, every iteration afterwards is chasing noise and we need to know immediately.

---

## Cloudflare architecture

### Workers + static assets, not Pages

Cloudflare's current guidance is explicit: new projects should use Workers, not Pages. The decisive point for us is narrower though — **a Pages Function cannot define a Durable Object class.** Using Pages would mean a separate Worker for the DO, two deploys, two configs, and a cross-project binding: a guaranteed ~20-minute tax on the highest-risk part of the build. Workers + static assets puts frontend, API, and DO in one `wrangler deploy`.

### Durable Objects: SQLite-backed is mandatory

On the Workers **free plan, only SQLite-backed Durable Objects are available** — the legacy KV backend is paid-only. So `new_sqlite_classes` is both the modern choice and the only one that will deploy. Free limits (100k req/day, 5 GB storage) are nowhere near binding for a prototype.

Use the imperative `migrations` array, not the newer declarative `exports` field: the two are mutually exclusive, `exports` is absent from the schema of the wrangler binary installed globally on this machine (4.70.0), and `migrations` is what every example and model prior knows. Switching later is a 3-line change.

### `wrangler.jsonc`

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "claudio",
  "main": "./src/worker/index.ts",
  "compatibility_date": "2026-08-14",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "durable_objects": { "bindings": [{ "name": "SESSION", "class_name": "SessionDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["SessionDO"] }],
  "observability": { "enabled": true }
}
```

`@cloudflare/vite-plugin` runs the Worker + DO in the real workerd runtime inside `vite dev` — one process, client HMR, real DO semantics locally.

**Version hazard:** the global `wrangler` is 4.70.0, `npx wrangler` pulls 4.123.0. Pin wrangler in `devDependencies` and only ever invoke it through npm scripts.

### Session state (one DO per session)

Addressed by a client-generated UUID via `env.SESSION.getByName(sessionId)`. Two SQLite tables:

- `meta` — a single JSON row: status, target features, iteration count, `pendingToolUseId`, `pendingPresetId`, attempt history, best preset.
- `messages` — append-only, one row per Anthropic `MessageParam`.

Two tables rather than one blob because the message log grows unboundedly across chat turns and would eventually exceed the 128 KiB value limit. Costs ~8 lines. Schema creation goes in the constructor under `ctx.blockConcurrencyWhile()` — and never held across the Claude fetch.

Surface is typed DO **RPC methods** (compat date is well past the ≥2024-04-03 requirement), not a nested `fetch()` router: `setTarget`, `submitAnalysis`, `submitRenderError`, `chat`, `snapshot`.

---

## The agent loop protocol

**The problem:** render+analyze lives in the browser; the Claude conversation lives in the DO. Claude's turn *pauses* at a `tool_use` block and can only resume when a matching `tool_result` is appended — but that data doesn't exist until an HTTP round trip later. The paused conversation has to survive the gap.

**The solution:** the DO persists `pendingToolUseId` next to the message log. When the browser reports back, the DO synthesizes the `tool_result` with that exact id, appends it, and calls Claude again. The conversation never knows there was a gap.

Every endpoint returns one `Step` union:

```ts
type Step =
  | { kind: "render";  presetId, preset, rationale, iteration, iterationsRemaining, note }
  | { kind: "message"; text, preset, iteration }
  | { kind: "done";    text, preset, presetId, distance }
  | { kind: "error";   message, retryable }
```

That unification is what keeps this small — and it means a chat turn ("brighter") flows through the *identical* client path as the refinement loop, because Claude answering "brighter" with `propose_preset` just yields another `{kind:"render"}`.

The client is genuinely ~10 lines:

```ts
async function drain(step: Step) {
  while (step.kind === "render") {
    ui.showAttempt(step);
    try {
      const buf  = await renderPreset(step.preset);
      const got  = analyze(buf);
      const diff = compareFeatures(targetFeatures, got);
      step = await api.submitAnalysis(sessionId, step.presetId, got, diff);
    } catch (e) {
      step = await api.submitRenderError(sessionId, step.presetId, String(e));
    }
  }
  ui.showFinal(step);
}
```

The `catch → submitRenderError` path is **mandatory, not polish.** JSON Schema in structured outputs cannot express numeric ranges, so the agent *can* hand us `ratio: 240`. Without the catch, one bad preset wedges the session forever; with it, the DO returns a `tool_result` with `is_error: true` and the agent self-corrects — which demos better than silent clamping.

Endpoints: `POST /api/session`, `POST /api/session/:id/target`, `.../analysis`, `.../render-error`, `.../chat`, `GET /api/session/:id`.

**Idempotency:** `submitAnalysis` rejects unless `presetId === meta.pendingPresetId`. A double-click, retry, or mid-render reload can't desync the conversation.

**Never leave `status: "thinking"` on a thrown Claude call** — the catch must restore the prior status or the session is wedged.

### HTTP, not WebSockets

The protocol is inherently request/response: exactly one operation is outstanding at a time and nothing happens server-side without the client asking, so the main reason to reach for WebSockets isn't present. Hibernation API + framing + correlation ids + reconnect is realistically 40–50 minutes — a quarter of the budget — on the layer most likely to differ between `vite dev` and production. It would buy us token streaming in chat; a spinner is fine.

Safety check: Cloudflare's HTTP ceiling is ~100s; a non-streaming call at low effort lands in ~3–10s. Comfortable. If chat feels sluggish later, add SSE before WebSockets.

### Model and request shape

Default to **`claude-opus-5`**. Sonnet 5 is a reasonable swap if loop latency hurts the demo — see the open question below; it's a one-line change either way.

```ts
{
  model: "claude-opus-5",
  max_tokens: 8192,                      // thinking is on by default and counts against this
  thinking: { type: "adaptive" },
  output_config: { effort: isFirstProposal ? "medium" : "low" },
  tool_choice: { type: "any", disable_parallel_tool_use: true },
}
```

Three non-obvious points:

1. **Don't set `thinking: {type:"disabled"}`.** Thinking-off makes the model *less* likely to reach for tools — precisely the behavior the loop depends on. Control speed with `effort` instead.
2. **`disable_parallel_tool_use: true` is load-bearing.** Otherwise Claude may emit two `propose_preset` blocks in one turn and we can only render one.
3. **`tool_choice: "any"` during refinement, `"auto"` during chat.** In the loop we want action; in chat, "what does feedback do?" should get a text answer, not a forced preset.

### Tools

Two: `propose_preset(preset, rationale)` and `finalize(preset, rationale)`, both `strict: true`.

Two schema gotchas:

- **`strict: true` requires every property listed in `required` plus `additionalProperties: false` everywhere** — which kills an optional `fixedHz?`. Use a `0` sentinel meaning "use ratio instead", documented in `src/shared/preset.ts` so the audio layer implements it identically.
- **No `minimum`/`maximum`/array-length constraints are supported.** Ranges live in the `description` strings; enforcement is the client-side try/catch plus a `sanitizePreset()` clamp if time allows.

The `propose_preset` description explicitly frames the tool as *the agent's measurement instrument* — "the browser will render this and return a per-feature diff; use it to test one hypothesis at a time."

### System prompt

Four sections:

1. **How the loop works** — "you propose, the browser measures, you get a diff back; you are matching a *feature vector*, not a waveform; change one or two things per iteration and say what you expect them to do — a controlled experiment beats a shotgun."
2. **The engine's causal facts** — the fixed op4→op3→op1 ← op2 topology; `modulationIndex` is the primary brightness control; integer `harmonicity` → harmonic/pitched, non-integer → inharmonic/bell/metallic; `modEnv` shapes **timbre over time** while `ampEnv` shapes **loudness over time**, and a modEnv decay shorter than the ampEnv decay gives the classic "bright attack that mellows out" signature of struck and plucked sounds. **Plus the explicit statement that this engine has no operator feedback**, and that density/grit comes from `modulatorWave: 'sawtooth'` + high `modulationIndex` + high non-integer `harmonicity`.
3. **How to read the diff** — feature by feature, each with the direction to move and the `ClaudioPreset` field that moves it.
4. **Working rules** — first proposal picks a plausible *archetype* (struck metal / plucked string / brass / e-piano / bass / pad) and instantiates it, rather than starting from a default sine; each later proposal addresses the one or two largest weighted errors specifically; reverse a change that moved a feature the wrong way rather than compounding it; when `iterations_remaining` hits 0, finalize with the **best** preset seen, not the most recent.

**Structural rule: the causal-facts section is generated from the same constants module the preset schema comes from**, so the prompt cannot drift from the engine. The missing-feedback substitution must appear in both the prompt and the diff hint table — otherwise the agent will keep reaching for a control that doesn't exist.

`cache_control: {type: "ephemeral"}` on the last system block caches tools + system together (render order is tools → system → messages). Verify with `usage.cache_read_input_tokens`.

---

## Repo layout

```
src/shared/          # THE CONTRACT — frozen after slice 2
  preset.ts          #   ClaudioPreset, clampPreset(), DEFAULT_PRESET, 3 factory presets,
                     #   PRESET_JSON_SCHEMA (used by the Worker's tool definition)
  features.ts        #   FeatureSummary, FrameFeature, FeatureDiff, ScalarDiff, HarmonicDiff
  protocol.ts        #   Step union, request/response bodies
src/worker/
  index.ts           # fetch handler, /api/* routing, secret check, re-exports SessionDO
  session.ts         # SessionDO — RPC methods + SQLite
  agent.ts           # system prompt, tool defs, Anthropic call
src/client/
  main.ts            # UI wiring + the drain loop
  api.ts             # typed fetch wrappers over protocol.ts
  audio/
    voice.ts         #   presetToOptions(), buildVoice(), live playback
    render.ts        #   renderPreset() — Tone.Offline + serialization queue
    index.ts         #   analyzeTarget / evaluatePreset / playNote — THE public API
  dsp/
    fft.ts f0.ts prepare.ts features.ts diff.ts
```

Three boundaries, strictly enforced:

- **`src/shared/` is the parallelization seam.** Write it before anything else and freeze it after slice 2 — it's what lets the audio work and the Worker plumbing proceed without merge pain. Critically, it must **not import Tone**: the Worker needs `PRESET_JSON_SCHEMA` and the `ClaudioPreset` type, and pulling a 200 KB audio library into a Worker bundle to get them would be silly.
- **`src/client/dsp/*` imports nothing from `audio/` and touches neither Tone nor Web Audio** — pure `Float32Array in → JSON out`. That makes the extractor unit-testable in plain Node against a synthetic sawtooth, which we will want the moment a diff looks wrong.
- **`src/client/audio/index.ts` is the only module the UI and transport layer import.** It owns Tone, all context lifecycle, and all clamping.

---

## Build order — eight 15-minute slices

| Slice | Time | Work | Exit condition |
|---|---|---|---|
| 0 | — | Copy this plan to `PLAN.md`, commit on `develop` | Plan is in the repo |
| 1 | 0:00–0:15 | Deps (incl. `tone`), vite/wrangler config, Worker `/api/ping` + secret gate. `wrangler secret put ANTHROPIC_API_KEY` and `APP_SECRET`. **Deploy.** | Live `*.workers.dev` URL, 401 without the key |
| 2 | 0:15–0:30 | Write and **freeze** `src/shared/*` — `ClaudioPreset`, `clampPreset`, `PRESET_JSON_SCHEMA`, feature/diff types, `Step` | Both halves compile against the same types |
| 3 | 0:30–0:45 | `SessionDO` + routing; `runClaude()` returns a **hardcoded** preset | `curl` target endpoint → `{kind:"render"}` |
| 4 | 0:45–1:00 | Client: drop → decode → *stub* analyze → POST → `drain()` with *stub* render | **Full round trip proven with fake DSP and fake Claude at the halfway mark** |
| 5 | 1:00–1:20 | Real Claude: prompt, tools, `tool_use` extraction, `tool_result` resumption, budget, `finalize` | Live agent proposes and refines against stub features |
| 6 | 1:20–1:35 | Swap in the real synth + analysis + diff | **First genuine closed-loop match on a real sample** |
| 7 | 1:35–1:50 | Chat box → same `drain()`. Distance-per-iteration list, A/B play buttons | Demoable |
| 8 | 1:50–2:00 | Deploy, verify live, README, commit, PR | Deployed and verified |

**Two scheduling decisions that matter most:**

- **Deploy in slice 1, not slice 8.** Cloudflare deploy is a hard requirement and a classic 2-hour-project killer. Doing it while the app is hello-world makes every later deploy a no-op re-run of a known-good command.
- **End-to-end with stubs at minute 60.** By halftime the riskiest thing — a Claude conversation paused across an HTTP round trip — is either working or visibly broken, with an hour left either way.

### Cut lines, in order

1. Prompt caching (5 min, costs pennies)
2. Chat mode — the closed loop alone demonstrates the thesis; chat is the second demo
3. The `finalize` tool — just stop at `maxIterations` and pick the lowest-distance attempt
4. `GET /api/session/:id` reload support — keep session state in browser memory
5. `sanitizePreset()` clamping — but **never** cut `try/catch → submitRenderError`
6. UI polish — raw `<pre>{JSON.stringify(step)}</pre>` arguably demos the loop better anyway

On the audio side, cut in this order:

1. **`carrierFm` / `modulatorFm`** — force both inner indices to 0, giving a plain 2-op `FMSynth`. Keep the fields in the schema so the agent can still emit them and nothing downstream changes. Cheapest and safest cut; a 2-op FMSynth with a good `modEnv` already matches a surprising range of samples.
2. **`inharmonicityCents` + `noiseRatio`** — renormalize the distance to 0.7 spectrum / 0.3 envelope. Costs bells and cymbals, keeps everything harmonic.
3. **4 frames → 2** (`attack`, `sustain`) — halves the JSON, kills the brightness-trajectory diff.
4. **12 harmonics → 8** — nearly free.
5. **YIN → FFT peak + parabolic interpolation** — ~10 lines instead of 40, at the cost of f0 accuracy on low samples; add a UI field to type the note.

**Never cut:** `clampPreset` (agent-authored `NaN` into an AudioParam permanently poisons the node), `prepare()`'s trim + peak-normalize, the gain-invariant harmonic dB representation, the render serialization queue, or the two self-consistency tests. Each is load-bearing for convergence and each is cheap.

**Stretch goals if ahead, in order:** pitch envelope via `frequency.exponentialRampToValueAtTime` (2 lines, unlocks FM basses and kicks) → `voiceMode: 'dual'` for multi-carrier/organ tones (~8 lines) → `Tone.LFO` on `detune` for vibrato (~6 lines).

### Deliberately deferred

WebSocket/SSE streaming; built-in starter samples; preset export and permalinks; multi-note/velocity-layer rendering; alarm-based session GC; Vitest DO tests; migration to the `exports` field.

---

## Risks

1. **Open API key on a public URL.** `*.workers.dev` is world-reachable and every request burns Anthropic quota. ~5 min mitigation: shared-secret header checked in the Worker, passed once as `?k=`. Better: Cloudflare Access. **Do not skip if the URL gets shared.**
2. **`assets.directory` + vite-plugin interaction** — docs say omit it; confirm in slice 1 with `npx vite build && ls dist/`. Fallback: `"directory": "./dist/claudio"`.
3. **Wrangler version split** (4.70 global vs 4.123 npx) — pin it, invoke via npm scripts only.
4. **No numeric ranges in strict schemas** — assume the agent will go out of range; the try/catch is the real defense.
5. **Render latency.** The offline render must return in well under a second or the loop feels dead. Render one note, capped at ~2.5s, at the target's detected f0 and sample rate.
6. **`decodeAudioData` codec support** — WAV is universal, mp3 varies. Develop and demo in Chrome.
7. **`Tone.Offline` is not concurrency-safe** (it swaps the global context). Every render goes through a promise queue, and no live note is triggered while a render callback is executing. Skipping this produces intermittent silent or corrupted renders — the worst possible failure mode inside a measurement loop.
8. **Nodes built outside the `Tone.Offline` callback render silence, silently.** No error, no warning, just a zero buffer and a nonsense diff. If a render comes back empty, check this first.
9. **Bundle size** — Tone is ~200 KB gzipped. Fine for a prototype, worth noting. Keep it out of the Worker bundle (see repo layout).

---

## Verification

- **Slice 1:** `curl https://<url>/api/ping?k=<secret>` returns JSON; without the key it returns 401; `curl https://<url>/` returns the HTML.
- **Render determinism (~minute 12 of the audio work, not later):** render the same preset twice, assert `diffFeatures(a, b).distance === 0`. If renders aren't deterministic, every iteration afterwards is chasing noise.
- **DSP unit check (Node, no browser):** feed `extractFeatures` a synthesized 220 Hz saw — expect `f0Hz ≈ 220` and `harmonicsDb ≈ [0, -6, -9.5, -12, …]`. Do not skip this.
- **Self-comparison test:** `diffFeatures(x, x)` must return `distance ≈ 0`. Takes 60 seconds and catches nearly every extractor bug.
- **Loop sanity:** `evaluatePreset(bellPreset, brassTarget)` returns a large distance with sensible `priorities`.
- **Round trip with stubs (end of slice 4):** upload → `{kind:"render"}` → stub analysis → next `Step`. Proves the paused-`tool_use` resumption before any real DSP or LLM is involved.
- **End-to-end on the live URL (slice 8):** upload a WAV, watch distance decrease across iterations, hear the A/B, then type "brighter" and confirm the preset changes in the expected direction.

---

## Resolved decisions

- **Model: `claude-opus-5`.** Chosen over Sonnet 5 despite the latency cost — the sound-design reasoning here (mapping a spectral-centroid delta to a modulation-index change) is exactly where the tier gap shows.
- **Access control: shared-secret header, stored as a Worker secret.** Added to slice 1 (~5 min): `wrangler secret put APP_SECRET`, the Worker rejects any `/api/*` request whose `?k=` (or `X-App-Key` header) doesn't match, and the client reads it once from the URL and keeps it for the session. Quota burn isn't the concern; this is just a cheap gate so a shared link isn't an open endpoint.
