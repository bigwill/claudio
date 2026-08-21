/**
 * Builds presentation/player.html: a self-contained A/B page for the clips in
 * presentation/audio, with the audio inlined as data URIs.
 *
 * WAV would be ~8.4 MB of base64; AAC is ~0.9 MB, which matters because the
 * page has to survive being handed around as a single file. afconvert ships
 * with macOS, so there is no encoder dependency to install.
 *
 *   node scripts/build-player.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const AUDIO = join(REPO, 'presentation', 'audio');
const presets = JSON.parse(readFileSync(join(AUDIO, 'presets.json'), 'utf8'));

const M4A = mkdtempSync(join(tmpdir(), 'claudio-player-'));
process.on('exit', () => rmSync(M4A, { recursive: true, force: true }));
for (const j of presets) {
  for (const v of ['dry', 'produced']) {
    execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '128000',
      join(AUDIO, `${j.cat}-${v}.wav`), join(M4A, `${j.cat}-${v}.m4a`)]);
  }
}

const b64 = (f) => readFileSync(join(M4A, f)).toString('base64');
const src = (f) => `data:audio/mp4;base64,${b64(f)}`;

const LABEL = { bell: 'Bell', bass: 'Bass', lead: 'Lead', pad: 'Pad' };
const DOT = ' &middot; ';
const CHAIN = {
  bell: ['reverb .55', 'delay .30'].join(DOT),
  bass: ['reverb .07', 'drive .18'].join(DOT),
  lead: ['reverb .26', 'delay .32', 'drive .10'].join(DOT),
  pad: ['reverb .70', 'delay .14'].join(DOT),
};

// Numeric entities for everything non-ASCII: this page carries no charset
// declaration of its own, so a raw UTF-8 byte would mojibake.
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\u0080-\uFFFF]/g, (c) => '&#' + c.charCodeAt(0) + ';');

const strips = presets.map((j, i) => {
  const p = j.preset;
  const params = [
    ['harmonicity', p.harmonicity],
    ['index', p.modulationIndex],
    ['carrier', p.carrierWave],
    ['modulator', p.modulatorWave],
    ['amp env  a/d/s/r', [p.ampEnv.attack, p.ampEnv.decay, p.ampEnv.sustain, p.ampEnv.release].join(' / '), 1],
    ['mod env  a/d/s/r', [p.modEnv.attack, p.modEnv.decay, p.modEnv.sustain, p.modEnv.release].join(' / '), 1],
  ].map(([k, v, wide]) => `<div class="pv${wide ? ' wide' : ''}"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

  return `
  <section class="strip" data-ch="${i}">
    <div class="ident">
      <p class="eyebrow"><span class="num">${String(i + 1).padStart(2, '0')}</span>${LABEL[j.cat]}</p>
      <h2>${esc(p.name)}</h2>
      <p class="prompt">&ldquo;${esc(j.prompt)}&rdquo;</p>
      <p class="say">${esc(j.rationale)}</p>
    </div>

    <div class="deck">
      <div class="transport">
        <button class="play" type="button" aria-label="Play ${esc(p.name)}">
          <span class="glyph" aria-hidden="true"></span><span class="ptxt">Play</span>
        </button>
        <div class="meter" role="group" aria-label="Playback position">
          <div class="track">
            <div class="beyond"></div>
            <div class="cut" title="the dry clip stops here"></div>
            <div class="head"></div>
          </div>
          <div class="times"><span class="t">0:00</span><span class="tailnote">tail only in produced</span><span class="d">0:00</span></div>
        </div>
      </div>

      <div class="ab">
        <div class="switch" role="radiogroup" aria-label="Monitor source">
          <button type="button" class="opt on" data-src="dry" role="radio" aria-checked="true">
            <span class="led" aria-hidden="true"></span>Dry
          </button>
          <button type="button" class="opt" data-src="produced" role="radio" aria-checked="false">
            <span class="led" aria-hidden="true"></span>Produced
          </button>
        </div>
        <p class="chain">${CHAIN[j.cat]}</p>
      </div>
    </div>

    <dl class="params">${params}</dl>

    <audio class="a-dry" preload="metadata" src="${src(`${j.cat}-dry.m4a`)}"></audio>
    <audio class="a-wet" preload="metadata" src="${src(`${j.cat}-produced.m4a`)}"></audio>
  </section>`;
}).join('\n');

const html = `<title>Dry / Produced</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  /* Equipment grey-green — the faceplate lineage of a monitor controller,
     not a document. Light theme is a painted panel, dark is graphite. */
  :root {
    --ground: #DFE2DE;
    --panel: #EFF1ED;
    --sunk: #D3D7D2;
    --line: #C2C7C1;
    --ink: #1C201D;
    --dim: #646C66;
    --faint: #8A918B;
    --dry: #4E6570;
    --wet: #C56F1E;
    --wet-soft: rgba(197, 111, 30, .13);
    --dry-soft: rgba(78, 101, 112, .12);

    --sans: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    --cond: "IBM Plex Sans Condensed", "IBM Plex Sans", ui-sans-serif, sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #16191A; --panel: #1E2224; --sunk: #101314; --line: #2E3436;
      --ink: #E6E9E7; --dim: #929B96; --faint: #6C7671;
      --dry: #8FA8B3; --wet: #E4954A;
      --wet-soft: rgba(228, 149, 74, .15); --dry-soft: rgba(143, 168, 179, .14);
    }
  }
  :root[data-theme="dark"] {
    --ground: #16191A; --panel: #1E2224; --sunk: #101314; --line: #2E3436;
    --ink: #E6E9E7; --dim: #929B96; --faint: #6C7671;
    --dry: #8FA8B3; --wet: #E4954A;
    --wet-soft: rgba(228, 149, 74, .15); --dry-soft: rgba(143, 168, 179, .14);
  }

  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--ground); color: var(--ink);
    font-family: var(--sans); font-size: 16px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: clamp(28px, 5vw, 64px) clamp(18px, 4vw, 40px) 72px; }

  header { display: flex; flex-direction: column; gap: 14px; margin-bottom: clamp(28px, 4vw, 48px); }
  h1 {
    font-family: var(--cond); font-weight: 700; letter-spacing: -.015em;
    font-size: clamp(30px, 5vw, 52px); line-height: 1.02; margin: 0; text-wrap: balance;
  }
  h1 em { font-style: normal; color: var(--wet); }
  .lede { margin: 0; color: var(--dim); max-width: 62ch; font-size: clamp(15px, 1.5vw, 18px); }
  .keys {
    font-family: var(--mono); font-size: 12px; color: var(--faint);
    display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 4px 0 0;
  }
  .keys kbd {
    font: inherit; color: var(--ink); background: var(--panel);
    border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px;
  }

  /* --- channel strip ---------------------------------------------------- */
  .strips { display: flex; flex-direction: column; gap: 18px; }
  .strip {
    display: grid; gap: clamp(16px, 2.4vw, 30px);
    grid-template-columns: minmax(0, 1fr) minmax(320px, 400px);
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 4px; padding: clamp(18px, 2.4vw, 26px);
  }
  .strip.playing { border-color: var(--wet); }
  @media (max-width: 820px) { .strip { grid-template-columns: minmax(0, 1fr); } }

  .eyebrow {
    font-family: var(--mono); font-size: 11px; letter-spacing: .16em;
    text-transform: uppercase; color: var(--dim); margin: 0 0 6px;
    display: flex; align-items: baseline; gap: 10px;
  }
  .eyebrow .num { color: var(--faint); }
  .ident h2 {
    font-family: var(--cond); font-weight: 600; font-size: clamp(23px, 2.6vw, 32px);
    letter-spacing: -.01em; margin: 0; line-height: 1.05;
  }
  .prompt { margin: 8px 0 0; font-family: var(--mono); font-size: 13px; color: var(--wet); }
  .say { margin: 12px 0 0; font-size: 14.5px; color: var(--dim); max-width: 58ch; }

  .deck { display: flex; flex-direction: column; gap: 16px; justify-content: center; }

  .transport { display: flex; align-items: center; gap: 14px; }
  .play {
    flex: none; width: 84px; height: 40px; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    font-family: var(--mono); font-size: 12px; letter-spacing: .1em; text-transform: uppercase;
    color: var(--ink); background: var(--sunk);
    border: 1px solid var(--line); border-radius: 3px;
  }
  .play:hover { border-color: var(--wet); }
  .play .glyph {
    width: 0; height: 0; border-left: 9px solid currentColor;
    border-top: 6px solid transparent; border-bottom: 6px solid transparent;
  }
  .strip.playing .play .glyph {
    border: 0; width: 9px; height: 11px; background: currentColor;
    box-shadow: inset 3px 0 0 var(--sunk), inset -3px 0 0 var(--sunk);
  }

  .meter { flex: 1; min-width: 0; }
  .track {
    position: relative; height: 8px; background: var(--sunk);
    border: 1px solid var(--line); border-radius: 2px; overflow: hidden;
  }
  /* the region that exists only because the produced version has a tail */
  .beyond { position: absolute; inset: 0 0 0 auto; width: 0; background: var(--wet-soft); }
  .cut { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--faint); left: 100%; }
  .head { position: absolute; top: 0; bottom: 0; left: 0; width: 0; background: var(--dry); }
  .strip[data-src="produced"] .head { background: var(--wet); }
  .times {
    display: flex; justify-content: space-between; align-items: baseline; gap: 10px;
    font-family: var(--mono); font-size: 11px; color: var(--faint);
    margin-top: 6px; font-variant-numeric: tabular-nums;
  }
  .tailnote { color: var(--wet); opacity: 0; transition: opacity .18s; }
  .strip.in-tail .tailnote { opacity: 1; }

  /* --- the A/B switch --------------------------------------------------- */
  .ab { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .switch {
    display: grid; grid-template-columns: 1fr 1fr; flex: 1; min-width: 240px;
    background: var(--sunk); border: 1px solid var(--line); border-radius: 3px; padding: 3px; gap: 3px;
  }
  .opt {
    display: inline-flex; align-items: center; justify-content: center; gap: 9px;
    padding: 9px 10px; cursor: pointer; border: 0; border-radius: 2px; background: transparent;
    font-family: var(--mono); font-size: 12px; letter-spacing: .1em; text-transform: uppercase;
    color: var(--faint);
  }
  .opt .led {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--line); box-shadow: none;
  }
  .opt[data-src="dry"].on { color: var(--ink); background: var(--dry-soft); }
  .opt[data-src="dry"].on .led { background: var(--dry); box-shadow: 0 0 7px var(--dry); }
  .opt[data-src="produced"].on { color: var(--ink); background: var(--wet-soft); }
  .opt[data-src="produced"].on .led { background: var(--wet); box-shadow: 0 0 8px var(--wet); }
  .chain { margin: 0; font-family: var(--mono); font-size: 11px; color: var(--faint); }

  /* --- parameters ------------------------------------------------------- */
  .params {
    grid-column: 1 / -1; margin: 2px 0 0; padding-top: 16px; border-top: 1px solid var(--line);
    display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px 20px;
  }
  .pv.wide { grid-column: span 2; }
  @media (max-width: 700px) {
    .params { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .pv.wide { grid-column: span 2; }
  }
  .pv { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .pv dt {
    font-family: var(--mono); font-size: 10.5px; letter-spacing: .12em;
    text-transform: uppercase; color: var(--faint);
  }
  .pv dd {
    margin: 0; font-family: var(--mono); font-size: 13px; color: var(--ink);
    font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
  }

  footer {
    margin-top: 40px; padding-top: 22px; border-top: 1px solid var(--line);
    color: var(--dim); font-size: 14px; max-width: 68ch;
  }
  footer p { margin: 0 0 10px; }
  footer b { color: var(--ink); font-weight: 600; }
  footer code { font-family: var(--mono); font-size: .9em; color: var(--wet); }

  :focus-visible { outline: 2px solid var(--wet); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>

<div class="wrap">
  <header>
    <h1>The same patch, before and after it&rsquo;s <em>placed in a mix</em>.</h1>
    <p class="lede">Four presets Claudio wrote, each playing the same phrase twice. Both takes run in
      sync &mdash; the switch changes which one reaches you, so you can flip mid-note and hear only
      what production did. A bare patch gets judged against a lifetime of finished records and loses;
      that&rsquo;s the comparison talking, not the sound.</p>
    <p class="keys">
      <span><kbd>Space</kbd> play / pause</span>
      <span><kbd>S</kbd> swap dry &harr; produced</span>
      <span><kbd>1</kbd>&ndash;<kbd>4</kbd> jump to a channel</span>
    </p>
  </header>

  <div class="strips">
${strips}
  </div>

  <footer>
    <p>Every preset here is real output. Each came from a live session against the deployed Worker,
      driven through the app&rsquo;s own client loop &mdash; the same STFT the agent always sees &mdash;
      until it called <code>finalize</code>. <b>Acid Fang</b> reached for the grit recipe on its own:
      sawtooth carrier, square modulator, index 14.</p>
    <p>Sends are highpassed before the tank &mdash; 320&nbsp;Hz into the reverb, 420&nbsp;Hz into the
      delay &mdash; so low fundamentals stay tight instead of smearing, which is why the bass barely
      moves between takes and the bell moves a lot. The shaded end of each timeline is tail that exists
      only in the produced version.</p>
  </footer>
</div>

<script>
(function () {
  var strips = [].slice.call(document.querySelectorAll('.strip'));
  var current = null;

  function fmt(t) {
    if (!isFinite(t)) return '0:00';
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  strips.forEach(function (strip) {
    var dry = strip.querySelector('.a-dry');
    var wet = strip.querySelector('.a-wet');
    var playBtn = strip.querySelector('.play');
    var ptxt = strip.querySelector('.ptxt');
    var head = strip.querySelector('.head');
    var beyond = strip.querySelector('.beyond');
    var cut = strip.querySelector('.cut');
    var tEl = strip.querySelector('.t');
    var dEl = strip.querySelector('.d');
    var opts = [].slice.call(strip.querySelectorAll('.opt'));
    var src = 'dry';

    strip.setAttribute('data-src', src);
    dry.muted = false; wet.muted = true;

    function layout() {
      var wd = wet.duration, dd = dry.duration;
      if (!isFinite(wd) || !wd) return;
      dEl.textContent = fmt(wd);
      if (isFinite(dd) && dd < wd) {
        var pct = (dd / wd) * 100;
        cut.style.left = pct + '%';
        beyond.style.width = (100 - pct) + '%';
      }
    }
    dry.addEventListener('loadedmetadata', layout);
    wet.addEventListener('loadedmetadata', layout);
    layout();

    function setSrc(next) {
      // The two elements drift by tens of milliseconds over a few seconds.
      // Nudge the one about to become audible onto the other's position, so
      // flipping mid-note lands on the same instant instead of skipping.
      var from = src === 'dry' ? dry : wet, to = next === 'dry' ? dry : wet;
      if (next !== src && !from.paused && Math.abs(from.currentTime - to.currentTime) > 0.02) {
        try { to.currentTime = from.currentTime; } catch (err) {}
      }
      src = next;
      strip.setAttribute('data-src', src);
      dry.muted = src !== 'dry';
      wet.muted = src !== 'produced';
      opts.forEach(function (o) {
        var on = o.getAttribute('data-src') === src;
        o.classList.toggle('on', on);
        o.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }
    opts.forEach(function (o) {
      o.addEventListener('click', function () { setSrc(o.getAttribute('data-src')); });
    });

    function stop() {
      dry.pause(); wet.pause();
      strip.classList.remove('playing', 'in-tail');
      ptxt.textContent = 'Play';
      if (current === api) current = null;
    }
    function start() {
      strips.forEach(function (s) { if (s !== strip && s.__api) s.__api.stop(); });
      // Both takes run from the same instant; the switch only decides which is heard.
      dry.currentTime = 0; wet.currentTime = 0;
      var a = dry.play(), b = wet.play();
      if (a && a.catch) a.catch(function () {});
      if (b && b.catch) b.catch(function () {});
      strip.classList.add('playing');
      ptxt.textContent = 'Stop';
      current = api;
    }
    function toggle() { strip.classList.contains('playing') ? stop() : start(); }

    playBtn.addEventListener('click', toggle);

    wet.addEventListener('timeupdate', function () {
      var wd = wet.duration;
      if (!isFinite(wd) || !wd) return;
      head.style.width = (wet.currentTime / wd) * 100 + '%';
      tEl.textContent = fmt(wet.currentTime);
      var dd = dry.duration;
      strip.classList.toggle('in-tail', isFinite(dd) && wet.currentTime > dd);
    });
    wet.addEventListener('ended', function () {
      head.style.width = '0%'; tEl.textContent = '0:00';
      stop();
    });

    var api = { stop: stop, toggle: toggle, swap: function () { setSrc(src === 'dry' ? 'produced' : 'dry'); }, strip: strip };
    strip.__api = api;
  });

  document.addEventListener('keydown', function (e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    var k = e.key.toLowerCase();
    if (k === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      (current || strips[0].__api).toggle();
    } else if (k === 's') {
      e.preventDefault();
      (current || strips[0].__api).swap();
    } else if (k >= '1' && k <= String(strips.length)) {
      e.preventDefault();
      var api = strips[+k - 1].__api;
      api.strip.scrollIntoView({ behavior: 'smooth', block: 'center' });
      api.toggle();
    }
  });
})();
</script>
`;

writeFileSync(join(REPO, 'presentation', 'player.html'), html);
console.log('wrote presentation/player.html', (Buffer.byteLength(html) / 1e6).toFixed(2), 'MB');
