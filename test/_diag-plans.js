/*
 * 诊断：「全部计划」为什么渲染不出来。
 * 直接打开弹窗，看 state.plans 有没有值、allPlansList 里那个唯一子元素是什么。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9338;
const profile = path.join(os.tmpdir(), 'lc-diag-' + Date.now());
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
const consoleMsgs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.consoleAPICalled') {
    consoleMsgs.push(m.params.type + ': ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleMsgs.push('EXC: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  }
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

for (let i = 0; i < 40; i++) {
  await sleep(250);
  if ((await evaluate('document.readyState')) === 'complete') break;
}
await sleep(1500);

// 打开弹窗
await evaluate(`document.getElementById('plansBtn').click()`);
await sleep(3500);

const diag = await evaluate(`
  (() => {
    const box = document.getElementById('allPlansList');
    const child = box.children[0];
    return {
      plansBtnText: document.getElementById('plansBtn').textContent,
      modalHidden: document.getElementById('plansModal').hidden,
      plansStatus: document.getElementById('plansStatus')?.textContent,
      myPlansHtml: document.getElementById('myPlansList')?.innerHTML.slice(0,200),
      boxInnerHtml: box.innerHTML.slice(0, 400),
      boxChildCount: box.children.length,
      childClass: child?.className,
      childText: child?.textContent.slice(0, 200),
      statePlansType: typeof window.state?.plans,
      statePlansKeys: window.state?.plans ? Object.keys(window.state.plans) : null,
      statePlansCount: window.state?.plans?.plans?.length ?? null,
      statePlansErr: window.state?.plans?.allError ?? null,
    };
  })()
`);

console.log('=== 诊断：「全部计划」渲染 ===');
console.log(JSON.stringify(diag, null, 1));
console.log('');
console.log('控制台消息:');
for (const m of consoleMsgs.slice(0, 20)) console.log('  ', m.slice(0, 200));

chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}
