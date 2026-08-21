# Presentation audio — the ingredient, and the ingredient in a mix

Eight clips for the video. Four presets, each rendered twice: **dry** (what the
preset actually is) and **produced** (the same phrase through a production
chain). Same notes both times, so the A/B isolates production, not performance.

The point they make: a bare patch gets judged against a reference class of
finished records and loses, however good it is. "Flat" is a property of the
comparison, not of the sound. Play the pair back to back and the dry version
stops sounding like a failure and starts sounding like an ingredient.

| clip | preset | prompt it came from |
|---|---|---|
| `bell-dry` / `bell-produced` | **Glass Tine Bell** | *"a glassy bell, bright and ringing"* |
| `bass-dry` / `bass-produced` | **Rubber Thumb Bass** | *"a dark rubbery bass with a short percussive thump"* |
| `lead-dry` / `lead-produced` | **Acid Fang** | *"an acid lead with grit and bite"* |
| `pad-dry` / `pad-produced` | **Glacier Swell** | *"a slow glacial pad that swells in"* |

## These are real output, not reconstructions

Every preset here came from a live session against the deployed Worker, driven
through the actual client loop — `measurePreset()` from `src/client/audio`, the
same STFT the agent always sees — until the agent called `finalize`. Full
parameters and the agent's own rationale for each are in `presets.json`,
alongside the session id.

Worth knowing for the narration: **`Acid Fang` independently reached for the
grit recipe** the system prompt teaches — sawtooth carrier, square modulator,
`modulationIndex 14` — and described it as *"a fast modEnv blip that mimics a
resonant filter snapping shut on every note."* And prompted with the same
sentence as during the build, the agent again produced a patch named
**Rubber Thumb Bass**.

## The production chain

Per-register, because one setting does not fit a bell and a sub.

| | reverb send | delay send | drive |
|---|---|---|---|
| bell | 0.55 | 0.30 | — |
| bass | 0.07 | — | 0.18 |
| lead | 0.26 | 0.32 | 0.10 |
| pad | 0.70 | 0.14 | — |

Reverb is Freeverb (`roomSize 0.9`), delay is a dotted eighth at 100 BPM
(0.45 s). Both are **highpassed before the tank** — 320 Hz into the reverb,
420 Hz into the delay — so low fundamentals stay dry and tight instead of
smearing. Everything then runs 9 dB into a limiter: a bell's attack transient
sits ~16 dB above its own tail, so peak-normalising a raw render leaves the
tail inaudible. Driving a limiter is what actually makes something read as
produced — the crest factor comes down and the tail comes up.

Clips are trimmed to their own decay with a 180 ms fade, then normalised.

## Verified, and what isn't

Measured on the delivered files: the reverb send contributes ~2.7× the dry
level on the bell (RMS 0.48 vs 0.18 rendered in isolation), correlation between
dry and produced runs 0.05–0.2 so the produced version is genuinely different
signal rather than a gain change, and produced clips run 0.8–3.1 s longer than
their dry counterparts.

**Nobody has listened to these.** That check is yours. If the produced versions
want to be denser, `MAKEUP_DB` is the single number — it is currently a
deliberately safe 9 dB, because over-limiting blind would be worse than
under-doing it.

## Regenerating

The presets are cached in `presets.json`, so re-rendering costs no API calls —
the harness reuses them and only re-renders audio. The rig is a headless
Chromium page that imports the app's own modules, since `Tone.Offline` needs
Web Audio and Node has none.
