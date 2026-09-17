/*
 * 给本轮三处改动各截一张图：
 *   1. 没工作区时（代码区收起，左栏+题面占满）
 *   2. 抽到题、有工作区时（代码区展开）
 *   3. 计划弹窗（两节都能折叠）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9340;
const profile = path.join(os.tmpdir(), 'lc-shots-r8-' + Date.now());
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
  } else {
    console.log('截图失败', name);
  }
}

for (let i = 0; i < 40; i++) {
  await sleep(250);
  if ((await evaluate('document.readyState')) === 'complete') break;
}
await sleep(1500);

// 清干净状态：没工作区、没折叠
await evaluate(`
  localStorage.removeItem('lc-collapse-code');
  localStorage.removeItem('lc-code-lock');
  localStorage.removeItem('lc-collapse-list');
  localStorage.removeItem('lc-collapse-desc');
  localStorage.removeItem('lc-hide-allplans');
  localStorage.removeItem('lc-hide-myplans');
  true;
`);
await send('Page.navigate', { url: BASE });
for (let i = 0; i < 40; i++) {
  await sleep(250);
  if ((await evaluate('document.readyState')) === 'complete') break;
}
await sleep(1800);

// 1. 没工作区的初始状态
await evaluate(`if (window.state) { state.current = null; showDesc(); } applyCollapse(); true;`);
await sleep(500);
await shot('test/_r8-1-no-workspace.png');

// 2. 抽一道题（会有工作区）
await evaluate(`document.getElementById('modeSel').value='all'; document.getElementById('planSel').value='top-interview-150'; document.getElementById('planSel').dispatchEvent(new Event('change')); true;`);
await sleep(1500);
await evaluate(`document.getElementById('drawBtn').click()`);
await sleep(4000);
await shot('test/_r8-2-with-workspace.png');

// 3. 计划弹窗
await evaluate(`document.getElementById('plansBtn').click()`);
for (let i = 0; i < 30; i++) {
  await sleep(700);
  const done = await evaluate(`document.querySelectorAll('#allPlansList .plan-card').length > 0`);
  if (done) break;
}
await sleep(700);
await shot('test/_r8-3-plans-modal.png');

chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}
