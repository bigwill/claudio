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
browser (every contributor)                Convex
────────────────────────────────────       ──────────────────────────────────
upload sample
  └─ decode → prepare → STFT features ───▶ setTarget  (+ the audio itself)
                                             └─ schedule turn ──┐
                                             ┌─ Claude: propose_preset ◀──┘
                                             ▼
      ◀──── awaiting_render, renderOwner ─── reactive query → ALL contributors
      ▼
  the assigned browser renders offline (Tone.Offline)
  extracts the IDENTICAL features
  diffs vs target ──────────────────────▶ submitAnalysis
                                             └─ tool_result → Claude refines ──┐
      ◀──── next proposal, live to everyone ◀────────────────────────────────┘
```

The interesting problem is in the middle. Claude's turn **pauses** at a `tool_use`
block, and the data needed to resume it doesn't exist until some browser produces
it with Web Audio. So the session row persists the `tool_use` id alongside the
message log; when a browser reports back, the server synthesizes a `tool_result`
carrying that exact id and continues the conversation. The model never knows
there was a gap.

**Sessions are multiplayer.** Anyone with the link is a contributor: they see the
iterations fill in live, play every preset on their own keyboard, hear the target
sample, and talk to the agent. Identity is a nickname and a colour in
localStorage — there is no login, and `clientId` is used for attribution and
render duty only, never for anything that matters.

Two consequences worth knowing:

- **Only one browser renders each proposal** — whoever triggered the turn — and a
  lease hands it to someone else if that tab goes away. Everyone else just
  receives the preset JSON and plays it locally, so nobody's CPU is doing
  duplicate DSP.
- **Messages are never refused.** Send one mid-turn and it queues, attributed and
  visible; it rides along on the next `tool_result` rather than waiting out the
  refine loop. Several can land in one turn, and the agent is told to say so when
  people ask for things that pull against each other.

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
npx convex dev --once          # one-off: creates the deployment, writes .env.local
npx convex env set ANTHROPIC_API_KEY sk-ant-...
npm run dev                    # Convex + Vite together
```

`npm run dev` runs `convex dev --start 'vite dev'`, so the backend watcher and the
frontend come up as one process. `npm run dev:web` and `npm run dev:convex` run
them separately if you'd rather.

`npx convex dev` will offer a **local** deployment that needs no account. That's
fine for building and for two windows on one machine, but a local deployment has
no public URL — a second *person* needs a cloud deployment, which is
`npx convex dev --configure` after `npx convex login`.

### Deploying

Two Cloudflare Workers, deliberately separate — so a deploy from a half-finished
branch can never reach the live domain. Both are **static assets only**: the
backend is Convex, and the browser talks to it directly over a WebSocket.

| Env | Branch | Worker | Convex | Command |
|---|---|---|---|---|
| default | `develop` | `claudio` | your dev deployment | `npm run deploy` |
| production | `main` | `claudio-prod` | your prod deployment | `npm run deploy:prod` |

Each Convex deployment needs its own key:
`npx convex env set ANTHROPIC_API_KEY sk-ant-... [--prod]`.

> **`VITE_CONVEX_URL` is baked into the bundle at build time.** `npm run deploy`
> builds against whatever `.env.local` points at (your dev deployment);
> `npm run deploy:prod` runs `convex deploy --cmd 'vite build'`, which pushes the
> functions and injects the *production* URL into the build. Running a bare
> `vite build` and shipping it to production would deploy a page pointed at your
> dev backend, and nothing would visibly complain.

This is the same shape of footgun the old `CLOUDFLARE_ENV` trap had, for a
different reason. That one is gone: with no Worker script, the Vite plugin no
longer bakes a resolved config into `dist/`, so `wrangler deploy --env production`
behaves normally again — and `deploy:prod` passes it explicitly.

### Releasing

Deploys are run locally; there's no CI. Production is a separate Worker *and* a
separate Convex deployment, so it does **not** update when you deploy develop:

```bash
git -C /path/to/main-worktree merge develop && git push origin main
npm run deploy:prod
```

**Custom domain prerequisite.** Unchanged by the port — Cloudflare still
terminates TLS for the static site, so `custom_domain: true` still requires
Cloudflare to be authoritative for the hostname's zone. The route is commented out
in `wrangler.jsonc` because it isn't, and enabling it fails the deploy outright
("Could not find zone").

A CNAME at an external registrar pointing to `*.workers.dev` is **not** a
substitute. The browser opens TLS with SNI for `claudio.humble.audio`, and
Cloudflare holds no certificate for that name — the handshake fails before routing
is ever considered, and Cloudflare will not issue a cert for a hostname it does not
control. The paid escapes are Cloudflare for SaaS custom hostnames, or
Business-plan partial/CNAME zone setup.

`humble.audio` uses 101domain nameservers and its apex serves a separate live
site, so the low-risk path is **subdomain delegation**: add `claudio.humble.audio`
as its own zone in Cloudflare, then create NS records for host `claudio` at
101domain pointing to the two nameservers Cloudflare issues. Nothing else on the
domain is touched. Once the zone is Active, uncomment the `routes` line and run
`npm run deploy:prod`.

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
                and diff types, identity, and the lease constants the client's
                ticker and the server's watchdog must agree on. Imported by BOTH
                halves, so it must never import Tone.
convex/         schema.ts · validators.ts (+ compile-time drift guards against
                src/shared) · sessions.ts · chat.ts · render.ts · presence.ts
                turn.ts (the ported state machine) · agent.ts (the Claude call)
                prompt.ts (system prompt + tools) · crons.ts (the watchdog)
  model/        plain helpers taking ctx — turn, messages, presence, sessions,
                tools. The registered functions stay thin.
src/client/     main.ts (UI + reconcile) · convex.ts (the only module that knows
                Convex exists) · reconcile.ts (render duty) · identity.ts
  audio/        voice.ts (preset→Tone) · render.ts (Tone.Offline + queue) ·
                index.ts (the only module the UI imports)
  dsp/          fft · f0 · prepare · features · diff — pure Float32Array in,
                JSON out. Imports nothing from audio/, which is what lets it
                be tested in plain Node.
scripts/        Node-only dev utilities (excluded from tsconfig on purpose)
```

Four rules hold this together: `shared/` never imports Tone, `dsp/` never touches
Web Audio, `audio/index.ts` is the only surface the UI sees, and `convex.ts` is
the only surface that knows about the backend.

## Notes and sharp edges

- **`Tone.Offline` swaps the global Tone context and is not concurrency-safe.** Every render goes through a promise queue, and live notes wait for render-idle. Overlapping renders produce intermittently silent buffers — the worst possible failure inside a measurement loop. This is also why render duty avoids anyone who is currently playing: being drafted as renderer cuts your own sound off mid-phrase.
- **A synth constructed outside the `Tone.Offline` callback renders silence, silently.** If a render comes back empty, check that first.
- **Preset values are LLM-authored**, so `clampPreset()` runs before anything reaches an `AudioParam` — a `NaN` assigned to an AudioParam throws and permanently poisons the node. It now also runs before anything reaches the *database*, because a validator that rejected a hallucinated field would throw the whole transaction and wedge the session on every turn.
- **Render failures are reported to the agent** as a tool result rather than thrown, so one out-of-range preset can't wedge a session; the agent self-corrects.
- **One render spec per session.** `Tone.Offline` takes `sampleRate` explicitly, so renders are reproducible across machines — but only if everyone uses the same spec. The spec is pinned when the session starts, because `specForPrompt()` would otherwise read each contributor's local hardware rate and quietly change the FFT bin resolution underneath the diff.
- **`turnSeq` is a fencing token.** Convex actions are not transactional and are never retried, so an action that overran its lease could otherwise return late and append a `tool_use` into a conversation that had already moved on — which is exactly how you produce a dangling `tool_use` and 400 every subsequent request. Any commit whose token no longer matches is a no-op.
- **The Anthropic SDK is a type-only dependency.** It won't bundle in Convex's default runtime (it reaches for `node:fs`), and `"use node"` pins the deployment to specific Node versions, so `convex/agent.ts` calls the Messages API with `fetch`. The request shape was already spelled out explicitly, so nothing was lost.
- **Nicknames are sanitized server-side.** They're spliced into the prompt as `[name]`, which is also how the model is told to identify speakers, so an unsanitized bracket could forge one.
- The deployment is intentionally open — no auth. Anyone with the link can drive the agent, not just watch.

`PLAN.md` has the original design reasoning and build order; the Convex port
superseded its Cloudflare sections, which are marked there.

## Status

A prototype. Deliberately deferred: streaming responses, preset export, built-in
starter samples, multi-note and velocity-layer rendering, session GC, and message-log
pruning for very long sessions.
