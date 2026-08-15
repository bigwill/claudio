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

/**
 * Hints are PRESCRIPTIONS, not descriptions. The ScalarDiff row already carries
 * name / target / got / delta / direction, and `priorities` carries the
 * narrative — restating the problem here would triple the tool-result size for
 * no new information.
 */
function scalarHint(name: ScalarName, t: number, g: number, dir: Direction): string {
  const up = dir === "increase";
  switch (name) {
    case "attackMs":
      return up
        ? `ampEnv.attack -> ${secs(t)} (+ modEnv.attack)`
        : `ampEnv.attack -> ${secs(t)}; 0.001-0.005 if struck`;
    case "decayMs":
      return up
        ? `ampEnv.decay -> ${secs(t)} or raise ampEnv.sustain`
        : `ampEnv.decay -> ${secs(t)}, lower ampEnv.sustain`;
    case "sustainLevel":
      return up ? `ampEnv.sustain -> ${r2(t)}` : `ampEnv.sustain -> ${r2(t)} (0 if struck)`;
    case "releaseMs":
      return `ampEnv.release -> ${secs(t)}`;
    case "durationMs":
      return up ? "lengthen ampEnv.decay + ampEnv.release" : "shorten ampEnv.release, then ampEnv.decay";
    case "f0Cents": {
      const d = r0(g - t);
      return Math.abs(d) > 600
        ? "octave out: lower modulationIndex, carrierFm.index -> 0"
        : `detune ${-d}`;
    }
    case "inharmonicityCents":
      return up
        ? "harmonicity -> non-integer (3.47/7.13), modulatorFm.ratio too"
        : "harmonicity -> nearest integer, modulatorFm.ratio integer";
    case "noiseRatio":
      return up
        ? "no operator feedback here: modulatorWave 'sawtooth', modulationIndex >15, harmonicity 7-11"
        : "modulatorWave 'sine', lower modulationIndex, integer harmonicity";
    case "oddEvenBalance":
      return up ? "harmonicity 2 (odd only), or carrierWave 'square'" : "harmonicity 1, carrierWave 'sine'";
    default:
      break;
  }

  if (name.startsWith("centroid.")) {
    const frame = name.slice("centroid.".length) as FrameLabel;
    const stage = MOD_STAGE[frame] ?? "modEnv.sustain";
    if (frame === "attack") {
      return up
        ? "raise modulationIndex, modEnv.attack -> 0.001"
        : "lower modulationIndex or lengthen modEnv.attack";
    }
    return up ? `raise ${stage}, modulationIndex` : `lower ${stage}, shorten modEnv.decay`;
  }

  if (name.startsWith("rms.")) {
    const frame = name.slice("rms.".length) as FrameLabel;
    const stage = AMP_STAGE[frame] ?? "ampEnv.sustain";
    return up ? `raise ampEnv.sustain, lengthen ${stage}` : `lower ampEnv.sustain, shorten ${stage}`;
  }

  return up ? "increase this" : "decrease this";
}

/** Coarse advice class for a harmonic miss — also the row de-dup key. */
function harmonicClass(h: number, deltaDb: number): string {
  const band = h === 1 ? "f" : h <= 4 ? "lo" : "hi";
  return `${band}${deltaDb < 0 ? "-" : "+"}`;
}

function harmonicHint(frame: FrameLabel, h: number, deltaDb: number): string {
  const stage = MOD_STAGE[frame] ?? "modEnv.sustain";
  // Terse on purpose: these ship in every tool result and the narrative already
  // lives in `priorities`.
  switch (harmonicClass(h, deltaDb)) {
    case "f-":
      return "lower modulationIndex, carrierFm.index -> 0";
    case "f+":
      return `raise modulationIndex, ${stage}`;
    case "lo-":
      return "modulationIndex -> 2-6, integer harmonicity";
    case "lo+":
      return `raise modulationIndex, ${stage}`;
    case "hi-":
      return `raise modulationIndex + modulatorFm.index, ${stage}`;
    default:
      return `lower modulationIndex, shorten ${stage}`;
  }
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
  // Eight rows all saying "raise modulationIndex" at the same frame is eight
  // times the tokens for one fact. Keep the worst row per (frame, advice class)
  // so the list spans the note instead of repeating itself.
  harmonicRows.sort((a, b) => b.w - a.w);
  const seenHarm = new Set<string>();
  const harmonics: HarmonicDiff[] = [];
  for (const row of harmonicRows) {
    if (harmonics.length >= DIFF_LIMITS.maxHarmonics) break;
    const key = `${row.frame}:${harmonicClass(row.h, row.deltaDb)}`;
    if (seenHarm.has(key)) continue;
    seenHarm.add(key);
    const { w: _w, ...clean } = row;
    harmonics.push(clean);
  }

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
    spectrum: "harmonic balance / brightness",
    envelope: "loudness shape over time",
    pitch: "pitch and harmonic stretch",
    noise: "noisiness and odd/even balance",
  };
  return `${distance}/100 — ${quality}; worst is ${where[worst]} (${breakdown[worst]}).`;
}

/** Groups advice so two hints about the same control can't both be emitted. */
function tagOf(name: ScalarName): string {
  if (name.startsWith("centroid.")) return "brightness";
  if (name.startsWith("rms.")) return "level";
  if (name === "noiseRatio" || name === "oddEvenBalance") return "grit";
  if (name === "inharmonicityCents") return "inharm";
  if (name === "f0Cents") return "pitch";
  return `env:${name}`;
}

function buildPriorities(
  distance: number,
  harmErr: number,
  upperTilt: number,
  scored: Array<{ points: number; row: ScalarDiff }>,
  target: FeatureSummary,
  candidate: FeatureSummary,
): string[] {
  const items: Array<{ points: number; tag: string; text: string }> = [];

  // The harmonic block is ONE idea, not 48 — collapse it into a single
  // instruction about where the spectral energy needs to move.
  if (harmErr > 0.06) {
    const text =
      upperTilt < -2
        ? "Brighten it: the upper harmonics are too quiet. Raise modulationIndex toward 10-20 and raise modEnv.sustain so the sidebands survive past the attack; modulatorFm.index 2-4 enriches the modulator further."
        : upperTilt > 2
          ? "Tame it: the upper harmonics are too loud. Lower modulationIndex, and shorten modEnv.decay with a low modEnv.sustain so brightness collapses after the attack instead of ringing on."
          : "Re-shape WHICH harmonics are loud rather than how many: adjust harmonicity (integer = pitched and instrument-like, non-integer = bell/metallic) before touching modulationIndex again.";
    items.push({ points: 100 * DISTANCE_WEIGHTS.spectrum * harmErr * 0.7, tag: "brightness", text });
  }

  // Inharmonicity and grit are the two things the agent most often forgets, so
  // surface them even when they aren't the largest raw error.
  if (target.inharmonicityCents - candidate.inharmonicityCents > 20) {
    items.push({
      points: 100 * DISTANCE_WEIGHTS.pitch * 0.9,
      tag: "inharm",
      text: `Target is inharmonic (${target.inharmonicityCents} cents vs your ${candidate.inharmonicityCents}) — set harmonicity to a non-integer such as 3.47 or 7.13; that is what turns a pitched tone into a bell.`,
    });
  }
  if (target.noiseRatio - candidate.noiseRatio > 0.12) {
    items.push({
      points: 100 * DISTANCE_WEIGHTS.noise * 0.9,
      tag: "grit",
      text: `Target is much grittier (noiseRatio ${target.noiseRatio} vs ${candidate.noiseRatio}) — there is no operator feedback in this engine, so use modulatorWave: 'sawtooth', modulationIndex above 15, and a high non-integer harmonicity (7-11).`,
    });
  }

  for (const s of scored.slice(0, 5)) {
    items.push({ points: s.points, tag: tagOf(s.row.name), text: s.row.hint });
  }

  items.sort((a, b) => b.points - a.points);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (out.length >= 5) break;
    if (seen.has(it.tag)) continue;
    seen.add(it.tag);
    out.push(it.text);
  }

  if (out.length === 0) {
    out.push(
      distance <= DIFF_LIMITS.goodMatch
        ? "Already a good match — from here change one field at a time (modulationIndex first, then modEnv.decay) and keep whichever lowers the distance."
        : "No single feature dominates — re-pick the archetype (struck metal / plucked string / brass / e-piano / bass / pad) and set harmonicity and modulationIndex to match it before fine-tuning.",
    );
  }
  const filler = [
    "Change one or two fields per iteration and say what you expect — a controlled experiment converges faster than a shotgun; modulationIndex is the primary brightness control.",
    "modEnv is the brightness contour, ampEnv the loudness contour: a modEnv.decay shorter than ampEnv.decay gives the struck/plucked 'bright attack that mellows out'.",
    "If a change moved a feature the wrong way, reverse it rather than compounding it — try the opposite sign on modulationIndex or harmonicity.",
  ];
  for (let i = 0; out.length < 3 && i < filler.length; i++) {
    if (!out.includes(filler[i])) out.push(filler[i]);
  }

  return out.slice(0, 5);
}
