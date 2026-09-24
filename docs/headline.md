# Claudio Band: the headline demo

> The band builds its sounds, then you build a loop together and flip between two sections.

About five minutes. The keyboard does almost everything. `?` shows every key.
Open a fresh jam: the site root makes one (`https://claudio-band.will-104.workers.dev/`, or `http://localhost:5173/` locally). Press any key once so the browser allows audio.

The same steps are the **H scenario** (`e2e/band.spec.ts`, "H: the headline"), run on the fake LLM by `npm run e2e`, and on real models by `npm run smoke:real -- --yes`.

## 1. Soundcheck: the band builds its sounds

The jam opens in **soundcheck**: nothing plays until the sounds are ready.

| Keys | What happens |
|---|---|
| `4` | Focus keys. The chat box reads `@keys `. |
| drag `electric_piano.wav` onto the chat (or **＋ WAV**) | Designing starts *first*: keys' strip shows the Opus 5.5 measure loop, with distance bars and the designer's reasoning. It takes ~30s. The chat logs "Designing keys from electric_piano.wav". |
| `2` then `A` `S` `D` `F` | While it designs: audition the kit (kick, snare, hat, open hat). |
| `3` `B` `↓` `Enter` | Pick bass from the library (e.g. Juno Sub Round). The picker shows where each sound came from. |
| `3` then the home row | Audition the bass. |
| `1` `B` `↓` `Enter` | Choose your own sound. |
| `1` then the home row | Audition it. |

When the design lands, the chat says "keys now plays …". Press `4` and audition keys on the home row.

**Fallback, if the design is still running at 60s:** click **Cancel** in keys' strip, then `4` `B` and pick **Soft Tine EP** (designed from `electric_piano_jd800_soft_ep.wav`). The library is global and shows where each sound came from, so this is honest: it's the same loop's earlier result.

## 2. `Space`: the jam starts

The starter parts play, and you play along on the home row (`Z`/`X` for octave). In the jam, the keyboard always plays your sound.

## 3. "@bass busier, eighth notes"

| Keys | What happens |
|---|---|
| `3` `Enter`, type `busier, eighth notes`, `Enter`, `Esc` | Bass's strip shows **thinking… Ns**, then **lands in N beats**. The new part lands on the next bar line while everything keeps playing, and bass's reply threads under your note. |

## 4. "@keys make it glassier", then one try too far

| Keys | What happens |
|---|---|
| `4` `Enter`, type `make it glassier`, `Enter` | Keys tweaks its sound. The new sound lands on the next bar line and appears in the library (`B` shows it as a tweak). |
| type `even glassier, really metallic`, `Enter`, `Esc` | One more try, and this one loses the thread. |
| `4` `←` | Back to the good version, on the next bar line. `→` would go forward again. |

## 5. Scenes

| Keys | What happens |
|---|---|
| `Shift` `[` | Save scene A. |
| `2` `Enter`, type `half-time, sparse`, `Enter`, `Esc`, then `3` `V` | Reshape the band: drums change and bass tries a variation. |
| `Shift` `]` | Save scene B. |
| `[` … `]` | Flip between A and B. Every part changes together on the next bar line. |

## If something goes sideways

- A musician that fails says so in the chat ("bass didn't answer in time. Still on v2.") and is free again straight away. Just send the note again.
- `←` / `→` on any strip walks its versions; `Shift` `←` / `→` jumps to the oldest or newest.
- `M` mutes the focused strip instantly.
