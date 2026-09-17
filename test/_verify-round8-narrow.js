/*
 * 专门验：窄屏（≤1100px）下代码区收起。
 *
 * 窄屏里代码区占的是第二行（不是第三列），所以校验点不同：
 *   - grid-template-rows 从 [11fr 9fr] 变成 [1fr 40px]
 *   - 把手要横排（写死 vertical-rl 会很难看）
 *   - 把手跨整行
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.LC_BASE || 'http://127.0.0.1:7788';
const PORT = 9339;
const profile = path.join(os.tmpdir(), 'lc-verify-narrow-' + Date.now());
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

const results = [];

for (const [w, h, label] of [
  [1024, 700, 'md'],
  [900, 640, 'sm'],
]) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: BASE });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if ((await evaluate('document.readyState')) === 'complete') break;
  }
  await sleep(1300);

  // 强制收起代码区
  await evaluate(`
    localStorage.setItem('lc-collapse-code','1');
    localStorage.setItem('lc-code-lock','1');
    if (document.getElementById('reopenCode')) document.getElementById('reopenCode').remove();
    applyCollapse();
    true;
  `);
  await sleep(500);

  const st = await evaluate(`
    (() => {
      const main = document.getElementById('mainArea');
      const r = document.getElementById('reopenCode');
      const rect = r ? r.getBoundingClientRect() : null;
      const code = document.getElementById('codePanel');
      return {
        rows: getComputedStyle(main).gridTemplateRows.split(' ').map(x => Math.round(parseFloat(x))),
        cols: getComputedStyle(main).gridTemplateColumns.split(' ').map(x => Math.round(parseFloat(x))),
        codeDisplay: code ? getComputedStyle(code).display : 'n/a',
        handleHidden: r ? r.hidden : null,
        handleW: rect ? Math.round(rect.width) : 0,
        handleH: rect ? Math.round(rect.height) : 0,
        handleWriting: r ? getComputedStyle(r).writingMode : null,
        handleInView: rect ? rect.top >= 0 && rect.bottom <= innerHeight : null,
        handleText: r ? r.textContent.trim() : null,
      };
    })()
  `);
  results.push({ label, size: `${w}x${h}`, ...st });
  await sleep(200);
}

const errs = await evaluate('window.__errs || []');

chrome.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}

console.log('=== 窄屏代码区收起验收 ===');
console.log('');
for (const r of results) {
  console.log(`${r.label} ${r.size}`);
  console.log(`   rows=${JSON.stringify(r.rows)}  cols=${JSON.stringify(r.cols)}`);
  console.log(`   代码面板 display=${r.codeDisplay}  把手 hidden=${r.handleHidden}`);
  console.log(`   把手 ${r.handleW}x${r.handleH}  writing=${r.handleWriting}  inView=${r.handleInView}  文案=${JSON.stringify(r.handleText)}`);
}
console.log('');

const checks = [];
for (const r of results) {
  checks.push([`${r.label} 第二行收成 40px`, r.rows[1] === 40]);
  checks.push([`${r.label} 代码面板不渲染`, r.codeDisplay === 'none']);
  checks.push([`${r.label} 把手可见`, r.handleHidden === false]);
  checks.push([`${r.label} 把手横排（不是竖排）`, r.handleWriting === 'horizontal-tb']);
  checks.push([`${r.label} 把手在视口内`, r.handleInView === true]);
}
checks.push(['无 JS 报错', errs.length === 0]);

for (const [name, pass] of checks) console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
if (errs.length) console.log('  JS 错误:', errs);
const allPass = checks.every(([, p]) => p);
console.log('');
console.log(allPass ? '结论: 窄屏收起行为正确。' : '结论: 有未通过项。');
process.exit(allPass ? 0 : 1);
