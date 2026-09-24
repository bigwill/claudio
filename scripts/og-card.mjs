/**
 * npm run og:card — renders public/og.png (1200×630), the link-preview image
 * iMessage, Slack and friends show for a shared jam link (index.html's og:image).
 * Re-run after changing the card below; commit the PNG.
 */
import { chromium } from "playwright";

// Four strips as the app draws them: name, sound, a few bars of notes, version pips.
const strips = [
  { n: 1, who: "you", snd: "Fat Square Pad", c: "#b9a4ff", notes: [[0, 2, 60], [3, 1, 40], [6, 2, 70], [10, 3, 50]], pips: 2 },
  { n: 2, who: "drums", snd: "Kit", c: "#ffb86b", notes: [0, 2, 4, 6, 8, 10, 12, 14].map((x, i) => [x, 0.6, i % 2 ? 30 : 80]), pips: 3 },
  { n: 3, who: "bass", snd: "Juno Sub Round", c: "#6fc3ff", notes: [[0, 1, 85], [1.5, 0.7, 85], [3, 1, 60], [4, 1, 70], [6, 0.7, 70], [8, 1, 85], [10, 1, 55], [12, 1, 75], [14, 0.7, 60]], pips: 4, busy: "lands in 2 beats" },
  { n: 4, who: "keys", snd: "Soft Tine EP", c: "#ff8fc7", notes: [[0, 3, 70], [0, 3, 20], [4, 3, 80], [4, 3, 30], [8, 3, 75], [8, 3, 25], [12, 3, 85], [12, 3, 35]], pips: 3, designed: true },
];
const row = (s) => `
  <div class="strip" style="--c:${s.c}">
    <div class="head"><b>${s.n}</b><span class="who">${s.who}</span><span class="snd">${s.snd}${s.designed ? ' <i>from a WAV</i>' : ""}</span></div>
    <div class="lane">${s.notes.map(([x, w, y]) => `<span style="left:${(x / 16) * 100}%;width:${(w / 16) * 100}%;bottom:${y}%"></span>`).join("")}</div>
    <div class="pips">${s.busy ? `<em>${s.busy}</em>` : ""}${Array.from({ length: s.pips }, (_, i) => `<span class="${i === s.pips - 1 ? "on" : ""}"></span>`).join("")}</div>
  </div>`;

const html = `<!doctype html><html><head><style>
  *{box-sizing:border-box} body{margin:0;width:1200px;height:630px;background:radial-gradient(ellipse at 85% 0%,#2b2250 0%,#14131a 55%);color:#e8e6f0;font-family:-apple-system,"SF Pro Display","Helvetica Neue",sans-serif;padding:56px 64px;display:flex;flex-direction:column;gap:34px;overflow:hidden}
  h1{margin:0;font-size:76px;font-weight:750;letter-spacing:-.02em;line-height:1} h1 span{color:#b9a4ff}
  p{margin:14px 0 0;font-size:30px;color:#b3aecb;line-height:1.3}
  .band{display:flex;flex-direction:column;gap:12px}
  .strip{display:grid;grid-template-columns:350px 1fr 190px;align-items:center;height:70px;border:1px solid #322f40;border-left:5px solid var(--c);border-radius:10px;background:#1d1c26cc}
  .head{display:flex;align-items:baseline;gap:12px;padding:0 18px;white-space:nowrap}
  .head b{font:600 18px ui-monospace,Menlo,monospace;color:#6b6680}.who{font-size:24px;font-weight:650;color:var(--c)}
  .snd{font-size:17px;color:#9a95b0}.snd i{font-style:normal;font-size:13px;color:#7ee0a8;border:1px solid #7ee0a855;border-radius:99px;padding:1px 7px;margin-left:4px}
  .lane{position:relative;height:50px;margin:0 8px;background:repeating-linear-gradient(90deg,#2a2836 0 1px,transparent 1px 25%)}
  .lane span{position:absolute;height:7px;border-radius:3px;background:var(--c);opacity:.9}
  .pips em{white-space:nowrap;margin-right:6px;font:normal 14px ui-monospace,Menlo,monospace;color:#ffcf6b}
  .pips{display:flex;gap:7px;justify-content:flex-end;align-items:center;padding-right:18px}.pips span{flex:none;width:11px;height:11px;border-radius:50%;border:1.5px solid #4a4560}.pips span.on{background:var(--c);border-color:var(--c)}
</style></head><body>
  <div><h1>Claudio <span>Band</span></h1><p>Jam with a band of AI musicians. Design the sounds, then play along and tell them what to change.</p></div>
  <div class="band">${strips.map(row).join("")}</div>
</body></html>`;

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
await p.setContent(html);
await p.screenshot({ path: "public/og.png" });
await b.close();
console.log("[og:card] wrote public/og.png");
