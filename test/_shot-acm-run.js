/*
 * ACM 模式的端到端证据：在界面里打开 two-sum -> 切到 Main.java -> 点「运行」-> 截图看用例结果。
 * 证明的不是"文件存在"，而是"生成出来的 Main.java 真的能编译并跑过真实用例"。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9351;
const profile = path.join(os.tmpdir(), 'lc-shots-acmrun-' + Date.now());
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

await evaluate(`openProblem('two-sum', null)`);
for (let i = 0; i < 30; i++) {
  await sleep(500);
  if (await evaluate(`!!(window.state && state.current && state.current.slug === 'two-sum')`)) break;
}
await sleep(1200);

// 切到 ACM 入口文件再运行 —— 跑的就是 Main.java 那条链路
await evaluate(`openFile('Main.java')`);
await sleep(1000);
await shot('test/_acm-4-before-run.png');

await evaluate(`doRun()`);
// 编译 + 跑 3 组用例，轮询等结果，别用固定 sleep
let done = false;
for (let i = 0; i < 60; i++) {
  await sleep(700);
  const txt = await evaluate(`document.getElementById('runStatus').textContent`);
  if (txt && txt !== '还没运行' && !/运行中/.test(txt)) {
    done = true;
    break;
  }
}
await sleep(700);
console.log('运行状态:', await evaluate(`document.getElementById('runStatus').textContent`));
console.log('结果区   :', (await evaluate(`document.getElementById('runResult').innerText`)).slice(0, 220));
console.log('轮询到结束:', done);
await shot('test/_acm-5-run-result.png');

chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}
