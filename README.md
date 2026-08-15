# Claudio

Drop in a sound. Get back an FM patch worth playing.

Claudio is a browser FM synthesizer driven by a Claude agent working a **closed measurement loop**. You upload an audio sample; the browser analyzes it into a compact feature vector; the agent proposes a preset; the browser renders that preset offline and measures it the same way; the difference goes back to the agent, which refines. After a few iterations you talk to it in plain language — *brighter*, *more attack bite*, *less metallic* — and keep tweaking.

The agent never hears anything. Everything it knows about its own output comes back as numbers.

## The idea

**The artifact is a preset, not a match.** The sample is a starting point for exploration; what you keep is the patch. Success is "I like this sound and I'm going to play it", not "the distance went below 12".

**The samples usually aren't FM sounds.** The test corpus is a Monopoly, a JD-800, a Juno-106, a TR-808, an upright bass DI, and hand percussion. A four-operator FM patch cannot become a PWM analog lead or a sampled shaker, and isn't meant to. The goal is to capture what makes a sound recognizable — brightness, movement, attack, harmonic character — in a patch that stands on its own.

**"If it sounds good, it is good."** The distance is a compass, not a score. It tells the agent which way to walk, not when to be satisfied. A distance of 30 on a sound FM can't natively make is a success, and the agent is explicitly told to prefer the sound over the number — including finalizing an earlier attempt that sounded more coherent than the numerically-best one.

## How it works

```
browser                                   Cloudflare Worker + Durable Object
────────────────────────────────────      ──────────────────────────────────
upload sample
  └─ decode → prepare → STFT features ──▶ setTarget
                                            └─ Claude: propose_preset ──┐
      ┌───────────────────────────────────── {kind:"render", preset} ◀──┘
      ▼
  render preset offline (Tone.Offline)
  extract the IDENTICAL features
  diff vs target ─────────────────────────▶ submitAnalysis
                                            └─ tool_result → Claude refines ──┐
      ◀───────────────────────────────────── next {kind:"render"} or "done" ◀─┘
```

The interesting problem is in the middle. Claude's turn **pauses** at a `tool_use` block, and the data needed to resume it doesn't exist until a later HTTP request — it has to be produced by Web Audio in the browser. So the Durable Object persists the `tool_use` id alongside the message log; when the browser reports back, it synthesizes a `tool_result` carrying that exact id and continues the conversation. The model never knows there was a gap.

Everything the client does is driven by one union — every endpoint returns a `Step` — which is why the whole loop is about ten lines, and why a chat turn flows through the same path as a refinement.

### The synth

One `Tone.FMSynth` whose carrier and modulator are each themselves 2-operator FM oscillators, giving four operators from a "2-op" synth:

```
op4 ──(modulatorFm.index)──▶ op3 ──(modulationIndex)──┐
                             [modEnv: ADSR]           │
                                                      ├──▶ op1 ──▶ out
op2 ──(carrierFm.index)───────────────────────────────┘   [ampEnv: ADSR]
```

Fixed topology, continuous controls — no algorithm switching. Discrete algorithm flips make the diff→fix mapping discontinuous, and with a 3-iteration budget a smooth search space beats a larger jumpy one.

`modEnv` is the load-bearing idea: modulator amplitude *is* modulation index *is* brightness, so `modEnv` is literally the brightness contour over time, while `ampEnv` is loudness. That gives a 1:1 correspondence between a diff entry and a preset field, which is what makes a short loop converge.

There is **no operator feedback** (Tone has none). Grit comes from `modulatorWave: 'sawtooth'` + high `modulationIndex` + a high non-integer `harmonicity`.

### The analysis

STFT at 2048/512 with a Hann window; f0 by YIN-style autocorrelation rather than FFT peak-picking (at 21.5 Hz bins an FFT f0 is ~10% off on low material, which corrupts every harmonic index downstream). Four time anchors — attack / early / sustain / release — each carrying RMS, spectral centroid, and 12 harmonic amplitudes.

Harmonic amplitudes are **dB relative to the loudest harmonic in that frame**, which makes them gain-invariant: overall level can never leak into the spectral distance, and the agent never reasons about absolute loudness when it's reasoning about timbre.

Target and candidate go through the *identical* `prepare()` (mono-sum → peak-normalize → trim silence → re-normalize), so any bug in the extractor affects both signals equally and cancels.

## Running it

```bash
npm install
npm run dev            # Vite + the Worker + the DO in the real workerd runtime
```

### Deploying

Two environments, deliberately separate Workers — so a deploy from a
half-finished branch can never reach the live domain, and dev iteration can't
disturb live sessions. Separate Workers means **separate Durable Object
namespaces and separate secrets**.

| Env | Branch | Worker | URL | Command |
|---|---|---|---|---|
| default | `develop` | `claudio` | `claudio.<subdomain>.workers.dev` | `npm run deploy` |
| production | `main` | `claudio-prod` | `claudio-prod.<subdomain>.workers.dev` <br>(`claudio.humble.audio` pending DNS) | `npm run deploy:prod` |

Each needs its own key: `npx wrangler secret put ANTHROPIC_API_KEY [--env production]`.

> The environment is selected at **build** time via `CLOUDFLARE_ENV`, not by
> `wrangler deploy --env`. The Vite plugin bakes a fully-resolved config into
> `dist/`, so a deploy-time `--env` flag is silently ignored and you end up
> deploying to the wrong Worker. `npm run deploy:prod` sets it correctly.

**Custom domain prerequisite.** `custom_domain: true` requires **Cloudflare to be
authoritative for the hostname's zone**. The route is currently commented out in
`wrangler.jsonc` because it is not, and enabling it fails the deploy outright
("Could not find zone").

A CNAME at an external registrar pointing to `*.workers.dev` is **not** a
substitute. The browser opens TLS with SNI for `claudio.humble.audio`, and
Cloudflare holds no certificate for that name — the handshake fails before
routing is ever considered, and Cloudflare will not issue a cert for a hostname
it does not control. (Host-header routing is a second problem, but the cert is
the one you hit first.) The paid escapes are Cloudflare for SaaS custom
hostnames, or Business-plan partial/CNAME zone setup.

`humble.audio` uses 101domain nameservers and its apex serves a separate live
site, so the low-risk path is **subdomain delegation**: add
`claudio.humble.audio` as its own zone in Cloudflare, then create NS records for
host `claudio` at 101domain pointing to the two nameservers Cloudflare issues.
Nothing else on the domain is touched. Once the zone is Active, uncomment the
`routes` line and run `npm run deploy:prod` — wrangler creates the DNS record and
provisions the certificate itself.

`GET /api/ping` reports whether the key is visible to the Worker and exercises the Durable Object binding.

### Dev scripts

```bash
npm run test:dsp       # extractor self-test against synthetic signals, in plain Node
npm run analyze        # run the extractor over samples/*.wav and print what the agent sees
npm run analyze -- --json chime
npm run typecheck
```

`npm run analyze` is the useful one: it decodes real WAVs with a small RIFF reader and prints the feature table plus a cross-distance matrix, so you can see whether the analysis actually distinguishes a chime from a kick. Its self-distance check (every sample must be distance 0 from itself) catches most extractor bugs in about a second.

`samples/` ships with the repo: twelve WAVs spanning the archetypes FM is good at
and several it isn't — a Monopoly, a JD-800, a Juno-106, a TR-808, an upright bass
DI, and hand percussion. They're deliberately **not** FM sounds, which is the
point: the tool approximates arbitrary audio rather than recovering FM patches.
Drop your own in alongside them.

## Layout

```
src/shared/     the contract — preset schema + clamping + JSON Schema, feature
                and diff types, the Step protocol. Imported by BOTH halves, so
                it must never import Tone.
src/worker/     index.ts (routes) · session.ts (SessionDO, SQLite, the paused
                tool_use) · agent.ts (system prompt, tools, Anthropic call)
src/client/     main.ts (UI + drain loop) · api.ts
  audio/        voice.ts (preset→Tone) · render.ts (Tone.Offline + queue) ·
                index.ts (the only module the UI imports)
  dsp/          fft · f0 · prepare · features · diff — pure Float32Array in,
                JSON out. Imports nothing from audio/, which is what lets it
                be tested in plain Node.
scripts/        Node-only dev utilities (excluded from tsconfig on purpose)
```

Three rules hold this together: `shared/` never imports Tone, `dsp/` never touches Web Audio, and `audio/index.ts` is the only surface the UI sees.

## Notes and sharp edges

- **`Tone.Offline` swaps the global Tone context and is not concurrency-safe.** Every render goes through a promise queue, and live notes wait for render-idle. Overlapping renders produce intermittently silent buffers — the worst possible failure inside a measurement loop.
- **A synth constructed outside the `Tone.Offline` callback renders silence, silently.** If a render comes back empty, check that first.
- **Preset values are LLM-authored**, so `clampPreset()` runs before anything reaches an `AudioParam` — a `NaN` assigned to an AudioParam throws and permanently poisons the node. Strict JSON Schema can't express numeric ranges, so the clamp is load-bearing rather than belt-and-braces.
- **Render failures are reported to the agent** as a tool result rather than thrown, so one out-of-range preset can't wedge a session; the agent self-corrects.
- The deployment is intentionally open — no auth. Low expected volume, and the Anthropic key stays server-side.

`PLAN.md` has the full design reasoning, the timeboxed build order, and the cut lines.

## Status

A timeboxed prototype. Deliberately deferred: streaming responses, preset export and permalinks, built-in starter samples, multi-note and velocity-layer rendering, and session GC.
