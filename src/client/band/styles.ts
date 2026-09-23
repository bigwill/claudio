/** The band UI's stylesheet, from the approved mockup (docs/design/band-mockup.html). */
export const CSS = `
:root{
  color-scheme: dark;
  --bg:#14131a; --panel:#1d1c26; --chrome:#191821; --line:#322f40; --line2:#2a2836;
  --text:#e8e6f0; --dim:#9a95b0; --faint:#6b6680; --accent:#b9a4ff; --good:#7ee0a8;
  --warn:#ffcf6b; --bad:#ff7a8a;
  --you:#b9a4ff; --drums:#ffb86b; --bass:#6fc3ff; --keys:#ff8fc7;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 var(--sans)}
button{font:inherit;color:inherit;cursor:pointer}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (prefers-reduced-motion: reduce){ *{animation:none!important;transition:none!important} }

.app{height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr);min-width:0}
.topbar{display:flex;align-items:center;gap:14px;height:46px;padding:0 14px;background:var(--chrome);border-bottom:1px solid var(--line);white-space:nowrap;overflow-x:auto}
.brand{font-weight:650}.brand span{color:var(--accent)}
.slug{font-family:var(--mono);color:var(--faint);font-size:12px}
.chip{font-size:11px;letter-spacing:.07em;text-transform:uppercase;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.chip.soundcheck{border-color:var(--warn);color:var(--warn)}
.chip.jam{border-color:var(--good);color:var(--good)}
.tp{display:flex;align-items:center;gap:6px;color:var(--dim)}
kbd{font-family:var(--mono);font-size:11px;border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 5px;color:var(--text);background:#23212e}
.tp .play{color:var(--good)}
.ctl{display:flex;align-items:center;gap:4px;font-family:var(--mono);font-size:12px}
.ctl .box{border:1px solid var(--line);border-radius:5px;padding:1px 6px;background:#1f1d29}
.prog{display:flex;gap:2px}
.prog span{border:1px solid var(--line);border-radius:4px;padding:0 5px;color:var(--dim);font-family:var(--mono);font-size:12px}
.prog span.on{border-color:var(--accent);color:var(--text);background:#2a2440}
.pos{font-family:var(--mono);min-width:34px}
.spacer{flex:1}
.scene{font-family:var(--mono);font-size:12px;border:1px solid var(--line);border-radius:5px;padding:1px 8px;color:var(--faint);background:transparent}
.scene.saved{color:var(--text);border-color:#4a4560}
.scene[data-active="true"]{background:var(--accent);color:#17131f;border-color:var(--accent);font-weight:600}
.reacts{font-size:12px;color:var(--dim)}.reacts i{font-style:normal;color:var(--good)}.reacts.off i{color:var(--faint)}

.body{display:grid;grid-template-columns:minmax(0,1fr) 300px;min-height:0}
.main{display:flex;flex-direction:column;min-width:0;min-height:0}
.strips{flex:1;padding:12px 14px;display:flex;flex-direction:column;gap:8px;overflow-y:auto}

.strip{--c:var(--accent);display:grid;grid-template-columns:230px minmax(0,1fr);border:1px solid var(--line);border-radius:8px;background:var(--panel);position:relative}
.strip.drums{--c:var(--drums)}.strip.bass{--c:var(--bass)}.strip.keys{--c:var(--keys)}.strip.producer{--c:var(--you)}
.strip.focus{border-color:var(--c);box-shadow:0 0 0 1px var(--c)}
.strip.muted .grid,.strip.muted .live{opacity:.35}
.shead{padding:9px 10px;border-right:1px solid var(--line2);display:flex;flex-direction:column;gap:6px;min-width:0;overflow:hidden}
.nm{display:flex;align-items:center;gap:7px;min-width:0}
.num{font-family:var(--mono);font-size:11px;width:17px;height:17px;display:grid;place-items:center;border:1px solid var(--c);color:var(--c);border-radius:4px;flex:none}
.who{font-weight:600;color:var(--c)}
.snd{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;border-bottom:1px dotted var(--faint);background:none;padding:0;text-align:left;min-width:0}
.snd:disabled{border-bottom:0;cursor:default}
.ms{margin-left:auto;display:flex;gap:3px;flex:none}
.ms span{font-family:var(--mono);font-size:10px;border:1px solid var(--line);border-radius:3px;padding:0 4px;color:var(--faint)}
.ms span.on{background:var(--warn);color:#1b1608;border-color:var(--warn)}
.pill{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;font-size:11.5px;border-radius:999px;padding:1px 9px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.pill.thinking{border-color:var(--c);color:var(--text)}
.pill.staged{border-color:var(--accent);color:var(--accent)}
.pill.designing{border-color:var(--c);color:var(--text)}
.pill.live{border-color:var(--you);color:var(--you)}
.dots{display:inline-flex;gap:3px}.dots i{width:4px;height:4px;border-radius:50%;background:var(--c);animation:pulse 1.1s infinite}
.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
@keyframes pulse{0%,80%,100%{opacity:.25}40%{opacity:1}}
.rail{display:flex;align-items:center;gap:3px;flex-wrap:wrap}
.pip{font-family:var(--mono);font-size:10.5px;border:1px solid var(--line);border-radius:4px;padding:0 4px;color:var(--faint);background:transparent}
.pip.cur{background:var(--c);border-color:var(--c);color:#16141d;font-weight:600}
.pip.stg{border:1.5px dashed var(--accent);color:var(--accent)}
.rlabel{font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.gwrap{padding:8px 10px;min-width:0;display:flex;flex-direction:column;gap:6px;justify-content:center}
.grid{--lw:28px;--s:0;position:relative;display:grid;grid-template-columns:var(--lw) repeat(var(--cols),minmax(0,1fr));row-gap:2px}
.rl{font-family:var(--mono);font-size:9.5px;color:var(--faint);line-height:12px;height:12px;padding-right:4px;text-align:right}
.c{height:12px;border-left:1px solid transparent;background:#24222f}
.c.b4{border-left-color:#3a3650}.c.b16{border-left-color:#5a5478}
.c.on{background:var(--c);opacity:.72}
.c.on.acc{opacity:1;box-shadow:inset 0 0 0 1px #fff6}
.c.on.sus{opacity:.38}
.c.gh{opacity:.28}
.ph{position:absolute;top:-3px;bottom:-3px;left:calc(var(--lw) + (100% - var(--lw)) * var(--s) / var(--cols));width:calc((100% - var(--lw)) / var(--cols));background:#fff2;border-left:1.5px solid #fffc;pointer-events:none}
.app.stopped .ph{display:none}
.live{display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-height:30px}
.live .k{font-family:var(--mono);font-size:11px;border:1px solid var(--line);border-radius:4px;padding:1px 6px;color:var(--faint)}
.live .k.dn{background:var(--you);border-color:var(--you);color:#16141d}
.hint{font-size:11.5px;color:var(--faint)}

.loopbar{display:flex;align-items:center;gap:10px;padding:0 14px 8px;font-size:11.5px;color:var(--faint)}
.lb{flex:1;height:5px;background:#24222f;border-radius:3px;position:relative;overflow:hidden}
.lb i{position:absolute;inset:0 auto 0 0;background:var(--accent);opacity:.7;width:calc(var(--p) * 100%)}
.dock{border-top:1px solid var(--line);background:var(--chrome);padding:9px 14px 11px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.mode{font-size:11px;font-weight:600;letter-spacing:.08em;padding:2px 8px;border-radius:4px;background:#2b2839;color:var(--dim)}
.mode.play{color:var(--good)}.mode.chat{color:var(--accent);background:#2a2440}.mode.picker{color:var(--warn)}
.kbrow{display:flex;gap:3px}
.key{width:34px;border:1px solid var(--line);border-bottom-width:3px;border-radius:5px;background:#201e2a;display:flex;flex-direction:column;align-items:center;padding:2px 0 1px;font-family:var(--mono)}
.key b{font-size:11px}.key small{font-size:10px;color:var(--faint)}
.key.root small{color:var(--accent)}
.key.dn{background:var(--you);border-color:var(--you)}.key.dn b,.key.dn small{color:#16141d}
.dockinfo{font-size:12px;color:var(--dim)}
.dockinfo b{color:var(--text);font-weight:500}
.dock .r{margin-left:auto;font-size:12px;color:var(--faint);display:flex;gap:12px}

.chat{border-left:1px solid var(--line);background:var(--chrome);display:flex;flex-direction:column;min-height:0}
.chat .h{padding:9px 12px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);border-bottom:1px solid var(--line2)}
.rows{flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-height:0}
.msg{font-size:12.5px;line-height:1.45;overflow-wrap:anywhere}
.msg .a{font-weight:600;margin-right:4px}
.msg .to{color:var(--dim)}
.msg.system{color:var(--dim);font-size:12px}
.msg.nudge{color:var(--faint);font-size:11.5px}
.msg.reply{margin-left:14px;border-left:2px solid var(--line);padding-left:8px}
.cin{border-top:1px solid var(--line);padding:8px}
.cinrow{display:flex;gap:6px;align-items:center}
.cinrow .wav{flex:none;padding:5px 8px;border-radius:6px}
.route{font-size:11.5px;color:var(--dim);min-height:16px;padding-top:4px}
.route.design{color:var(--accent)}
.route.refuse{color:var(--bad)}
.dropchip{margin:0 8px 8px;border:1.5px dashed var(--accent);border-radius:8px;padding:10px;text-align:center;color:var(--accent);font-size:12.5px}
.strip.droptarget{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent)}
.cin input{flex:1;min-width:0;width:100%;background:#16151d;border:1px solid var(--line);border-radius:6px;color:var(--text);padding:6px 8px;font:inherit}
.cin input:focus{border-color:var(--accent);outline:none}

.modal{position:fixed;inset:0;background:#0008;display:grid;place-items:center;z-index:10}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;min-width:340px;max-width:560px;max-height:80vh;overflow:auto}
.card h3{margin:0 0 8px;font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:var(--dim)}
.pick{display:flex;justify-content:space-between;gap:12px;padding:5px 8px;border-radius:6px}
.pick.sel{background:#2a2440;outline:1px solid var(--accent)}
.pick small{color:var(--faint)}
.keymap{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:12.5px}
.toast{position:fixed;bottom:84px;left:50%;transform:translateX(-50%);background:#2a2440;border:1px solid var(--accent);border-radius:8px;padding:6px 12px;font-size:12.5px;z-index:11}
@media (max-width: 900px){ .body{grid-template-columns:minmax(0,1fr)} .chat{display:none} .strip{grid-template-columns:1fr} .shead{border-right:0;border-bottom:1px solid var(--line2)} }
`;
