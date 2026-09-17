/*
 * 给本轮两处改动截图：
 *   1. 筛「做过的」——两数之和（本地 AC 14 次）现在能被筛出来
 *   2. 折叠后的展开把手撑满整行，和题目区等高
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9343;
const profile = path.join(os.tmpdir(), 'lc-shots-r9-' + Date.now());
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

let wsUrl = null;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  try {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    if (j.webSocketDebuggerUrl) {
      wsUrl = j.webSocketDebuggerUrl;
      break;
    }
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
await send('Emulation.setDeviceMetricsOverride', {
  width: 1500,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});

async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) {
    fs.writeFileSync(name, Buffer.from(s.result.data, 'base64'));
    console.log('已保存', name, fs.statSync(name).size, '字节');
  } else console.log('截图失败', name);
}

async function ready() {
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if ((await evaluate('document.readyState')) === 'complete') break;
  }
  await sleep(1700);
}

await ready();

// --- 1. 筛「做过的」
await evaluate(`localStorage.setItem('lc-collapse-list','0'); localStorage.setItem('lc-collapse-desc','0'); localStorage.removeItem('lc-code-lock'); localStorage.removeItem('lc-collapse-code'); true;`);
await send('Page.navigate', { url: BASE });
await ready();

await evaluate(`
  (() => {
    const s = document.getElementById('filterSel');
    s.value = 'done';
    s.onchange();
    return true;
  })()
`);
await sleep(1500);
await shot('test/_r9-1-filter-done.png');

// --- 2. 折叠后把手撑满（先有工作区，再收左栏+题面）
await evaluate(`document.getElementById('filterSel').value=''; document.getElementById('filterSel').onchange(); true;`);
await sleep(1200);
await evaluate(`
  (() => { const s=document.getElementById('modeSel'); s.value='all'; s.dispatchEvent(new Event('change')); return true; })()
`);
await sleep(1000);
await evaluate(`document.getElementById('drawBtn').click()`);
for (let i = 0; i < 30; i++) {
  await sleep(700);
  if (await evaluate(`!!(window.state && state.current && (state.current.files||[]).length>0)`)) break;
}
await sleep(800);
await evaluate(`
  localStorage.setItem('lc-collapse-list','1');
  localStorage.setItem('lc-collapse-desc','1');
  applyCollapse();
  true;
`);
await sleep(900);
await shot('test/_r9-2-handles-fullheight.png');

// --- 3. 只收左栏（把手与题面并排等高）
await evaluate(`
  localStorage.setItem('lc-collapse-list','1');
  localStorage.setItem('lc-collapse-desc','0');
  applyCollapse();
  true;
`);
await sleep(700);
await shot('test/_r9-3-handle-vs-desc.png');

chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}
