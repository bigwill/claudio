/**
 * DSP self-test — plain Node, no browser, no Web Audio, no Tone.
 *
 *   npm run test:dsp
 *
 * This exists because `src/client/dsp/*` is deliberately pure
 * `Float32Array in -> JSON out` (PLAN.md, "three boundaries"). The moment a diff
 * looks wrong we need to be able to interrogate the extractor against a signal
 * whose spectrum we know exactly, in one second, without a browser.
 *
 * Checks (PLAN.md "Verification"):
 *   1. 220 Hz sawtooth   -> f0Hz within 1%, harmonicsDb decaying like 1/h
 *   2. 1 kHz sine        -> one dominant harmonic, low centroidRatio
 *   3. diffFeatures(x,x) -> distance ~0        <- catches nearly every bug
 *   4. bright/noisy vs pure sine -> large distance with actionable priorities
 */

declare const process: { argv: string[]; exitCode?: number; exit(code: number): never };

// Node's type stripper resolves relative specifiers literally, so a bare
// "./features" would 404 — but writing "./features.ts" fails `tsc` without
// allowImportingTsExtensions (and tsconfig.json is not ours to edit). Rewriting
// the specifier in a resolve hook satisfies both, and keeps this hack in the
// one file that is Node-only.
// @ts-ignore - node: builtins are untyped here (no @types/node in this project)
const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier: string, context: unknown, next: (s: string, c: unknown) => unknown) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const { prepare } = await import("../src/client/dsp/prepare");
const { extractFeatures } = await import("../src/client/dsp/features");
const { diffFeatures } = await import("../src/client/dsp/diff");
type FeatureSummary = import("../src/shared/features").FeatureSummary;

const SR = 44100;

// ---------------------------------------------------------------------------
// signal synthesis (plain JS — that is the whole point)
// ---------------------------------------------------------------------------

/** Short fade in/out so the trim step has an onset to find and there are no clicks. */
function fade(x: Float32Array, sr: number, ms = 5): Float32Array {
  const n = Math.round((ms / 1000) * sr);
  for (let i = 0; i < n && i < x.length; i++) {
    const g = i / n;
    x[i] *= g;
    x[x.length - 1 - i] *= g;
  }
  return x;
}

/** Additive (alias-free) sawtooth: amplitude of harmonic h is exactly 1/h. */
function saw(f0: number, seconds: number, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const x = new Float32Array(n);
  const maxH = Math.floor((sr / 2 / f0) * 0.9);
  for (let h = 1; h <= maxH; h++) {
    const a = 1 / h;
    const w = (2 * Math.PI * h * f0) / sr;
    for (let i = 0; i < n; i++) x[i] += a * Math.sin(w * i);
  }
  return fade(x, sr);
}

function sine(f0: number, seconds: number, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const x = new Float32Array(n);
  const w = (2 * Math.PI * f0) / sr;
  for (let i = 0; i < n; i++) x[i] = Math.sin(w * i);
  return fade(x, sr);
}

/** Deterministic PRNG so a failure is always reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff - 0.5;
  };
}

/** Bright, gritty, inharmonic, percussive — the "clangy metal hit" archetype. */
function brightNoisy(f0: number, seconds: number, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const x = new Float32Array(n);
  const rand = rng(12345);
  const partials = [1, 2.41, 3.83, 5.17, 7.09, 9.31, 11.7, 14.2];
  const a = 0.9 / partials.length;
  for (const p of partials) {
    const f = f0 * p;
    if (f > sr / 2 - 500) continue;
    const w = (2 * Math.PI * f) / sr;
    for (let i = 0; i < n; i++) x[i] += a * Math.sin(w * i);
  }
  for (let i = 0; i < n; i++) {
    // Broadband hiss at a level comparable to the partials — this is the "grit"
    // the engine has to reach with sawtooth + high modulationIndex, since there
    // is no operator feedback to get it the usual way.
    x[i] += 0.8 * rand();
    // fast percussive decay
    x[i] *= Math.exp((-4 * i) / sr);
  }
  return fade(x, sr, 2);
}

// ---------------------------------------------------------------------------
// tiny assertion harness
// ---------------------------------------------------------------------------

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
function near(label: string, got: number, want: number, tol: number, unit = ""): void {
  const ok = Math.abs(got - want) <= tol;
  check(label, ok, `got ${round(got)}${unit}, want ${round(want)}${unit} +/- ${tol}${unit}`);
}
const round = (v: number) => Math.round(v * 100) / 100;

function analyze(x: Float32Array, sr = SR): FeatureSummary {
  const p = prepare(x, sr);
  return extractFeatures(p.data, p.sampleRate);
}

// ---------------------------------------------------------------------------
// 1. 220 Hz sawtooth
// ---------------------------------------------------------------------------

console.log("\n== 1. 220 Hz additive sawtooth ==");
const sawF = analyze(saw(220, 1.5));
near("saw f0Hz within 1%", sawF.f0Hz, 220, 2.2, "Hz");
check("saw f0Confidence high", sawF.f0Confidence > 0.8, `got ${sawF.f0Confidence}`);
check("saw is harmonic", sawF.inharmonicityCents <= 5, `inharmonicityCents ${sawF.inharmonicityCents}`);
check("saw noiseRatio low", sawF.noiseRatio <= 0.1, `got ${sawF.noiseRatio}`);

const sus = sawF.frames[2];
console.log(`   sustain-frame harmonicsDb: [${sus.harmonicsDb.join(", ")}]`);
near("saw h1 = 0 dB (loudest)", sus.harmonicsDb[0], 0, 0.5, "dB");
near("saw h2 ~ -6 dB", sus.harmonicsDb[1], -6, 1.5, "dB");
near("saw h3 ~ -9.5 dB", sus.harmonicsDb[2], -9.5, 1.5, "dB");
near("saw h4 ~ -12 dB", sus.harmonicsDb[3], -12, 1.5, "dB");
near("saw h8 ~ -18 dB", sus.harmonicsDb[7], -18.1, 2, "dB");
check(
  "saw harmonics decay monotonically (h1..h6)",
  sus.harmonicsDb.slice(0, 6).every((v, i, a) => i === 0 || v <= a[i - 1] + 0.5),
  `[${sus.harmonicsDb.slice(0, 6).join(", ")}]`,
);
check("saw centroidRatio > 3 (bright)", sus.centroidRatio > 3, `got ${sus.centroidRatio}`);

// ---------------------------------------------------------------------------
// 2. 1 kHz sine
// ---------------------------------------------------------------------------

console.log("\n== 2. 1 kHz sine ==");
const sinF = analyze(sine(1000, 1.5));
near("sine f0Hz within 1%", sinF.f0Hz, 1000, 10, "Hz");
const sSus = sinF.frames[2];
console.log(`   sustain-frame harmonicsDb: [${sSus.harmonicsDb.join(", ")}]`);
check("sine h1 is the loudest harmonic", sSus.harmonicsDb[0] === 0, `got ${sSus.harmonicsDb[0]}`);
check(
  "sine has exactly one dominant harmonic (h2..h12 all <= -40 dB)",
  sSus.harmonicsDb.slice(1).every((v) => v <= -40),
  `max of h2..h12 = ${Math.max(...sSus.harmonicsDb.slice(1))} dB`,
);
check("sine centroidRatio ~ 1 (dark)", sSus.centroidRatio < 1.5, `got ${sSus.centroidRatio}`);
check("sine noiseRatio low", sinF.noiseRatio <= 0.1, `got ${sinF.noiseRatio}`);

// ---------------------------------------------------------------------------
// 3. self-comparison — the 60-second test that catches nearly every bug
// ---------------------------------------------------------------------------

console.log("\n== 3. self-comparison: diffFeatures(x, x) ==");
for (const [name, f] of [
  ["saw", sawF],
  ["sine", sinF],
] as const) {
  const d = diffFeatures(f, f);
  check(`${name}: diffFeatures(x,x).distance ~ 0`, d.distance === 0, `got ${d.distance}`);
  check(`${name}: no scalars reported`, d.scalars.length === 0, `got ${d.scalars.length}`);
  check(`${name}: no harmonics reported`, d.harmonics.length === 0, `got ${d.harmonics.length}`);
  check(
    `${name}: breakdown all zero`,
    d.breakdown.spectrum === 0 && d.breakdown.envelope === 0 && d.breakdown.pitch === 0 && d.breakdown.noise === 0,
    JSON.stringify(d.breakdown),
  );
  check(`${name}: still emits >= 3 priorities`, d.priorities.length >= 3, `got ${d.priorities.length}`);
}

// A shifted copy of the same source must still land near zero — proves prepare()
// really is trimming both sides identically (the phantom-attack bug).
console.log("\n== 3b. prepare() trims a pre-rolled copy back to the same sound ==");
const base = saw(220, 1.5);
const preRolled = new Float32Array(base.length + Math.round(0.08 * SR));
preRolled.set(base, Math.round(0.08 * SR));
const preRolledF = analyze(preRolled);
const trimDiff = diffFeatures(sawF, preRolledF);
check("80ms of pre-roll does not create a phantom attack error", trimDiff.distance < 3, `distance ${trimDiff.distance}`);
near("attackMs unchanged by pre-roll", preRolledF.amp.attackMs, sawF.amp.attackMs, 8, "ms");

// Gain invariance: half-amplitude input must produce an identical summary.
console.log("\n== 3c. gain invariance ==");
const quiet = Float32Array.from(base, (v) => v * 0.05);
const quietF = analyze(quiet);
check("0.05x gain gives distance ~0", diffFeatures(sawF, quietF).distance < 1, `distance ${diffFeatures(sawF, quietF).distance}`);

// ---------------------------------------------------------------------------
// 4. loop sanity — a clangy noisy hit vs a pure sine
// ---------------------------------------------------------------------------

console.log("\n== 4. bright/noisy target vs pure-sine candidate ==");
const targetF = analyze(brightNoisy(220, 1.5));
const candF = analyze(sine(220, 1.5));
const d4 = diffFeatures(targetF, candF);
console.log(`   target: f0=${targetF.f0Hz} inharm=${targetF.inharmonicityCents} noise=${targetF.noiseRatio} centroid=${targetF.frames[2].centroidRatio}`);
console.log(`   cand:   f0=${candF.f0Hz} inharm=${candF.inharmonicityCents} noise=${candF.noiseRatio} centroid=${candF.frames[2].centroidRatio}`);
console.log(`   distance ${d4.distance}  breakdown ${JSON.stringify(d4.breakdown)}`);
console.log(`   verdict: ${d4.verdict}`);
d4.priorities.forEach((p, i) => console.log(`   ${i + 1}. ${p}`));

check("distance is large", d4.distance > 25, `got ${d4.distance}`);
check("distance stays in 0..100", d4.distance >= 0 && d4.distance <= 100, `got ${d4.distance}`);
check("3-5 priorities", d4.priorities.length >= 3 && d4.priorities.length <= 5, `got ${d4.priorities.length}`);
check("verdict is one sentence", d4.verdict.length > 20 && d4.verdict.split(". ").length <= 2, d4.verdict);
check("scalars reported and capped at 8", d4.scalars.length > 0 && d4.scalars.length <= 8, `got ${d4.scalars.length}`);
check("harmonics reported and capped at 8", d4.harmonics.length > 0 && d4.harmonics.length <= 8, `got ${d4.harmonics.length}`);
check(
  "spectrum dominates the breakdown",
  d4.breakdown.spectrum >= d4.breakdown.envelope,
  JSON.stringify(d4.breakdown),
);

const allHints = [...d4.priorities, ...d4.scalars.map((s) => s.hint), ...d4.harmonics.map((h) => h.hint)];
const PRESET_FIELDS = [
  "modulationIndex",
  "harmonicity",
  "modEnv",
  "ampEnv",
  "modulatorWave",
  "carrierWave",
  "modulatorFm",
  "carrierFm",
  "detune",
];
check(
  "every hint names a real ClaudioPreset field",
  allHints.every((h) => PRESET_FIELDS.some((f) => h.includes(f))),
  `${allHints.filter((h) => !PRESET_FIELDS.some((f) => h.includes(f))).length} hint(s) without a field`,
);
// The engine has no operator feedback, so no hint may PRESCRIBE it. Saying
// "there is no operator feedback here" is fine (and useful) — telling the agent
// to raise it is the failure mode this guards against.
const PRESCRIBES_FEEDBACK = /(raise|increase|add|more|use|apply|turn up|higher)[^.]{0,24}feedback/i;
check(
  "NO hint prescribes operator feedback (this engine has none)",
  !allHints.some((h) => PRESCRIBES_FEEDBACK.test(h)),
  allHints.find((h) => PRESCRIBES_FEEDBACK.test(h)) ?? "",
);
check(
  "the grit deficit prescribes the sawtooth/high-index substitution",
  allHints.some((h) => h.includes("sawtooth") && h.includes("modulationIndex")),
  "expected a modulatorWave: 'sawtooth' + high modulationIndex hint",
);
check(
  "the inharmonic target prescribes a non-integer harmonicity",
  allHints.some((h) => /non-integer/i.test(h) && h.includes("harmonicity")),
  "expected a non-integer harmonicity hint",
);

// Directionality: sine candidate is too dark, so the advice must be to brighten.
const centroidScalar = d4.scalars.find((s) => s.name.startsWith("centroid."));
check(
  "brightness scalar points the right way (increase)",
  !centroidScalar || centroidScalar.direction === "increase",
  centroidScalar ? `${centroidScalar.name} -> ${centroidScalar.direction}` : "no centroid scalar",
);

// ---------------------------------------------------------------------------
// 5. token budget
// ---------------------------------------------------------------------------

console.log("\n== 5. payload size ==");
const featBytes = JSON.stringify(targetF).length;
const diffBytes = JSON.stringify(d4).length;
console.log(`   FeatureSummary ${featBytes} chars (~${Math.round(featBytes / 3.6)} tokens)`);
console.log(`   FeatureDiff    ${diffBytes} chars (~${Math.round(diffBytes / 3.6)} tokens)`);
// This is a worst case: every scalar and every harmonic slot filled, because
// the candidate shares nothing with the target. Real iterations run smaller.
check("FeatureSummary stays compact (< 1200 chars)", featBytes < 1200, `${featBytes} chars`);
check("FeatureDiff stays compact (< 3300 chars)", diffBytes < 3300, `${diffBytes} chars`);

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
if (failures > 0) process.exit(1);
