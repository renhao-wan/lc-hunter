/*
 * 核实「ACM 模式是否存在」的界面层证据：
 *   1. 打开 two-sum，看代码区文件页签里有没有 Main.java / LeetCodeIO.java
 *   2. 切到 Main.java，看 ACM 入口模板的真实内容
 *   3. 顶栏 meta 行的「ACM L1/L2/L3」标记
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9347;
const profile = path.join(os.tmpdir(), 'lc-shots-acm-' + Date.now());
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
await evaluate(
  `localStorage.setItem('lc-collapse-list','0'); localStorage.setItem('lc-collapse-desc','0'); localStorage.removeItem('lc-code-lock'); localStorage.removeItem('lc-collapse-code'); true;`,
);
await send('Page.navigate', { url: BASE });
await ready();

// 打开 two-sum
await evaluate(`openProblem('two-sum', null)`);
for (let i = 0; i < 30; i++) {
  await sleep(500);
  if (await evaluate(`!!(window.state && state.current && state.current.slug === 'two-sum')`)) break;
}
await sleep(1500);

const tabs = await evaluate(`Array.from(document.querySelectorAll('#fileTabs .tab')).map(e=>e.textContent)`);
const meta = await evaluate(`document.getElementById('problemMeta').textContent`);
console.log('文件页签:', JSON.stringify(tabs));
console.log('meta 行:', meta);
await shot('test/_acm-1-tabs.png');

// 切到 Main.java
await evaluate(`openFile('Main.java')`);
await sleep(1200);
await shot('test/_acm-2-main.png');

// 切到 LeetCodeIO.java
await evaluate(`openFile('LeetCodeIO.java')`);
await sleep(1200);
await shot('test/_acm-3-io.png');

chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}
