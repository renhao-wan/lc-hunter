/*
 * 同一套 UI 在深色 / 浅色两套主题下各截一遍。
 * 自定义弹层的背景用的是 --bg-panel + 高亮用 --bg-elev，
 * 这个组合必须两套主题下都成立（深色里"高亮比底色亮一档"，
 * 浅色里也得是高亮更浅/更亮，而不是反过来变暗）。
 * 用法: node test/_shot-uitheme.js dark|light
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const THEME = process.argv[2] === 'light' ? 'light' : 'dark';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9381 + (THEME === 'light' ? 1 : 0);
const profile = path.join(os.tmpdir(), `lc-shots-${THEME}-` + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

for (let i = 0; i < 40; i++) {
  await sleep(250);
  try {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    if (j.webSocketDebuggerUrl) break;
  } catch {}
}
const target = await (
  await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })
).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) => {
  const id = ++msgId;
  return new Promise((res) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
};
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 2, mobile: false });

async function ready() {
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if ((await evaluate('document.readyState')) === 'complete') break;
  }
  await sleep(1800);
}
async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) {
    fs.writeFileSync(name, Buffer.from(s.result.data, 'base64'));
    console.log('  已保存', name);
  }
}
async function shotClip(name, sel, pad = 12) {
  const r = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    })()
  `);
  if (!r) {
    console.log('  跳过', sel);
    return;
  }
  const s = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2, scale: 3 },
  });
  if (s.result?.data) {
    fs.writeFileSync(name, Buffer.from(s.result.data, 'base64'));
    console.log('  已保存', name);
  }
}

// 先设主题再进页面，避免闪一下
await ready();
await evaluate(`localStorage.setItem('lc-theme', ${JSON.stringify(THEME)}); localStorage.setItem('lc-collapse-list','0'); localStorage.setItem('lc-collapse-desc','0'); localStorage.removeItem('lc-code-lock'); localStorage.removeItem('lc-collapse-code'); true;`);
await send('Page.navigate', { url: BASE });
await ready();

console.log(`主题 = ${THEME}，实际 = ${await evaluate(`document.documentElement.dataset.theme`)}`);

// 打开计划下拉
await evaluate(`document.querySelector('#planSel').parentElement.querySelector('.dd-trigger').click()`);
await sleep(600);
await shot(`test/_theme-${THEME}-dd-open.png`);
await shotClip(`test/_theme-${THEME}-dd-close.png`, '.dd-pop:not([hidden])', 10);

// 量一下弹层与高亮的实际色值，确认两套主题下都是"高亮更亮/更浅"
const colors = await evaluate(`
  (() => {
    const pop = document.querySelector('.dd-pop:not([hidden])');
    const item = pop.querySelector('.dd-item:not(.on)');
    const on = pop.querySelector('.dd-item.on');
    const cs = (el) => getComputedStyle(el).backgroundColor;
    const lum = (c) => {
      const m = c.match(/\\d+/g);
      if (!m) return null;
      const [r,g,b] = m.map(Number);
      return +(0.2126*r + 0.7152*g + 0.0722*b).toFixed(1);
    };
    return {
      theme: document.documentElement.dataset.theme,
      popBg: cs(pop), itemBg: cs(item), itemLum: lum(cs(item)),
      onColor: getComputedStyle(on).color,
    };
  })()
`);
console.log('  弹层配色:', JSON.stringify(colors));
await evaluate(`document.body.click()`);
await sleep(300);

await shot(`test/_theme-${THEME}-full.png`);
await shotClip(`test/_theme-${THEME}-head-code.png`, '#codePanel .panel-head');
await shotClip(`test/_theme-${THEME}-actionbar.png`, '.actionbar');

chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}
