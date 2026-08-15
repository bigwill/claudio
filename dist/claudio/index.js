import { t as Anthropic } from "./assets/sdk-CppPnwHd.js";
import { DurableObject } from "cloudflare:workers";
//#region src/shared/preset.ts
var WAVES = [
	"sine",
	"triangle",
	"square",
	"sawtooth"
];
var RANGE = {
	harmonicity: [.25, 12],
	modulationIndex: [0, 30],
	innerRatio: [.25, 12],
	innerIndex: [0, 12],
	envTime: [.001, 4],
	sustain: [0, 1],
	detune: [-100, 100],
	gain: [0, 1]
};
var DEFAULT_PRESET = {
	name: "Init",
	harmonicity: 1,
	modulationIndex: 4,
	carrierWave: "sine",
	modulatorWave: "sine",
	carrierFm: {
		ratio: 1,
		index: 0
	},
	modulatorFm: {
		ratio: 1,
		index: 0
	},
	ampEnv: {
		attack: .01,
		decay: .3,
		sustain: .6,
		release: .6
	},
	modEnv: {
		attack: .01,
		decay: .3,
		sustain: .4,
		release: .4
	},
	detune: 0,
	gain: .8
};
function num(v, fallback, lo, hi) {
	const n = typeof v === "number" ? v : Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(hi, Math.max(lo, n));
}
function wave(v, fallback) {
	return typeof v === "string" && WAVES.includes(v) ? v : fallback;
}
function adsr(v, d) {
	const o = v ?? {};
	const [tLo, tHi] = RANGE.envTime;
	return {
		attack: num(o.attack, d.attack, tLo, tHi),
		decay: num(o.decay, d.decay, tLo, tHi),
		sustain: num(o.sustain, d.sustain, ...RANGE.sustain),
		release: num(o.release, d.release, tLo, tHi)
	};
}
function inner(v, d) {
	const o = v ?? {};
	return {
		ratio: num(o.ratio, d.ratio, ...RANGE.innerRatio),
		index: num(o.index, d.index, ...RANGE.innerIndex)
	};
}
/** Coerce arbitrary (agent-authored) input into a preset that cannot break the audio graph. */
function clampPreset(raw) {
	const p = raw ?? {};
	const d = DEFAULT_PRESET;
	return {
		name: typeof p.name === "string" && p.name.trim() ? p.name.slice(0, 40) : d.name,
		harmonicity: num(p.harmonicity, d.harmonicity, ...RANGE.harmonicity),
		modulationIndex: num(p.modulationIndex, d.modulationIndex, ...RANGE.modulationIndex),
		carrierWave: wave(p.carrierWave, d.carrierWave),
		modulatorWave: wave(p.modulatorWave, d.modulatorWave),
		carrierFm: inner(p.carrierFm, d.carrierFm),
		modulatorFm: inner(p.modulatorFm, d.modulatorFm),
		ampEnv: adsr(p.ampEnv, d.ampEnv),
		modEnv: adsr(p.modEnv, d.modEnv),
		detune: num(p.detune, d.detune, ...RANGE.detune),
		gain: num(p.gain, d.gain, ...RANGE.gain)
	};
}
var ADSR_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"attack",
		"decay",
		"sustain",
		"release"
	],
	properties: {
		attack: {
			type: "number",
			description: "Seconds, 0.001 to 4."
		},
		decay: {
			type: "number",
			description: "Seconds, 0.001 to 4."
		},
		sustain: {
			type: "number",
			description: "Level held while the note is down, 0 to 1."
		},
		release: {
			type: "number",
			description: "Seconds after note-off, 0.001 to 4."
		}
	}
};
var INNER_FM_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["ratio", "index"],
	properties: {
		ratio: {
			type: "number",
			description: "Frequency ratio of this inner modulator, 0.25 to 12."
		},
		index: {
			type: "number",
			description: "Modulation depth, 0 to 12. 0 turns this inner operator OFF (the host becomes a plain oscillator)."
		}
	}
};
var PRESET_JSON_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"name",
		"harmonicity",
		"modulationIndex",
		"carrierWave",
		"modulatorWave",
		"carrierFm",
		"modulatorFm",
		"ampEnv",
		"modEnv",
		"detune",
		"gain"
	],
	properties: {
		name: {
			type: "string",
			description: "Short evocative patch name, e.g. 'Glassy Bell'. Max 40 chars."
		},
		harmonicity: {
			type: "number",
			description: "Modulator:carrier frequency ratio — sets sideband SPACING. Integers give harmonic, pitched, instrument-like spectra (1 = full/hollow, 2 = odd-harmonic clarinet-ish, 3 = nasal). Non-integers (1.41, 3.47, 7.13) give inharmonic bell / metallic / clangorous spectra."
		},
		modulationIndex: {
			type: "number",
			description: "Depth of the main modulator. THE primary brightness control — raising it adds sidebands, so more partials and a brighter, denser tone. 0 = pure sine, 2-6 warm, 10-20 bright, 20+ aggressive."
		},
		carrierWave: {
			type: "string",
			enum: [
				"sine",
				"triangle",
				"square",
				"sawtooth"
			],
			description: "Carrier (op1) waveform."
		},
		modulatorWave: {
			type: "string",
			enum: [
				"sine",
				"triangle",
				"square",
				"sawtooth"
			],
			description: "Modulator (op3) waveform. sawtooth/square make the modulator spectrally dense, which is how you get gritty, noisy timbres in this engine — there is NO operator feedback available."
		},
		carrierFm: {
			...INNER_FM_SCHEMA,
			description: "Inner FM on the carrier (op2 -> op1). Adds body/edge to the carrier itself."
		},
		modulatorFm: {
			...INNER_FM_SCHEMA,
			description: "Inner FM on the modulator (op4 -> op3). Enriches the modulator, adding upper partials."
		},
		ampEnv: {
			...ADSR_SCHEMA,
			description: "Carrier amplitude envelope — the LOUDNESS shape you hear."
		},
		modEnv: {
			...ADSR_SCHEMA,
			description: "Modulator amplitude envelope — this IS the BRIGHTNESS CONTOUR over time. A modEnv decay shorter than the ampEnv decay gives the classic 'bright attack that mellows out' of struck and plucked sounds."
		},
		detune: {
			type: "number",
			description: "Cents."
		},
		gain: {
			type: "number",
			description: "Output level."
		}
	}
};
//#endregion
//#region src/worker/agent.ts
/**
* The agent layer: system prompt, tool definitions, and the Anthropic call.
*
* Nothing here touches storage or HTTP — SessionDO owns the conversation, this
* module owns *what Claude sees*. See PLAN.md "Model and request shape".
*
* Request-shape rules that will 400 if broken (do not "clean these up"):
*   - no temperature / top_p / top_k on claude-opus-5
*   - no assistant-turn prefill
*   - thinking is ON BY DEFAULT and counts against max_tokens, so max_tokens is
*     sized generously (8192) even though the answer is a ~200 token tool call.
*/
var MODEL = "claude-opus-5";
/**
* Ceiling on THIS TURN'S ENTIRE OUTPUT: adaptive thinking + any prose + the
* tool_use block, all counted together. Thinking is on by default on
* claude-opus-5, so the invisible half is what sizes this, not the preset.
*
* The preset itself is tiny — a full ClaudioPreset serializes to ~330 chars
* (~100 tokens) and the rationale adds ~40. So the visible output of a turn is
* ~150 tokens; there is no version of "the preset didn't fit".
*
* Sized generously on purpose. Output is billed on tokens ACTUALLY generated,
* so a high ceiling is free unless it's used, whereas hitting the ceiling
* truncates the turn mid-thought and usually costs us the tool call entirely
* (see the max_tokens guard in session.ts). The real constraint on the upper
* end is wall-clock, not cost — the browser's request has to survive
* Cloudflare's edge timeout — and that is bounded by `effort`, which is the
* knob doing the actual latency work here.
*/
var MAX_TOKENS = 16e3;
var TOOLS = [{
	name: "propose_preset",
	description: "Your measurement instrument. Emit an FM preset; the browser renders it offline, extracts the same feature vector it extracted from the target, and hands you back a distance plus a per-feature diff. This is an experiment, not a final answer: change one or two things at a time and state what you expect them to do, so the returned diff actually tells you something. A shotgun edit of eight fields produces a diff you cannot attribute.",
	strict: true,
	input_schema: {
		type: "object",
		additionalProperties: false,
		required: ["preset", "rationale"],
		properties: {
			preset: PRESET_JSON_SCHEMA,
			rationale: {
				type: "string",
				description: "One or two sentences: which feature errors you are targeting, exactly which fields you changed, and what you expect to happen to the measurement. Name the hypothesis so the next diff can confirm or refute it."
			}
		}
	}
}, {
	name: "finalize",
	description: "Stop iterating and commit to a preset. Call this when the match is good (distance below ~12), when further changes are not improving the distance, or when iterations_remaining hits 0 — at which point you MUST finalize. Submit the BEST preset you have seen (lowest distance), not merely the most recent one.",
	strict: true,
	input_schema: {
		type: "object",
		additionalProperties: false,
		required: ["preset", "rationale"],
		properties: {
			preset: PRESET_JSON_SCHEMA,
			rationale: {
				type: "string",
				description: "One or two sentences for the user: what this patch is, and where it still differs from the sample."
			}
		}
	}
}];
var r = (range) => `${range[0]}..${range[1]}`;
var HOW_THE_LOOP_WORKS = `
You are Claudio, an FM sound designer working a closed measurement loop.

WHAT YOU ARE ACTUALLY MAKING: a preset the user is glad to have. The uploaded sample is a STARTING POINT for
exploration, not a specification to satisfy. The artifact they keep is the patch — they will play it, tweak it,
and use it in music. Judge your work by whether it is a good, playable, characterful sound, not by whether it
won an approximation contest.

"If it sounds good, it is good." That is the ethos. Take it seriously.

The loop: the user uploads a sample. The browser analyzes it into a compact FEATURE VECTOR and gives it to you.
You propose a preset with propose_preset. The browser renders it offline, extracts the IDENTICAL feature vector
from your render, and returns a distance (0-100, lower is better) plus a per-feature diff. Then you refine.

THE SAMPLES ARE USUALLY NOT FM SOUNDS. Expect analog and digital synths, drum machines, acoustic instruments,
percussion, field recordings — anything. A four-operator FM patch CANNOT exactly become a PWM analog lead, a
sampled upright bass, or a shaker, and it is not supposed to. Your job is to find the FM patch that captures
what makes that sound recognizable — its brightness, its movement, its attack, its harmonic character — and is
worth playing in its own right. A distance of 30 on a sound FM cannot natively make is a success, not a failure.

So use the distance as a COMPASS, not a SCORE. It tells you which way to walk. It does not tell you when to be
happy, and chasing the last few points of it at the cost of a musical result is the wrong trade. If the numbers
want something ugly, prefer the sound.

You are reading a FEATURE VECTOR, not listening. You will never hear anything, so treat each proposal as a
controlled experiment: change one or two things, say in the rationale what you expect them to do, and read the
next diff to see whether you were right. If a change moved a feature the WRONG way, reverse it rather than
piling another change on top.

The iteration budget is small (usually 3). Spend it: iteration 1 picks an archetype, later iterations attack the
largest weighted errors — or deliberately chase character the numbers don't capture, if that makes it better.
`.trim();
var ENGINE_FACTS = `
THE ENGINE (fixed topology, four operators, no algorithm switching):

    op4 --(modulatorFm.index)--> op3 --(modulationIndex)--+
                                 [modEnv: ADSR]           |
                                                          +--> op1 --> out
    op2 --(carrierFm.index)-----------------------------------+   [ampEnv: ADSR]

Causal facts. These are the levers; there are no others.

- modulationIndex (${r(RANGE.modulationIndex)}) is THE PRIMARY BRIGHTNESS CONTROL. Raising it grows sidebands:
  more partials, brighter and denser. 0 = pure sine carrier, 2-6 = warm, 10-20 = bright, 20+ = aggressive.
- harmonicity (${r(RANGE.harmonicity)}) sets sideband SPACING, i.e. WHICH partials exist.
  INTEGER values (1, 2, 3, 4) give harmonic, pitched, instrument-like spectra: 1 = full/hollow,
  2 = odd-harmonic hollow/clarinet-ish, 3 = nasal, 4+ = thin and bright.
  NON-INTEGER values (1.41, 3.47, 7.13) give inharmonic bell / metallic / clangorous spectra.
  If the target's inharmonicityCents is above ~30, you need a non-integer harmonicity. Below ~10, use an integer.
- modEnv IS THE BRIGHTNESS CONTOUR OVER TIME. It is the modulator's amplitude, and modulator amplitude *is*
  modulation index *is* brightness. ampEnv is LOUDNESS over time and nothing else. This is the single most
  useful correspondence in the engine: a diff entry about centroid at a time anchor maps directly onto a modEnv
  segment. A modEnv decay SHORTER than the ampEnv decay gives the classic "bright attack that mellows out"
  signature of struck and plucked sounds (bells, e-pianos, mallets, plucks). modEnv attack slower than ampEnv
  attack gives the brass/pad swell.
- THIS ENGINE HAS NO OPERATOR FEEDBACK. There is no feedback parameter and asking for one is wasted effort.
  To get gritty, dense, noisy, noise-adjacent timbres: set modulatorWave to 'sawtooth' (or 'square'), push
  modulationIndex above ~15, and use a HIGH NON-INTEGER harmonicity (7-11). That combination is the substitute
  for feedback, and it is the only one.
- carrierWave / modulatorWave: sine is the clean default. A non-sine MODULATOR multiplies the sideband count
  (sawtooth densest, then square, then triangle). A non-sine CARRIER adds its own harmonics under everything.
- carrierFm (op2 -> op1, ratio ${r(RANGE.innerRatio)}, index ${r(RANGE.innerIndex)}) adds body/edge to the carrier
  itself. modulatorFm (op4 -> op3, same ranges) enriches the modulator, pushing energy into the UPPER partials.
  index 0 turns an inner operator off. Reach for modulatorFm when high harmonics (h >= 7) are too quiet even at
  a high modulationIndex.
- Envelope times are seconds (${r(RANGE.envTime)}); sustain is a level (${r(RANGE.sustain)}).
  detune is cents (${r(RANGE.detune)}); gain is ${r(RANGE.gain)} and does NOT affect the distance — the analysis
  is gain-invariant, so never try to fix a spectral error with gain.
`.trim();
var READING_THE_DIFF = `
READING THE MEASUREMENT.

The target features and your render's features share a format:
- f0Hz / f0Confidence / f0DriftCents — pitch. Confidence below ~0.5 means unpitched/percussive: distrust every
  f0-derived number and lean on the envelope and noise fields instead.
- amp {attackMs, decayMs, sustainLevel, releaseMs} — maps 1:1 onto ampEnv (ms vs seconds: 120 ms = 0.12).
- inharmonicityCents — 0 harmonic, >30 bell/metallic. Drives integer vs non-integer harmonicity.
- noiseRatio — energy outside harmonic peaks. High means the modulatorWave/high-index/non-integer recipe above.
- oddEvenBalance — >0.7 means odd harmonics dominate (square/clarinet-like): try harmonicity 2.
- frames[4] at attack / early / sustain / release, each with rmsDb, centroidRatio (brightness in harmonic
  numbers: 1.0 = pure sine, 6.0 = very bright) and harmonicsDb[12] (dB relative to the LOUDEST harmonic IN THAT
  FRAME, so it is level-independent — never reason about absolute loudness from it).

The diff comes back with:
- priorities[] — 3-5 ordered plain-English fixes. READ THESE FIRST; they are ranked by weighted contribution.
- scalars[] — {name, target, got, delta, direction, severity, hint}. delta is got minus target, so a NEGATIVE
  delta means your render is UNDER the target. severity is that entry's share of the distance.
- harmonics[] — {frame, h, targetDb, gotDb, deltaDb, hint}. Low harmonics too loud / high harmonics too quiet
  means raise modulationIndex. The reverse means lower it.

Mapping, feature -> field:
- centroid too low at a frame            -> raise modulationIndex, or raise modEnv at that point in time
- centroid too high only at the attack   -> shorten modEnv.decay / lower modEnv.sustain
- centroid does not fall like the target  -> modEnv.decay is too long relative to ampEnv.decay
- wrong harmonics present (spacing wrong) -> change harmonicity, not modulationIndex
- inharmonicity too low                   -> move harmonicity off an integer; add modulatorFm.ratio non-integer
- noiseRatio too low                      -> modulatorWave 'sawtooth' + high index + non-integer harmonicity
- attack/decay/sustain/release wrong      -> ampEnv (and mirror the shape in modEnv if brightness tracks it)
- high harmonics (h>=7) too quiet         -> raise modulationIndex; then raise modulatorFm.index
`.trim();
var WORKING_RULES = `
WORKING RULES.

1. Your FIRST proposal picks a plausible ARCHETYPE from the target features and instantiates it — struck metal /
   plucked string / brass / e-piano / bass / mallet / pad. Do not start from a default sine. Read the target:
   fast attack + long decay + sustain near 0 + high inharmonicity = struck metal. Slow attack + high sustain +
   integer spectrum = brass or pad. Fast attack + moderate decay + low inharmonicity = e-piano or pluck.
2. Every later proposal addresses the one or two LARGEST weighted errors, specifically, and says so.
3. Reverse changes that moved a feature the wrong way. Do not compound them.
4. Stay inside the documented ranges. Out-of-range values get rejected by the renderer and cost you an iteration.
5. Some targets are simply not reachable in FM — noise percussion, sampled acoustic instruments, PWM analog
   leads. When you recognize one, stop trying to close the gap and instead make the most musical patch that
   lives in the same neighbourhood: right register, right attack, right sense of movement and brightness.
   Say plainly in the rationale which parts you captured and which are out of reach. That is a good outcome.
6. When iterations_remaining reaches 0 you MUST call finalize. Choose the preset you would most want to PLAY —
   usually the lowest distance, but not always. If an earlier attempt sounded like a more coherent instrument
   and the "better" one only won on numbers, finalize the earlier one and say why.
   You may finalize early if it is already good, or if the remaining error is the unreachable kind.
7. In chat, after the loop, the user speaks in adjectives ("brighter", "more attack bite", "less metallic").
   Translate through the causal facts above and propose a new preset — or, if they asked a question rather than
   for a change, just answer it in text. Here the target is irrelevant and the distance means nothing: they are
   exploring now, and their ear is the only judge. Follow where they lead.
8. Name every preset like a patch on a synth, not like a diff ("Glass Tine", "Rubber Bass" — not "Attempt 3").
   The name ships with the sound.
9. Keep prose short. The rationale is for the user; the reasoning is for you.
`.trim();
var SYSTEM_BLOCKS = [
	{
		type: "text",
		text: HOW_THE_LOOP_WORKS
	},
	{
		type: "text",
		text: ENGINE_FACTS
	},
	{
		type: "text",
		text: READING_THE_DIFF
	},
	{
		type: "text",
		text: WORKING_RULES,
		cache_control: { type: "ephemeral" }
	}
];
var MissingApiKeyError = class extends Error {
	constructor() {
		super("ANTHROPIC_API_KEY is not set on the Worker. Run: npx wrangler secret put ANTHROPIC_API_KEY");
		this.name = "MissingApiKeyError";
	}
};
/**
* One non-streaming turn. Throws on any failure — the caller MUST catch and
* restore session status, or a thrown call leaves the session wedged on
* "thinking" forever.
*/
async function runClaude(opts) {
	if (!opts.apiKey) throw new MissingApiKeyError();
	const client = new Anthropic({ apiKey: opts.apiKey });
	const toolChoice = opts.force ? {
		type: "any",
		disable_parallel_tool_use: true
	} : {
		type: "auto",
		disable_parallel_tool_use: true
	};
	return await client.messages.create({
		model: MODEL,
		max_tokens: MAX_TOKENS,
		thinking: { type: "adaptive" },
		output_config: { effort: opts.isFirstProposal ? "medium" : "low" },
		system: SYSTEM_BLOCKS,
		tools: TOOLS,
		tool_choice: toolChoice,
		messages: opts.messages
	});
}
//#endregion
//#region src/worker/session.ts
var freshMeta = () => ({
	status: "idle",
	target: null,
	targetInfo: null,
	iteration: 0,
	maxIterations: 3,
	history: [],
	bestPresetId: null,
	bestDistance: null,
	pendingToolUseId: null,
	pendingPresetId: null
});
/** Thrown for client mistakes (stale presetId, wrong status) — mapped to 409. */
var ProtocolError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ProtocolError";
	}
};
var SessionDO = class extends DurableObject {
	meta = freshMeta();
	messages = [];
	constructor(ctx, env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (
           id INTEGER PRIMARY KEY CHECK(id = 1),
           json TEXT NOT NULL
         );`);
			this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           json TEXT NOT NULL
         );`);
			const metaRows = [...this.ctx.storage.sql.exec(`SELECT json FROM meta WHERE id = 1`)];
			if (metaRows.length > 0) this.meta = {
				...freshMeta(),
				...JSON.parse(metaRows[0].json)
			};
			const msgRows = [...this.ctx.storage.sql.exec(`SELECT json FROM messages ORDER BY seq ASC`)];
			this.messages = msgRows.map((row) => JSON.parse(row.json));
		});
	}
	/** Liveness probe used by /api/ping so we exercise the DO binding end to end. */
	async ping() {
		return {
			ok: true,
			id: this.ctx.id.toString()
		};
	}
	saveMeta() {
		this.ctx.storage.sql.exec(`INSERT INTO meta (id, json) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json`, JSON.stringify(this.meta));
	}
	appendMessage(message) {
		this.messages.push(message);
		this.ctx.storage.sql.exec(`INSERT INTO messages (json) VALUES (?)`, JSON.stringify(message));
	}
	async snapshot() {
		return {
			sessionId: this.ctx.id.toString(),
			status: this.meta.status,
			target: this.meta.target,
			targetInfo: this.meta.targetInfo,
			iteration: this.meta.iteration,
			maxIterations: this.meta.maxIterations,
			history: this.meta.history,
			bestPresetId: this.meta.bestPresetId
		};
	}
	async setTarget(features, info) {
		this.meta = {
			...freshMeta(),
			status: "thinking",
			target: features,
			targetInfo: info
		};
		this.messages = [];
		this.ctx.storage.sql.exec(`DELETE FROM messages`);
		this.saveMeta();
		this.appendMessage({
			role: "user",
			content: [{
				type: "text",
				text: `The user uploaded "${info.filename}" (${info.durationSec.toFixed(2)}s @ ${info.sampleRate} Hz).\nHere is its feature vector:\n\n\`\`\`json
` + JSON.stringify(features) + `
\`\`\`

You have ${this.meta.maxIterations} render iterations. Pick an archetype that explains these features and instantiate it, then call propose_preset. The browser will render it and return a diff.`
			}]
		});
		return await this.turn({
			force: true,
			isFirstProposal: true
		});
	}
	async submitAnalysis(presetId, features, diff) {
		const toolUseId = this.requirePending(presetId);
		const attempt = this.meta.history.find((a) => a.presetId === presetId);
		if (attempt) {
			attempt.features = features;
			attempt.distance = diff.distance;
		}
		if (this.meta.bestDistance === null || diff.distance < this.meta.bestDistance) {
			this.meta.bestDistance = diff.distance;
			this.meta.bestPresetId = presetId;
		}
		this.meta.pendingToolUseId = null;
		this.meta.pendingPresetId = null;
		this.meta.status = "thinking";
		this.saveMeta();
		const remaining = this.iterationsRemaining();
		this.appendMessage({
			role: "user",
			content: [{
				type: "tool_result",
				tool_use_id: toolUseId,
				content: JSON.stringify({
					distance: diff.distance,
					breakdown: diff.breakdown,
					verdict: diff.verdict,
					priorities: diff.priorities,
					scalars: diff.scalars,
					harmonics: diff.harmonics,
					iteration: this.meta.iteration,
					iterations_remaining: remaining,
					best_distance_so_far: this.meta.bestDistance,
					note: remaining <= 0 ? "Iteration budget exhausted. You MUST call finalize now, with the BEST preset seen (lowest distance so far), not necessarily this one." : `Either propose the next preset with propose_preset (attack the largest weighted errors in priorities[], one or two changes, and say what you expect), or call finalize if this is good enough. You MUST call finalize when iterations_remaining reaches 0.`
				})
			}]
		});
		return await this.turn({
			force: true,
			isFirstProposal: false
		});
	}
	async submitRenderError(presetId, message) {
		const toolUseId = this.requirePending(presetId);
		this.meta.pendingToolUseId = null;
		this.meta.pendingPresetId = null;
		this.meta.status = "thinking";
		this.saveMeta();
		this.appendMessage({
			role: "user",
			content: [{
				type: "tool_result",
				tool_use_id: toolUseId,
				is_error: true,
				content: JSON.stringify({
					error: message.slice(0, 500),
					iterations_remaining: this.iterationsRemaining(),
					note: "That preset failed to render — a value was probably out of range or otherwise invalid. Fix it and propose a corrected preset. This did not consume the render, but do not repeat the same mistake."
				})
			}]
		});
		return await this.turn({
			force: true,
			isFirstProposal: false
		});
	}
	async chat(message) {
		if (this.meta.status === "thinking") throw new ProtocolError("A turn is already in flight for this session.");
		if (this.meta.status === "awaiting_render") throw new ProtocolError("Still waiting on a render; submit the analysis (or a render error) first.");
		this.meta.status = "thinking";
		this.saveMeta();
		this.appendMessage({
			role: "user",
			content: [{
				type: "text",
				text: message
			}]
		});
		return await this.turn({
			force: false,
			isFirstProposal: false
		});
	}
	requirePending(presetId) {
		if (this.meta.status !== "awaiting_render" || !this.meta.pendingToolUseId) throw new ProtocolError(`Session is "${this.meta.status}", not awaiting a render — nothing to submit.`);
		if (presetId !== this.meta.pendingPresetId) throw new ProtocolError(`Stale preset: expected "${this.meta.pendingPresetId}", got "${presetId}". Ignoring.`);
		return this.meta.pendingToolUseId;
	}
	iterationsRemaining() {
		return Math.max(0, this.meta.maxIterations - this.meta.iteration);
	}
	lastPreset() {
		return this.meta.history.length > 0 ? this.meta.history[this.meta.history.length - 1].preset : null;
	}
	async turn(opts) {
		let message;
		try {
			message = await runClaude({
				apiKey: this.env.ANTHROPIC_API_KEY,
				messages: this.messages,
				force: opts.force,
				isFirstProposal: opts.isFirstProposal
			});
		} catch (err) {
			this.meta.status = this.meta.pendingToolUseId ? "awaiting_render" : "idle";
			this.saveMeta();
			return {
				kind: "error",
				message: err instanceof MissingApiKeyError ? err.message : `Claude call failed: ${String(err)}`,
				retryable: true
			};
		}
		this.appendMessage({
			role: "assistant",
			content: message.content
		});
		let text = "";
		let call = null;
		for (const block of message.content) if (block.type === "text") text += (text ? "\n\n" : "") + block.text;
		else if (block.type === "tool_use" && !call) call = {
			id: block.id,
			name: block.name,
			input: block.input
		};
		if (message.stop_reason === "max_tokens" && !call) {
			this.meta.status = "idle";
			this.saveMeta();
			return {
				kind: "error",
				message: "The agent hit its output limit before finishing a preset. Retry, or lower the effort level if this keeps happening.",
				retryable: true
			};
		}
		if (call && call.name === "propose_preset") {
			const { preset, rationale } = readToolInput(call.input);
			const presetId = crypto.randomUUID();
			this.meta.iteration += 1;
			this.meta.pendingToolUseId = call.id;
			this.meta.pendingPresetId = presetId;
			this.meta.status = "awaiting_render";
			this.meta.history.push({
				presetId,
				preset,
				rationale,
				features: null,
				distance: null
			});
			this.saveMeta();
			return {
				kind: "render",
				presetId,
				preset,
				rationale,
				iteration: this.meta.iteration,
				iterationsRemaining: this.iterationsRemaining(),
				note: text
			};
		}
		if (call && call.name === "finalize") {
			const { preset, rationale } = readToolInput(call.input);
			const presetId = crypto.randomUUID();
			this.meta.pendingToolUseId = null;
			this.meta.pendingPresetId = null;
			this.meta.status = "done";
			this.meta.history.push({
				presetId,
				preset,
				rationale,
				features: null,
				distance: null
			});
			this.saveMeta();
			return {
				kind: "done",
				text: text ? `${text}\n\n${rationale}` : rationale,
				preset,
				presetId,
				distance: this.meta.bestDistance
			};
		}
		this.meta.status = "idle";
		this.saveMeta();
		return {
			kind: "message",
			text: text || "(no response)",
			preset: this.lastPreset(),
			iteration: this.meta.iteration
		};
	}
};
/** Tool input is agent-authored JSON — clamp it before it can reach an AudioParam. */
function readToolInput(input) {
	const obj = input ?? {};
	return {
		preset: clampPreset(obj.preset),
		rationale: typeof obj.rationale === "string" ? obj.rationale : ""
	};
}
//#endregion
//#region src/worker/index.ts
var json = (body, status = 200) => new Response(JSON.stringify(body), {
	status,
	headers: { "content-type": "application/json" }
});
var errorStep = (message, retryable = false) => ({
	kind: "error",
	message,
	retryable
});
async function readJson(request) {
	try {
		return await request.json();
	} catch {
		throw new Error("Body must be valid JSON.");
	}
}
//#endregion
//#region \0virtual:cloudflare/worker-entry
var worker_entry_default = { async fetch(request, env, _ctx) {
	const url = new URL(request.url);
	if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
	if (url.pathname === "/api/ping") return json({
		ok: true,
		durableObject: await env.SESSION.getByName("ping").ping(),
		hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY)
	});
	if (url.pathname === "/api/session") {
		if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
		return json({ sessionId: crypto.randomUUID() });
	}
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts[0] === "api" && parts[1] === "session" && parts[2]) {
		const sessionId = parts[2];
		const action = parts[3];
		const session = env.SESSION.getByName(sessionId);
		try {
			if (!action) {
				if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
				return json(await session.snapshot());
			}
			if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
			switch (action) {
				case "target": {
					const body = await readJson(request);
					if (!body?.features || !body?.info) return json(errorStep("Missing features or info."), 400);
					return json(await session.setTarget(body.features, body.info));
				}
				case "analysis": {
					const body = await readJson(request);
					if (!body?.presetId || !body?.features || !body?.diff) return json(errorStep("Missing presetId, features or diff."), 400);
					return json(await session.submitAnalysis(body.presetId, body.features, body.diff));
				}
				case "render-error": {
					const body = await readJson(request);
					if (!body?.presetId) return json(errorStep("Missing presetId."), 400);
					return json(await session.submitRenderError(body.presetId, String(body.message ?? "")));
				}
				case "chat": {
					const body = await readJson(request);
					if (!body?.message?.trim()) return json(errorStep("Missing message."), 400);
					return json(await session.chat(body.message));
				}
				default: return json({
					error: "not found",
					path: url.pathname
				}, 404);
			}
		} catch (err) {
			return json(errorStep(err instanceof Error ? err.message : String(err)), 409);
		}
	}
	return json({
		error: "not found",
		path: url.pathname
	}, 404);
} };
//#endregion
export { SessionDO, worker_entry_default as default };
