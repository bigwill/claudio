/**
 * Run the real feature extractor over the WAVs in samples/ and print what the
 * agent would actually see. This is the "does the analysis mean anything on
 * real audio" check that the synthetic self-test can't give us.
 *
 *   npm run analyze
 *   npm run analyze -- chime            # substring filter
 *   npm run analyze -- --json chime     # full FeatureSummary JSON
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

// Node's type stripper resolves relative specifiers literally, so "./features"
// would 404, while writing "./features.ts" fails tsc. Rewriting in a resolve
// hook satisfies both — same trick as scripts/dsp-selftest.ts.
const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const { prepare } = await import("../src/client/dsp/prepare");
const { extractFeatures } = await import("../src/client/dsp/features");
const { diffFeatures } = await import("../src/client/dsp/diff");
const { decodeWavFile } = await import("./wav");

const SAMPLES = join(process.cwd(), "samples");

const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const filter = args.find((a) => !a.startsWith("--"));

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function lpad(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

const files = readdirSync(SAMPLES)
  .filter((f) => f.toLowerCase().endsWith(".wav"))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(`No WAVs matched in ${SAMPLES}`);
  process.exit(1);
}

console.log(
  `\n${pad("sample", 34)} ${lpad("f0", 8)} ${lpad("conf", 5)} ${lpad("drift", 6)} ` +
    `${lpad("dur", 6)} ${lpad("atk", 6)} ${lpad("sus", 5)} ${lpad("inharm", 7)} ` +
    `${lpad("noise", 6)} ${lpad("odd", 5)}  centroid trajectory`,
);
console.log("-".repeat(132));

const summaries: { name: string; features: ReturnType<typeof extractFeatures> }[] = [];

for (const file of files) {
  try {
    const wav = decodeWavFile(join(SAMPLES, file));
    // prepare() expects an AudioBuffer-like; give it one.
    const prepared = prepare({
      numberOfChannels: wav.channels.length,
      length: wav.channels[0].length,
      sampleRate: wav.sampleRate,
      getChannelData: (i: number) => wav.channels[i],
    });
    const features = extractFeatures(prepared.data, prepared.sampleRate);
    summaries.push({ name: file, features });

    if (wantJson) {
      console.log(`\n=== ${file} ===`);
      console.log(JSON.stringify(features, null, 2));
      continue;
    }

    const traj = features.frames.map((f) => f.centroidRatio.toFixed(1)).join(" → ");
    console.log(
      `${pad(file.replace(/\.wav$/, ""), 34)} ` +
        `${lpad(features.f0Hz.toFixed(1), 8)} ` +
        `${lpad(features.f0Confidence.toFixed(2), 5)} ` +
        `${lpad(String(features.f0DriftCents), 6)} ` +
        `${lpad(String(features.durationMs), 6)} ` +
        `${lpad(String(features.amp.attackMs), 6)} ` +
        `${lpad(features.amp.sustainLevel.toFixed(2), 5)} ` +
        `${lpad(String(features.inharmonicityCents), 7)} ` +
        `${lpad(features.noiseRatio.toFixed(2), 6)} ` +
        `${lpad(features.oddEvenBalance.toFixed(2), 5)}  ${traj}`,
    );
  } catch (err) {
    console.log(`${pad(file, 34)} ERROR: ${String(err)}`);
  }
}

if (!wantJson && summaries.length > 1) {
  // Sanity: distinct sounds must be far apart, and each sample must be zero
  // distance from itself. If everything looks similar, the extractor is mush.
  console.log("\nCross-distances (should be large between unlike sounds, 0 on the diagonal):");
  const pick = summaries.slice(0, Math.min(6, summaries.length));
  const head = pick.map((s) => lpad(s.name.slice(0, 9), 10)).join("");
  console.log(`${pad("", 26)}${head}`);
  for (const a of pick) {
    const row = pick
      .map((b) => lpad(diffFeatures(a.features, b.features).distance.toFixed(1), 10))
      .join("");
    console.log(`${pad(a.name.replace(/\.wav$/, "").slice(0, 25), 26)}${row}`);
  }

  const selfMax = Math.max(
    ...summaries.map((s) => diffFeatures(s.features, s.features).distance),
  );
  console.log(
    `\nmax self-distance: ${selfMax.toFixed(6)} ${selfMax < 1e-6 ? "PASS" : "FAIL — extractor is not self-consistent"}`,
  );
  if (!(selfMax < 1e-6)) process.exit(1);
}
