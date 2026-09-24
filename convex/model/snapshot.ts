/**
 * The band snapshot (plan §5): what a musician is told about the band on every
 * turn, as plain text. Pure; the mutation that starts a turn gathers the input.
 */
import { chordName, NOTE_NAMES, type Scale } from "../../src/shared/pattern";
import type { ClaudioPreset } from "../../src/shared/preset";

export interface SnapshotInput {
  jam: { bpm: number; keyPc: number; scale: Scale; bars: number; progression: number[] };
  me: { role: string; partSummary: string; soundName: string | null; preset: ClaudioPreset | null; versionLabel: string };
  others: Array<{ role: string; summary: string; soundName: string | null; muted: boolean }>;
  producer: { soundName: string | null; octave: number | null };
  /** This musician's library: starters plus this jam's newest designs and tweaks (≤ 8). */
  library: string[];
  /** Set when your newest part is a history (or undo) copy. */
  rollback: { fromLabel: string; fromCaption: string; toLabel: string } | null;
  /** Set when your newest part is a scene copy. */
  scene: string | null;
}

export function buildSnapshot(s: SnapshotInput): string {
  const j = s.jam;
  const chords = j.progression.map((d) => chordName(j.keyPc, j.scale, d)).join(", ");
  const lines = [
    "[band snapshot]",
    `Tempo ${j.bpm} bpm · ${NOTE_NAMES[j.keyPc]} ${j.scale} · ${j.bars}-bar loop · chords one per bar: ${chords} (roots are scale degrees ${j.progression.join(", ")})`,
    ...s.others.map((o) => `${o.role}${o.muted ? " (muted)" : ""}: ${o.summary}${o.soundName ? `   (${o.soundName})` : ""}`),
    `Your part (${s.me.role}, ${s.me.versionLabel}): ${s.me.partSummary}`,
  ];
  if (s.me.soundName) lines.push(`Your sound: ${s.me.soundName}${s.me.preset ? `\n${JSON.stringify(s.me.preset)}` : ""}`);
  if (s.library.length) lines.push(`Your library: ${s.library.join(", ")}`);
  const who = s.producer.soundName ?? "their sound";
  lines.push(
    s.producer.octave === null
      ? `The producer is playing along live on ${who}; leave room.`
      : `The producer is playing along live on ${who}, around octave ${s.producer.octave} (as of their latest note); leave room.`,
  );
  if (s.rollback) {
    lines.push(
      `The producer took you back from ${s.rollback.fromLabel} (${s.rollback.fromCaption}) to ${s.rollback.toLabel}; don't re-propose it unless asked.`,
    );
  }
  if (s.scene) lines.push(`The producer recalled scene ${s.scene}; you're playing your part from that scene.`);
  return lines.join("\n");
}
