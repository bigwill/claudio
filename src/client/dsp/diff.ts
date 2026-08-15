/**
 * diffFeatures — the thing that actually makes the loop converge.
 *
 * The scalar `distance` exists for the progress bar and the stop condition. The
 * DIFF is the payload, and its design rule (PLAN.md) is absolute:
 *
 *   every entry names a DIRECTION to move AND a real ClaudioPreset field
 *   that would move it.
 *
 * A number with no attached action is wasted tokens.
 *
 * CRITICAL ENGINE FACT baked into this table: there is NO operator feedback in
 * this engine (Tone doesn't have it). A hint must never say "raise feedback".
 * The substitution for grit/noise is:
 *     modulatorWave: 'sawtooth'  +  modulationIndex > 15  +  non-integer harmonicity 7-11
 * This must stay in sync with src/shared/preset.ts and the system prompt.
 */

import {
  DIFF_LIMITS,
  DISTANCE_WEIGHTS,
  FRAME_LABELS,
  N_HARMONICS,
  type Direction,
  type FeatureDiff,
  type FeatureSummary,
  type FrameLabel,
  type HarmonicDiff,
  type ScalarDiff,
  type ScalarName,
} from "../../shared/features";

// ---------------------------------------------------------------------------
// numeric helpers
// ---------------------------------------------------------------------------

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);
const r2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
const r0 = (v: number) => (Number.isFinite(v) ? Math.round(v) : 0);

/** Saturating absolute error. */
const absErr = (t: number, g: number, full: number) => clamp01(Math.abs(g - t) / full);

/**
 * Saturating ratio error, in octaves. Times spanning 1 ms to 4000 ms are only
 * comparable on a log axis: 20 ms vs 40 ms is the same perceptual miss as
 * 1000 ms vs 2000 ms, and a linear ms error would drown the former entirely.
 */
const ratioErr = (t: number, g: number, octaves = 3) =>
  clamp01(Math.abs(Math.log2((Math.max(0, g) + 1) / (Math.max(0, t) + 1))) / octaves);

const cents = (t: number, g: number) => (t > 0 && g > 0 ? 1200 * Math.log2(g / t) : 0);

/** Seconds, formatted for pasting straight into a preset field. */
const secs = (ms: number) => `${Math.max(0.001, ms / 1000).toFixed(3)}s`;

// ---------------------------------------------------------------------------
// The hint table. ~1 line in, 1 actionable sentence out.
// ---------------------------------------------------------------------------

/** Which modEnv stage owns the brightness at each time anchor. */
const MOD_STAGE: Record<FrameLabel, string> = {
  attack: "modEnv.attack",
  early: "modEnv.decay",
  sustain: "modEnv.sustain",
  release: "modEnv.release",
};

const AMP_STAGE: Record<FrameLabel, string> = {
  attack: "ampEnv.attack",
  early: "ampEnv.decay",
  sustain: "ampEnv.sustain",
  release: "ampEnv.release",
};

const GRIT_RECIPE =
  "this engine has NO operator feedback, so density comes from modulatorWave: 'sawtooth', " +
  "modulationIndex above 15, and a high non-integer harmonicity (7-11)";

function scalarHint(name: ScalarName, t: number, g: number, dir: Direction): string {
  const up = dir === "increase";
  switch (name) {
    case "attackMs":
      return up
        ? `Attack is too fast (${r0(g)}ms vs ${r0(t)}ms) — lengthen ampEnv.attack to ~${secs(t)} and raise modEnv.attack with it so the brightness swells in rather than snapping.`
        : `Attack is too slow (${r0(g)}ms vs ${r0(t)}ms) — shorten ampEnv.attack to ~${secs(t)}; for a struck or plucked target go to 0.001-0.005 and set modEnv.attack to 0.001.`;
    case "decayMs":
      return up
        ? `The body dies away too quickly (${r0(g)}ms vs ${r0(t)}ms) — lengthen ampEnv.decay toward ${secs(t)} and/or raise ampEnv.sustain.`
        : `The body hangs on too long (${r0(g)}ms vs ${r0(t)}ms) — shorten ampEnv.decay toward ${secs(t)} and lower ampEnv.sustain.`;
    case "sustainLevel":
      return up
        ? `Not enough sustain (${r2(g)} vs ${r2(t)}) — raise ampEnv.sustain toward ${r2(t)}.`
        : `Too much sustain (${r2(g)} vs ${r2(t)}) — lower ampEnv.sustain toward ${r2(t)}; use 0 for a struck or plucked target.`;
    case "releaseMs":
      return up
        ? `The tail is too short (${r0(g)}ms vs ${r0(t)}ms) — lengthen ampEnv.release toward ${secs(t)}.`
        : `The tail rings on too long (${r0(g)}ms vs ${r0(t)}ms) — shorten ampEnv.release toward ${secs(t)}.`;
    case "durationMs":
      return up
        ? `The note ends earlier than the target — lengthen ampEnv.decay and ampEnv.release.`
        : `The note outlasts the target — shorten ampEnv.release, then ampEnv.decay.`;
    case "f0Cents": {
      const d = r0(g - t);
      if (Math.abs(d) > 600) {
        return `Pitch reads ${d} cents out (about an octave) — the true fundamental is being swamped by sidebands, so lower modulationIndex and pull carrierFm.index toward 0 until op1's own fundamental is the loudest partial.`;
      }
      return up
        ? `Pitch is ${Math.abs(d)} cents flat — raise detune by about ${Math.abs(d)}.`
        : `Pitch is ${Math.abs(d)} cents sharp — lower detune by about ${Math.abs(d)}.`;
    }
    case "inharmonicityCents":
      return up
        ? `Target is inharmonic (${r0(t)} cents of stretch) and yours is clean — set harmonicity to a NON-integer (3.47, 5.63, 7.13) and make modulatorFm.ratio non-integer too.`
        : `Yours is more clangorous than the target (${r0(g)} vs ${r0(t)} cents) — snap harmonicity to the nearest integer (1, 2 or 3) and set modulatorFm.ratio to an integer.`;
    case "noiseRatio":
      return up
        ? `Target has more broadband grit (${r2(t)} vs ${r2(g)}) — ${GRIT_RECIPE}; raising modulatorFm.index thickens the modulator further.`
        : `Yours is noisier than the target (${r2(g)} vs ${r2(t)}) — set modulatorWave: 'sine', lower modulationIndex, use an INTEGER harmonicity, and pull modulatorFm.index toward 0.`;
    case "oddEvenBalance":
      return up
        ? `Target leans on odd harmonics (${r2(t)} vs ${r2(g)}) — use harmonicity: 2, which places sidebands on odd partials only (clarinet/square-like), or set carrierWave: 'square'.`
        : `Target has a fuller harmonic series (${r2(t)} vs ${r2(g)}) — use harmonicity: 1 and keep carrierWave: 'sine'.`;
    default:
      break;
  }

  if (name.startsWith("centroid.")) {
    const frame = name.slice("centroid.".length) as FrameLabel;
    const stage = MOD_STAGE[frame] ?? "modEnv.sustain";
    if (up) {
      if (frame === "attack") {
        return `The ${frame} is ${r1(t - g)} harmonics too dark — raise modulationIndex and set modEnv.attack to ~0.001 so the modulator is at full level the instant the note starts.`;
      }
      return `Brightness at the ${frame} is ${r1(t - g)} harmonics too low — raise ${stage}${frame === "early" ? " (your modulator is collapsing too fast)" : ""}, and raise modulationIndex if it is still short.`;
    }
    if (frame === "attack") {
      return `The ${frame} is ${r1(g - t)} harmonics too bright — lower modulationIndex, or lengthen modEnv.attack so the modulator ramps in.`;
    }
    return `Brightness at the ${frame} is ${r1(g - t)} harmonics too high — shorten modEnv.decay and lower ${stage} so the tone dulls the way the target does.`;
  }

  if (name.startsWith("rms.")) {
    const frame = name.slice("rms.".length) as FrameLabel;
    const stage = AMP_STAGE[frame] ?? "ampEnv.sustain";
    return up
      ? `Level at the ${frame} is ${r0(t - g)} dB below the target — raise ampEnv.sustain and lengthen ${stage}.`
      : `Level at the ${frame} is ${r0(g - t)} dB above the target — lower ampEnv.sustain and shorten ${stage}.`;
  }

  return up ? "Increase this." : "Decrease this.";
}

function harmonicHint(frame: FrameLabel, h: number, deltaDb: number): string {
  const stage = MOD_STAGE[frame] ?? "modEnv.sustain";
  const tooQuiet = deltaDb < 0;
  const mag = Math.abs(r0(deltaDb));

  // Kept short on purpose: up to 8 of these ship per diff, and the actionable
  // summary already lives in `priorities`.
  if (h === 1) {
    return tooQuiet
      ? `${mag} dB down: fundamental swamped — lower modulationIndex, carrierFm.index toward 0.`
      : `${mag} dB over: too little sideband energy — raise modulationIndex and ${stage}.`;
  }
  if (h <= 4) {
    return tooQuiet
      ? `${mag} dB down: spectrum too hollow — lower modulationIndex toward 2-6, integer harmonicity.`
      : `${mag} dB over: low partials dominate — raise modulationIndex and ${stage}.`;
  }
  return tooQuiet
    ? `${mag} dB down: extend sidebands — raise modulationIndex and modulatorFm.index, raise ${stage}.`
    : `${mag} dB over: lower modulationIndex, reduce ${stage} or shorten modEnv.decay.`;
}

// ---------------------------------------------------------------------------
// distance
// ---------------------------------------------------------------------------

interface Term {
  name: ScalarName;
  target: number;
  got: number;
  unit: ScalarDiff["unit"];
  weight: number;
  err: number;
}

function componentScore(terms: Term[]): number {
  let num = 0;
  let den = 0;
  for (const t of terms) {
    num += t.weight * t.err;
    den += t.weight;
  }
  return den > 0 ? clamp01(num / den) : 0;
}

/** Perceptual weight for a harmonic: loud partials matter, -60 dB ones don't. */
const loudWeight = (db: number) => 10 ** (Math.max(db, -60) / 40);

function frameOf(s: FeatureSummary, i: number) {
  return (
    s.frames[i] ?? {
      label: FRAME_LABELS[i],
      tMs: 0,
      rmsDb: -60,
      centroidRatio: 1,
      harmonicsDb: new Array<number>(N_HARMONICS).fill(-60),
    }
  );
}

export function diffFeatures(target: FeatureSummary, candidate: FeatureSummary): FeatureDiff {
  // --- spectrum: weighted harmonic mismatch + brightness trajectory ---------
  let hNum = 0;
  let hDen = 0;
  const harmonicRows: Array<HarmonicDiff & { w: number }> = [];
  let upperTilt = 0; // >0 => candidate's upper partials are too loud
  let upperTiltW = 0;

  for (let f = 0; f < FRAME_LABELS.length; f++) {
    const tf = frameOf(target, f);
    const gf = frameOf(candidate, f);
    const wf = loudWeight(Math.max(tf.rmsDb, gf.rmsDb));
    for (let h = 1; h <= N_HARMONICS; h++) {
      const tdb = tf.harmonicsDb[h - 1] ?? -60;
      const gdb = gf.harmonicsDb[h - 1] ?? -60;
      const w = wf * loudWeight(Math.max(tdb, gdb));
      const d = gdb - tdb;
      hNum += w * clamp01(Math.abs(d) / 24);
      hDen += w;
      if (h >= 5) {
        upperTilt += w * d;
        upperTiltW += w;
      }
      if (Math.abs(d) >= DIFF_LIMITS.minHarmonicDeltaDb) {
        harmonicRows.push({
          frame: FRAME_LABELS[f],
          h,
          targetDb: r0(tdb),
          gotDb: r0(gdb),
          deltaDb: r0(d),
          hint: harmonicHint(FRAME_LABELS[f], h, d),
          w: w * Math.abs(d),
        });
      }
    }
  }
  const harmErr = hDen > 0 ? clamp01(hNum / hDen) : 0;
  if (upperTiltW > 0) upperTilt /= upperTiltW;

  const centroidTerms: Term[] = FRAME_LABELS.map((label, i) => {
    const t = frameOf(target, i).centroidRatio;
    const g = frameOf(candidate, i).centroidRatio;
    return {
      name: `centroid.${label}` as ScalarName,
      target: t,
      got: g,
      unit: "x" as const,
      weight: 0.75,
      err: absErr(t, g, 4),
    };
  });

  // Harmonics carry 70% of the spectral score, the brightness trajectory 30%.
  const HARM_WEIGHT = 7;
  const centroidWeightSum = centroidTerms.reduce((a, t) => a + t.weight, 0);
  const spectrumDen = HARM_WEIGHT + centroidWeightSum;
  const spectrum = clamp01(
    (HARM_WEIGHT * harmErr + centroidTerms.reduce((a, t) => a + t.weight * t.err, 0)) / spectrumDen,
  );

  // --- envelope -------------------------------------------------------------
  const rmsTerms: Term[] = (["early", "sustain", "release"] as const).map((label) => {
    const i = FRAME_LABELS.indexOf(label);
    const t = frameOf(target, i).rmsDb;
    const g = frameOf(candidate, i).rmsDb;
    return {
      name: `rms.${label}` as ScalarName,
      target: t,
      got: g,
      unit: "dB" as const,
      weight: 0.35,
      err: absErr(t, g, 12),
    };
  });

  const envelopeTerms: Term[] = [
    {
      name: "attackMs",
      target: target.amp.attackMs,
      got: candidate.amp.attackMs,
      unit: "ms",
      weight: 1.4,
      err: ratioErr(target.amp.attackMs, candidate.amp.attackMs),
    },
    {
      name: "decayMs",
      target: target.amp.decayMs,
      got: candidate.amp.decayMs,
      unit: "ms",
      weight: 1.2,
      err: ratioErr(target.amp.decayMs, candidate.amp.decayMs),
    },
    {
      name: "sustainLevel",
      target: target.amp.sustainLevel,
      got: candidate.amp.sustainLevel,
      unit: "ratio",
      weight: 1.1,
      err: absErr(target.amp.sustainLevel, candidate.amp.sustainLevel, 1),
    },
    {
      name: "releaseMs",
      target: target.amp.releaseMs,
      got: candidate.amp.releaseMs,
      unit: "ms",
      weight: 0.9,
      err: ratioErr(target.amp.releaseMs, candidate.amp.releaseMs),
    },
    {
      name: "durationMs",
      target: target.durationMs,
      got: candidate.durationMs,
      unit: "ms",
      weight: 0.4,
      err: ratioErr(target.durationMs, candidate.durationMs),
    },
    ...rmsTerms,
  ];
  const envelope = componentScore(envelopeTerms);

  // --- pitch (low weight: we render at the target's f0 anyway — this is only
  //     here to catch a wrong-octave carrier) ---------------------------------
  const f0Delta = cents(target.f0Hz, candidate.f0Hz);
  const pitchTerms: Term[] = [
    {
      name: "f0Cents",
      target: 0,
      got: f0Delta,
      unit: "cents",
      weight: 1,
      err: clamp01(Math.abs(f0Delta) / 1200),
    },
    {
      name: "inharmonicityCents",
      target: target.inharmonicityCents,
      got: candidate.inharmonicityCents,
      unit: "cents",
      weight: 1,
      err: absErr(target.inharmonicityCents, candidate.inharmonicityCents, 60),
    },
  ];
  const pitch = componentScore(pitchTerms);

  // --- noise ----------------------------------------------------------------
  const noiseTerms: Term[] = [
    {
      name: "noiseRatio",
      target: target.noiseRatio,
      got: candidate.noiseRatio,
      unit: "ratio",
      weight: 1.5,
      err: absErr(target.noiseRatio, candidate.noiseRatio, 0.4),
    },
    {
      name: "oddEvenBalance",
      target: target.oddEvenBalance,
      got: candidate.oddEvenBalance,
      unit: "ratio",
      weight: 1,
      err: absErr(target.oddEvenBalance, candidate.oddEvenBalance, 0.5),
    },
  ];
  const noise = componentScore(noiseTerms);

  const breakdown = {
    spectrum: r1(100 * DISTANCE_WEIGHTS.spectrum * spectrum),
    envelope: r1(100 * DISTANCE_WEIGHTS.envelope * envelope),
    pitch: r1(100 * DISTANCE_WEIGHTS.pitch * pitch),
    noise: r1(100 * DISTANCE_WEIGHTS.noise * noise),
  };
  const distance = r1(breakdown.spectrum + breakdown.envelope + breakdown.pitch + breakdown.noise);

  // --- scalars --------------------------------------------------------------
  // severity = this term's own contribution to `distance`, expressed as a
  // fraction of DIFF_LIMITS.goodMatch (so 1.0 means "this single number is a
  // whole good-match's worth of error on its own").
  const groups: Array<{ terms: Term[]; weight: number; emit: boolean }> = [
    { terms: centroidTerms, weight: DISTANCE_WEIGHTS.spectrum, emit: true },
    { terms: envelopeTerms, weight: DISTANCE_WEIGHTS.envelope, emit: true },
    { terms: pitchTerms, weight: DISTANCE_WEIGHTS.pitch, emit: true },
    { terms: noiseTerms, weight: DISTANCE_WEIGHTS.noise, emit: true },
  ];
  const groupDen: number[] = [
    spectrumDen,
    envelopeTerms.reduce((a, t) => a + t.weight, 0),
    pitchTerms.reduce((a, t) => a + t.weight, 0),
    noiseTerms.reduce((a, t) => a + t.weight, 0),
  ];

  const scored: Array<{ points: number; row: ScalarDiff }> = [];
  groups.forEach((group, gi) => {
    for (const t of group.terms) {
      const points = (100 * group.weight * t.weight * t.err) / (groupDen[gi] || 1);
      const delta = t.got - t.target;
      const direction: Direction = delta < 0 ? "increase" : "decrease";
      const severity = clamp01(points / DIFF_LIMITS.goodMatch);
      if (severity < DIFF_LIMITS.minScalarSeverity) continue;
      scored.push({
        points,
        row: {
          name: t.name,
          target: r2(t.target),
          got: r2(t.got),
          delta: r2(delta),
          unit: t.unit,
          direction,
          severity: r2(severity),
          hint: scalarHint(t.name, t.target, t.got, direction),
        },
      });
    }
  });
  scored.sort((a, b) => b.points - a.points);
  const scalars = scored.slice(0, DIFF_LIMITS.maxScalars).map((s) => s.row);

  // --- harmonics ------------------------------------------------------------
  harmonicRows.sort((a, b) => b.w - a.w);
  const harmonics: HarmonicDiff[] = harmonicRows
    .slice(0, DIFF_LIMITS.maxHarmonics)
    .map(({ w: _w, ...row }) => row);

  // --- priorities: ordered, actionable prose. The agent reads this first. ----
  const priorities = buildPriorities(distance, harmErr, upperTilt, scored, target, candidate);
  const verdict = buildVerdict(distance, breakdown);

  return { distance, breakdown, verdict, priorities, scalars, harmonics };
}

function biggestComponent(b: FeatureDiff["breakdown"]): "spectrum" | "envelope" | "pitch" | "noise" {
  let best: "spectrum" | "envelope" | "pitch" | "noise" = "spectrum";
  let v = -1;
  for (const k of ["spectrum", "envelope", "pitch", "noise"] as const) {
    if (b[k] > v) {
      v = b[k];
      best = k;
    }
  }
  return best;
}

function buildVerdict(distance: number, breakdown: FeatureDiff["breakdown"]): string {
  const worst = biggestComponent(breakdown);
  const quality =
    distance <= DIFF_LIMITS.goodMatch
      ? "a good match"
      : distance < 25
        ? "the right family but audibly off"
        : distance < 45
          ? "recognisably a different instrument"
          : "not the same sound yet";
  const where: Record<string, string> = {
    spectrum: "the harmonic balance and brightness contour",
    envelope: "the loudness shape over time",
    pitch: "pitch and harmonic stretch",
    noise: "noisiness and odd/even harmonic balance",
  };
  return `Distance ${distance}/100 — ${quality}; most of the remaining error is in ${where[worst]} (${breakdown[worst]} of ${distance}).`;
}

function buildPriorities(
  distance: number,
  harmErr: number,
  upperTilt: number,
  scored: Array<{ points: number; row: ScalarDiff }>,
  target: FeatureSummary,
  candidate: FeatureSummary,
): string[] {
  const items: Array<{ points: number; text: string }> = [];

  // The harmonic block is one idea, not 48 — collapse it into a single
  // instruction about where the spectral energy needs to move.
  const harmPoints = 100 * DISTANCE_WEIGHTS.spectrum * harmErr * 0.7;
  if (harmErr > 0.06) {
    if (upperTilt < -2) {
      items.push({
        points: harmPoints,
        text:
          "Brighten the tone: the upper harmonics are too quiet across the note. Raise modulationIndex " +
          "toward 10-20 and raise modEnv.sustain so the sidebands survive past the attack. If that still " +
          "isn't enough, raise modulatorFm.index to 2-4 to enrich the modulator itself.",
      });
    } else if (upperTilt > 2) {
      items.push({
        points: harmPoints,
        text:
          "Tame the tone: the upper harmonics are too loud. Lower modulationIndex, and shorten modEnv.decay " +
          "with a low modEnv.sustain so the brightness collapses shortly after the attack instead of ringing on.",
      });
    } else {
      items.push({
        points: harmPoints,
        text:
          "Re-shape which harmonics are loud rather than how many: adjust harmonicity (integer for a pitched, " +
          "instrument-like series; non-integer for bell/metallic) before touching modulationIndex again.",
      });
    }
  }

  // Inharmonicity and grit are the two things the agent most often forgets, so
  // surface them even when they are not the largest raw error.
  if (target.inharmonicityCents - candidate.inharmonicityCents > 20) {
    items.push({
      points: 100 * DISTANCE_WEIGHTS.pitch * 0.9,
      text: `The target is inharmonic (${target.inharmonicityCents} cents of stretch, yours is ${candidate.inharmonicityCents}) — switch harmonicity to a non-integer such as 3.47 or 7.13, which is what turns a pitched tone into a bell.`,
    });
  }
  if (target.noiseRatio - candidate.noiseRatio > 0.12) {
    items.push({
      points: 100 * DISTANCE_WEIGHTS.noise * 0.9,
      text: `The target is much grittier (noiseRatio ${target.noiseRatio} vs ${candidate.noiseRatio}) — remember there is no operator feedback here: set modulatorWave: 'sawtooth', push modulationIndex above 15, and use a high non-integer harmonicity around 7-11.`,
    });
  }

  for (const s of scored.slice(0, 4)) items.push({ points: s.points, text: s.row.hint });

  items.sort((a, b) => b.points - a.points);

  // De-duplicate near-identical advice, keep 3-5.
  const out: string[] = [];
  for (const it of items) {
    if (out.length >= 5) break;
    if (out.some((o) => o.slice(0, 28) === it.text.slice(0, 28))) continue;
    out.push(it.text);
  }

  if (out.length === 0) {
    out.push(
      distance <= DIFF_LIMITS.goodMatch
        ? "This is already a good match — change one field at a time from here (modulationIndex first, then modEnv.decay) and keep whichever lowers the distance."
        : "No single feature dominates — re-pick the archetype (struck metal / plucked string / brass / e-piano / bass / pad) and set harmonicity and modulationIndex to match it before fine-tuning.",
    );
  }
  while (out.length < 3) {
    const filler = [
      "Change only one or two fields per iteration and state what you expect to happen — a controlled experiment converges faster than a shotgun.",
      "Remember modEnv is the brightness contour and ampEnv is the loudness contour; a modEnv.decay shorter than ampEnv.decay gives the classic struck/plucked 'bright attack that mellows out'.",
      "If a change moved a feature the wrong way, reverse it rather than compounding it.",
    ];
    const next = filler[out.length % filler.length];
    if (out.includes(next)) break;
    out.push(next);
  }

  return out.slice(0, 5);
}
